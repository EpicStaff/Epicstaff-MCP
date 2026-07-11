"""MCP tools for the code-first, validate-then-materialize flow compiler.

`create_flow_from_spec` takes ONE declarative spec describing an entire flow
(nodes, edges, and CDT routing referenced by node NAME), validates every known
landmine locally via the pure `_validate_graph` seam, and only materializes —
one graph-shell POST plus one atomic bulk-save POST — when the compiled graph
has zero error-severity findings. An invalid spec never touches the backend.
"""

from __future__ import annotations

import string
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from epicstaff_mcp.exceptions import EpicStaffAPIError, EpicStaffNotFoundError
from epicstaff_mcp.flow_compiler import CompiledFlow, compile_flow_spec
from epicstaff_mcp.models.flow_spec import (
    AgentNodeSpec,
    CdtNodeSpec,
    CodeAgentNodeSpec,
    CrewNodeSpec,
    FlowSpec,
    SubgraphNodeSpec,
    TaskNodeSpec,
)
from epicstaff_mcp.tools import (
    agent_definitions,
    agents,
    crews,
    flows,
    llm_configs,
    storage,
    surfaces,
    tasks,
)

# A complete, zero-finding example: start -> python -> CDT -> two branches -> end.
EXAMPLE_FLOW_SPEC: dict[str, Any] = {
    "name": "Temperature advisory",
    "description": "Fetch weather, branch on temperature, produce an advisory.",
    "variables": {
        "request": {"city": "Kyiv"},
        "weather": {},
    },
    "output_map": {
        "hot": "variables.weather.hot_advisory",
        "cold": "variables.weather.cold_advisory",
    },
    "nodes": [
        {
            "type": "python",
            "name": "Fetch Weather",
            "code": (
                'def main(city):\n    return {"temperature_c": 24, "city": city}\n'
            ),
            "input_map": {"city": "variables.request.city"},
            "output_variable_path": "variables.weather.raw",
        },
        {
            "type": "cdt",
            "name": "Temperature Router",
            "routes": [
                {
                    "group_name": "hot",
                    "expression": "variables.weather.raw.temperature_c >= 20",
                    "next_node": "Hot Advisory",
                },
                {
                    "group_name": "cold",
                    "expression": "variables.weather.raw.temperature_c < 20",
                    "next_node": "Cold Advisory",
                },
            ],
            "default_next_node": "Cold Advisory",
            "error_next_node": "__end__",
        },
        {
            "type": "python",
            "name": "Hot Advisory",
            "code": (
                "def main(raw):\n"
                "    return f\"Stay hydrated in {raw['city']}: "
                "{raw['temperature_c']}C\"\n"
            ),
            "input_map": {"raw": "variables.weather.raw"},
            "output_variable_path": "variables.weather.hot_advisory",
        },
        {
            "type": "python",
            "name": "Cold Advisory",
            "code": (
                "def main(raw):\n"
                "    return f\"Dress warmly in {raw['city']}: "
                "{raw['temperature_c']}C\"\n"
            ),
            "input_map": {"raw": "variables.weather.raw"},
            "output_variable_path": "variables.weather.cold_advisory",
        },
    ],
    "edges": [
        {"from": "__start__", "to": "Fetch Weather"},
        {"from": "Fetch Weather", "to": "Temperature Router"},
        {"from": "Hot Advisory", "to": "__end__"},
        {"from": "Cold Advisory", "to": "__end__"},
    ],
}

_SPEC_NOTES: list[str] = [
    "Reference nodes by their `name`. '__start__' and '__end__' refer to the "
    "synthesized start/end nodes — never author them in `nodes`.",
    "CDT nodes route via `routes` (by target node name) — never author edges "
    "FROM a CDT node; incoming edges point AT it.",
    "CDT route `expression`s read `variables` as an attribute object — use DOT "
    "notation (variables.route == 'x'), never subscript (variables['route']), "
    "which raises 'SimpleNamespace is not subscriptable' at runtime.",
    "Every `input_map` path must be declared in `variables` (even as null) or "
    "written upstream by an `output_variable_path`. One writer per path.",
    "Trigger nodes (webhook/telegram/schedule) have no input port — wire "
    "outgoing edges FROM them, and keep the '__start__' leg into the first "
    "real node so manual runs work.",
    "Conditional edges and plain decision tables are not supported in specs — "
    "use a CDT node for branching.",
    "A duplicate flow `name` is caught offline as a `flow_name_conflict` finding "
    "(nothing created). Pass auto_suffix=True to create_flow_from_spec to append "
    "' (2)', ' (3)', ... automatically instead.",
    "For cross-session state, set `use_storage: true` on the python nodes that "
    "read/write storage AND list the durable folder(s) in top-level "
    "`storage_paths` (e.g. ['chat_memory/']) — the build creates and attaches "
    "them so persistence works one-shot. Import "
    "`from epicstaff_storage.storage import EpicStaffStorage` (no libraries "
    "entry needed — it is sandbox-native).",
    "A webhook trigger's URL path goes in the node's `path` field (lands on the "
    "nested webhook_trigger.path, NOT a flat webhook_path).",
]


# ---------------------------------------------------------------------------
# Entity-reference pre-flight
#
# Agent / task / crew / subgraph / code-agent / CDT nodes reference platform
# entities that must already exist (an AgentDefinition, a Crew, another flow,
# an LLMConfig, a Surface). The compiler is pure and cannot know whether an id
# resolves; without this check a bad id is only caught by the backend as a
# nested validation error AFTER the graph shell is POSTed and the bulk save is
# rejected — two wasted round-trips and an error not attributed to the node.
# This runs offline-style detail GETs before anything is created and turns a
# missing id into a loud, node-attributed finding, so nothing is materialized.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _EntityReference:
    """One (node -> platform entity id) reference to verify exists."""

    node_name: str
    kind: str
    entity_id: int


# kind -> (detail fetcher, human label, listing tool to point the fix at).
_ENTITY_KIND_META: dict[
    str, tuple[Callable[[int], Awaitable[dict[str, Any]]], str, str]
] = {
    "agent_definition": (
        agent_definitions.get_agent_definition,
        "AgentDefinition",
        "list_agent_definitions",
    ),
    "crew": (crews.get_crew, "Crew", "list_crews"),
    "subgraph": (flows.get_flow, "flow (subgraph)", "list_flows"),
    "llm_config": (llm_configs.get_llm_config, "LLMConfig", "list_llm_configs"),
    "surface": (surfaces.get_surface, "Surface", "list_surfaces"),
}


def _collect_entity_references(spec: FlowSpec) -> list[_EntityReference]:
    """Every platform-entity id referenced by a node, tagged with its kind."""
    references: list[_EntityReference] = []
    for node in spec.nodes:
        if isinstance(node, (AgentNodeSpec, TaskNodeSpec)):
            references.append(
                _EntityReference(
                    node.name, "agent_definition", node.agent_definition_id
                )
            )
            references.extend(
                _EntityReference(node.name, "surface", surface_id)
                for surface_id in node.surface_ids
            )
        elif isinstance(node, CrewNodeSpec):
            references.append(_EntityReference(node.name, "crew", node.crew_id))
        elif isinstance(node, SubgraphNodeSpec):
            references.append(_EntityReference(node.name, "subgraph", node.subgraph_id))
        elif isinstance(node, CodeAgentNodeSpec):
            if node.llm_config_id is not None:
                references.append(
                    _EntityReference(node.name, "llm_config", node.llm_config_id)
                )
        elif isinstance(node, CdtNodeSpec):
            if node.default_llm_config_id is not None:
                references.append(
                    _EntityReference(
                        node.name, "llm_config", node.default_llm_config_id
                    )
                )
    return references


async def _check_entity_references(
    spec: FlowSpec,
) -> tuple[list[dict[str, Any]], dict[tuple[str, int], bool]]:
    """Verify every referenced entity id exists; return a finding per missing id.

    Each distinct (kind, id) is fetched once via its detail endpoint. A 404
    (`EpicStaffNotFoundError`) means the entity does not exist — every node that
    references it gets an error finding. Any other API error is left to
    propagate: it signals an infrastructure problem, not a spec defect, and
    materializing on that uncertainty would be worse than surfacing it.

    Returns `(findings, exists)` — the existence verdict is reused by the
    task-placeholder pre-flight so it never fetches templates for a crew that
    is already known to be missing (and double-reports it).
    """
    references = _collect_entity_references(spec)
    if not references:
        return [], {}

    # Fetch each distinct (kind, id) once; cache the existence verdict.
    exists: dict[tuple[str, int], bool] = {}
    for kind, entity_id in {(ref.kind, ref.entity_id) for ref in references}:
        fetcher = _ENTITY_KIND_META[kind][0]
        try:
            await fetcher(entity_id)
            exists[(kind, entity_id)] = True
        except EpicStaffNotFoundError:
            exists[(kind, entity_id)] = False

    findings: list[dict[str, Any]] = []
    for ref in references:
        if exists[(ref.kind, ref.entity_id)]:
            continue
        _, label, list_tool = _ENTITY_KIND_META[ref.kind]
        findings.append(
            flows._finding(
                "error",
                "unknown_entity_reference",
                f"Node '{ref.node_name}' references {label} id {ref.entity_id}, "
                "which does not exist on this instance.",
                f"Create the {label} first, or fix the id to an existing one "
                f"(list them with {list_tool}). Nothing was created.",
                node=ref.node_name,
            )
        )
    return findings, exists


# ---------------------------------------------------------------------------
# Task-placeholder pre-flight
#
# A crew/agent/task node maps `variables` into a node input dict (input_map:
# kwarg name -> variables path). At runtime that dict is the ONLY source the
# referenced entity's task/agent templates are interpolated from — the variable
# namespace itself is never passed to the interpolator. The class of runtime
# failures this closes: a template placeholder that no input_map key provides.
#
# The two node families interpolate DIFFERENTLY (verified against the crew
# service + its CrewAI fork):
#
# - CREW node -> CrewAI kickoff(inputs=<input_map dict>). Task `description`
#   (from Task.instructions) and every agent role/goal/backstory are rendered
#   with raw `str.format(**inputs)`, which RAISES
#   "Missing required template variable '<name>'" on a missing key — a hard
#   runtime crash. So those placeholders are REQUIRED -> an unprovided one is an
#   ERROR. `expected_output`/`knowledge_query` go through `interpolate_only`,
#   which leaves unknown `{tokens}` literal and never raises -> LENIENT.
#   Interpolation is skipped entirely when the input dict is empty
#   (`if not inputs: return`), so an empty input_map can never crash.
#
# - AGENT / TASK node -> `render_instructions()` uses `format_map` with a
#   __missing__ that returns the token verbatim and logs a warning. It NEVER
#   raises. So an unprovided placeholder degrades output (the LLM sees a literal
#   '{token}') but does not crash -> at most a WARNING.
#
# Conservatism: a placeholder is treated as satisfiable by an input_map key OR
# by an existing top-level flow variable of the same name (the namespace guard);
# the latter downgrades a crew ERROR to a warning because the intent is
# ambiguous. Undeterminable templates (fetch fails / odd shape / non-identifier
# tokens) are skipped silently. This runs before anything is created, so a
# mismatch materializes nothing — consistent with the other offline guards.
# ---------------------------------------------------------------------------


def _extract_format_placeholders(template: str) -> set[str]:
    """Base identifier names of every replacement field in a str.format template.

    Mirrors how `str.format` parses fields: `{name}`, `{name.attr}`, `{name[0]}`
    all resolve to the base name `name`; `{{`/`}}` are escapes and yield nothing;
    positional (`{0}`, `{}`) and non-identifier fields (e.g. stray JSON braces)
    are ignored because they can never be satisfied by an input_map key. A
    malformed template (which `.format` itself would choke on) yields the empty
    set rather than a guessed placeholder.
    """
    names: set[str] = set()
    try:
        parsed = list(string.Formatter().parse(template))
    except ValueError:
        return set()
    for _literal, field_name, _format_spec, _conversion in parsed:
        if not field_name:
            continue
        base = field_name.split(".", 1)[0].split("[", 1)[0].strip()
        if base.isidentifier():
            names.add(base)
    return names


def _variable_base_name(path: str | None) -> str | None:
    """Top-level segment of a 'variables.<base>[...]' path, or None."""
    if not path or not path.startswith("variables."):
        return None
    remainder = path[len("variables.") :]
    segment = remainder.split(".", 1)[0].split("[", 1)[0].strip()
    return segment or None


def _namespace_top_level_names(spec: FlowSpec) -> set[str]:
    """Top-level names a placeholder could plausibly bind to in the flow.

    The union of the start-variable top-level keys and the top-level base of
    every node's output_variable_path (including a CDT's pre/post writes). Used
    only to soften a crew placeholder finding from error to warning when the
    author clearly has the datum in scope but forgot to map it.
    """
    names: set[str] = set(spec.variables.keys())
    for node in spec.nodes:
        for attr in (
            "output_variable_path",
            "pre_output_variable_path",
            "post_output_variable_path",
        ):
            base = _variable_base_name(getattr(node, attr, None))
            if base:
                names.add(base)
    return names


async def _crew_interpolation_templates(
    crew_id: int,
) -> tuple[list[str], list[str]] | None:
    """Return `(strict_templates, lenient_templates)` a crew interpolates, or
    None when they can't be determined (skip the check silently).

    Strict templates crash on a missing key (raw `str.format`): task
    instructions plus each agent's role/goal/backstory. Lenient templates never
    crash (`interpolate_only`): task expected_output and knowledge_query.
    """
    try:
        page = await tasks.list_tasks(crew=crew_id, limit=200)
    except EpicStaffAPIError:
        return None
    items = page.get("results") if isinstance(page, dict) else page
    if not isinstance(items, list):
        return None

    strict: list[str] = []
    lenient: list[str] = []
    agent_ids: set[int] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        instructions = item.get("instructions")
        if isinstance(instructions, str):
            strict.append(instructions)
        for field in ("expected_output", "knowledge_query"):
            value = item.get(field)
            if isinstance(value, str):
                lenient.append(value)
        agent_id = item.get("agent")
        if isinstance(agent_id, int):
            agent_ids.add(agent_id)

    for agent_id in sorted(agent_ids):
        try:
            agent = await agents.get_agent(agent_id)
        except EpicStaffAPIError:
            continue  # agent role/goal/backstory are best-effort
        for field in ("role", "goal", "backstory"):
            value = agent.get(field)
            if isinstance(value, str):
                strict.append(value)
    return strict, lenient


async def _crew_node_placeholder_findings(
    node: CrewNodeSpec, namespace_names: set[str]
) -> list[dict[str, Any]]:
    templates = await _crew_interpolation_templates(node.crew_id)
    if templates is None:
        return []
    strict_templates, lenient_templates = templates

    required: set[str] = set()
    for template in strict_templates:
        required |= _extract_format_placeholders(template)
    optional: set[str] = set()
    for template in lenient_templates:
        optional |= _extract_format_placeholders(template)
    input_keys = set(node.input_map)

    findings: list[dict[str, Any]] = []

    # CrewAI skips interpolation entirely for an empty input dict, so an empty
    # input_map cannot crash — but the placeholders reach the LLM literally.
    if not input_keys:
        if required:
            example = sorted(required)[0]
            findings.append(
                flows._finding(
                    "warning",
                    "uninterpolated_task_placeholders",
                    f"Crew node '{node.name}' has an empty input_map, so crew "
                    f"{node.crew_id}'s task placeholder(s) {sorted(required)} are not "
                    "interpolated at runtime (CrewAI skips interpolation when inputs "
                    "are empty) and reach the LLM as literal '{token}' text.",
                    "Add input_map entries whose keys match the placeholders, e.g. "
                    f"{{'{example}': 'variables.<path>'}}.",
                    node=node.name,
                )
            )
        return findings

    for placeholder in sorted(required - input_keys):
        token = "{" + placeholder + "}"
        if placeholder in namespace_names:
            findings.append(
                flows._finding(
                    "warning",
                    "unmapped_task_placeholder",
                    f"Crew node '{node.name}' references crew {node.crew_id}, whose "
                    f"task/agent template requires placeholder '{token}'. It is not a "
                    f"key in this node's input_map, though a flow variable named "
                    f"'{placeholder}' exists.",
                    f"Map it explicitly: add '{placeholder}': 'variables.{placeholder}' "
                    "(or the correct path) to this node's input_map — CrewAI "
                    "interpolates ONLY from input_map, not from the variable namespace.",
                    node=node.name,
                )
            )
        else:
            findings.append(
                flows._finding(
                    "error",
                    "missing_task_placeholder",
                    f"Crew node '{node.name}' references crew {node.crew_id}, whose "
                    f"task/agent template requires placeholder '{token}', but this "
                    f"node's input_map has no '{placeholder}' key (keys: "
                    f"{sorted(input_keys)}). At runtime CrewAI calls "
                    f'str.format(**inputs) on the template and raises "Missing '
                    f"required template variable '{placeholder}'\", failing the crew.",
                    f"Add '{placeholder}': 'variables.<path>' to this node's input_map "
                    "(rename the wrong key if it is a typo). Nothing was created.",
                    node=node.name,
                )
            )

    used = required | optional
    for key in sorted(input_keys - used):
        findings.append(
            flows._finding(
                "warning",
                "unused_input_map_key",
                f"Crew node '{node.name}' input_map key '{key}' matches no placeholder "
                f"in crew {node.crew_id}'s task/agent templates.",
                "Likely a typo or a wrong key — rename it to a real placeholder, or "
                "remove it. (Harmless if an in-crew python tool consumes it via kwargs.)",
                node=node.name,
            )
        )
    return findings


def _agent_task_node_placeholder_findings(
    node: AgentNodeSpec | TaskNodeSpec, namespace_names: set[str]
) -> list[dict[str, Any]]:
    """Warnings for an agent/task node whose authored instructions reference a
    placeholder nothing provides. These use a safe renderer (no crash), so a
    mismatch is only ever a warning, never a materialization-blocking error.
    """
    if isinstance(node, AgentNodeSpec):
        instruction_texts = [task.instructions for task in node.tasks]
    else:
        instruction_texts = [node.instructions]

    required: set[str] = set()
    for text in instruction_texts:
        if isinstance(text, str):
            required |= _extract_format_placeholders(text)
    input_keys = set(node.input_map)

    findings: list[dict[str, Any]] = []
    for placeholder in sorted(required - input_keys - namespace_names):
        token = "{" + placeholder + "}"
        findings.append(
            flows._finding(
                "warning",
                "unsatisfied_instruction_placeholder",
                f"{node.type.capitalize()} node '{node.name}' instructions reference "
                f"placeholder '{token}', which is not in its input_map and is not a "
                "known flow variable. The agent runtime renders it verbatim (no "
                f"crash), so the LLM sees the literal '{token}'.",
                f"Add '{placeholder}': 'variables.<path>' to this node's input_map so "
                "the value is interpolated in.",
                node=node.name,
            )
        )
    for key in sorted(input_keys - required):
        token = "{" + key + "}"
        findings.append(
            flows._finding(
                "warning",
                "unused_input_map_key",
                f"{node.type.capitalize()} node '{node.name}' input_map key '{key}' is "
                "not referenced by any placeholder in its instructions.",
                f"Likely a typo or a leftover key — reference it as '{token}' in the "
                "instructions, or remove it.",
                node=node.name,
            )
        )
    return findings


async def _check_task_placeholders(
    spec: FlowSpec, entity_exists: dict[tuple[str, int], bool]
) -> list[dict[str, Any]]:
    """Cross-check every crew/agent/task node's input_map against the placeholders
    its referenced templates actually interpolate. See the section header for the
    runtime grounding and severity rules.
    """
    namespace_names = _namespace_top_level_names(spec)
    findings: list[dict[str, Any]] = []
    for node in spec.nodes:
        if isinstance(node, CrewNodeSpec):
            # A missing crew is already reported by the entity-ref pass; don't
            # fetch its (non-existent) templates or double-report it.
            if entity_exists.get(("crew", node.crew_id)) is False:
                continue
            findings.extend(
                await _crew_node_placeholder_findings(node, namespace_names)
            )
        elif isinstance(node, (AgentNodeSpec, TaskNodeSpec)):
            findings.extend(
                _agent_task_node_placeholder_findings(node, namespace_names)
            )
    return findings


# ---------------------------------------------------------------------------
# Flow-name collision pre-flight
#
# `create_flow` 400s when a graph with the same name already exists. Left to the
# backend, that surfaces only AFTER compile + entity-ref fetches as a raw
# `materialization_rejected` on the graph-shell POST — a wasted round-trip and
# an opaque error. This resolves the name offline first: a taken name is either
# a clean, actionable `flow_name_conflict` finding (nothing created), or — when
# the caller opts into `auto_suffix` — is disambiguated to "<name> (2)".
# ---------------------------------------------------------------------------


async def _existing_flow_names() -> set[str]:
    """Every current flow name on the instance (paginated to be exhaustive)."""
    names: set[str] = set()
    offset = 0
    page_size = 200
    while True:
        page = await flows.list_flows(limit=page_size, offset=offset)
        items = page.get("results", []) if isinstance(page, dict) else page
        if not items:
            break
        names.update(item["name"] for item in items if item.get("name"))
        if len(items) < page_size:
            break
        offset += page_size
    return names


async def _resolve_flow_name(
    name: str, auto_suffix: bool
) -> tuple[str | None, dict[str, Any] | None]:
    """Resolve a flow name against existing names.

    Returns `(resolved_name, conflict_finding)`:
    - name is free -> `(name, None)`
    - name is taken and `auto_suffix` -> `("<name> (N)", None)` for the lowest
      free N >= 2
    - name is taken and not `auto_suffix` -> `(None, finding)` — create nothing.
    """
    existing = await _existing_flow_names()
    if name not in existing:
        return name, None
    if not auto_suffix:
        return None, flows._finding(
            "error",
            "flow_name_conflict",
            f"A flow named '{name}' already exists on this instance — the backend "
            "rejects a duplicate graph name.",
            "Rename the flow (set a unique `name`), or call create_flow_from_spec "
            "with auto_suffix=True to append ' (2)', ' (3)', ... automatically. "
            "Nothing was created.",
        )
    candidate_number = 2
    while f"{name} ({candidate_number})" in existing:
        candidate_number += 1
    return f"{name} ({candidate_number})", None


async def _attach_storage_paths(
    flow_id: int, paths: list[str]
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Create (if needed) and attach durable storage paths to a freshly-made flow.

    Folder paths (ending in '/') are created first, tolerating a 409 (already
    exists); every path is then attached as a GraphStorageFile so `use_storage`
    nodes persist across sessions. Returns `(summary, warning_finding_or_None)`
    — a failure is reported as a warning, never a hard error, because the flow
    itself was already materialized successfully.
    """
    created: list[str] = []
    try:
        for path in paths:
            if path.endswith("/"):
                try:
                    await storage.create_storage_folder(path)
                    created.append(path)
                except EpicStaffAPIError as exc:
                    if exc.status_code != 409:
                        raise
        await storage.attach_storage_to_flow(flow_id, paths)
    except EpicStaffAPIError as exc:
        return (
            {"attached": [], "created": created, "error": exc.detail},
            flows._finding(
                "warning",
                "storage_attach_failed",
                f"The flow was created, but attaching storage paths {paths} "
                f"failed: {exc.detail}",
                "Attach them manually with attach_storage_to_flow(flow_id, paths) "
                "once the paths exist — use_storage nodes won't persist until then.",
            ),
        )
    return {"attached": paths, "created": created}, None


async def get_flow_spec_schema() -> dict[str, Any]:
    """Get the JSON Schema, authoring notes, and a complete example for the
    flow spec accepted by create_flow_from_spec.

    Call this before authoring a spec — the schema documents every node type
    and field the compiler accepts.
    """
    return {
        "schema": FlowSpec.model_json_schema(),
        "notes": _SPEC_NOTES,
        "example": EXAMPLE_FLOW_SPEC,
    }


def _deprecated_node_findings(parsed: FlowSpec) -> list[dict[str, Any]]:
    """Warning findings for any deprecated node types (code_agent / crew) in the spec.

    Advisory only (severity 'warning') — the flow still materializes; it steers new
    builds toward agentnode/tasknode.
    """
    findings: list[dict[str, Any]] = []
    for node in parsed.nodes:
        note = flows._spec_deprecation_note(getattr(node, "type", ""))
        if note:
            findings.append(
                {
                    "severity": "warning",
                    "code": "deprecated_node_type",
                    "node": getattr(node, "name", None),
                    "message": note,
                    "fix": "Replace with an 'agent' node (ordered inline tasks) or a "
                    "'task' node.",
                }
            )
    return findings


async def create_flow_from_spec(
    spec: dict[str, Any], auto_suffix: bool = False
) -> dict[str, Any]:
    """Compile a declarative flow spec, validate it locally, and materialize it
    as a new flow in ONE atomic bulk-save.

    The whole flow — start variables, nodes, edges, CDT routing — is authored
    in a single spec with nodes referenced by NAME (see get_flow_spec_schema
    for the schema and a full example). The compiler resolves names to
    temp_ids, assembles the graph, and runs the full validate_flow check suite
    offline. If any error-severity finding exists, NOTHING is created and the
    findings are returned; fix the spec and retry.

    A flow name that already exists on the instance is caught offline as a
    clean `flow_name_conflict` finding (nothing created). Pass auto_suffix=True
    to instead disambiguate a colliding name to "<name> (2)", "<name> (3)", ...
    automatically and proceed.

    If the spec declares `storage_paths`, those durable folders are created (if
    missing) and attached to the new flow so `use_storage` python nodes persist
    across sessions — making a storage-backed flow buildable in one shot.

    Returns {ok, flow_id?, name?, nodes? (name -> created id), findings,
    storage?, summary}.
    """
    try:
        parsed = FlowSpec.model_validate(spec)
    except ValidationError as exc:
        findings = [
            {
                "severity": "error",
                "code": "spec_parse_error",
                "node": None,
                "message": "{}: {}".format(
                    ".".join(str(part) for part in error["loc"]) or "<root>",
                    error["msg"],
                ),
                "fix": "Fix the field to match the spec schema — call "
                "get_flow_spec_schema() for the full schema and an example.",
            }
            for error in exc.errors()
        ]
        return _failure(findings)

    compiled = compile_flow_spec(parsed)
    if not compiled.ok:
        return _failure(compiled.findings)

    # Pre-flight: reject bad entity ids, input_map/task-placeholder mismatches,
    # and a colliding flow name offline, before the shell exists — so a missing
    # agent_definition/crew/subgraph/llm_config/surface, a crew node whose
    # input_map can't satisfy a required task placeholder (a guaranteed runtime
    # crash that validate_flow can't see), AND a duplicate name are all clean
    # findings surfaced in one pass instead of several backend rejections.
    reference_findings, entity_exists = await _check_entity_references(parsed)
    placeholder_findings = await _check_task_placeholders(parsed, entity_exists)
    resolved_name, name_conflict = await _resolve_flow_name(parsed.name, auto_suffix)
    preflight_findings = [*reference_findings, *placeholder_findings]
    preflight_findings.extend(_deprecated_node_findings(parsed))
    if name_conflict is not None:
        preflight_findings.append(name_conflict)
    if any(f["severity"] == "error" for f in preflight_findings):
        return _failure([*compiled.findings, *preflight_findings])

    shell = await flows.create_flow(
        name=resolved_name,
        description=parsed.description,
        epicchat_enabled=parsed.epicchat_enabled,
        persistent_variables=True if parsed.persistent_variables else None,
    )
    flow_id = shell["id"]

    try:
        saved = await flows.save_flow(
            flow_id=flow_id,
            save_version=shell.get("save_version"),
            sync_metadata=False,
            **compiled.save_flow_lists(flow_id),
        )
    except EpicStaffAPIError as exc:
        # The graph shell exists but the bulk save was rejected — remove the
        # empty shell so a retry starts clean, then report the rejection.
        await flows.delete_flow(flow_id)
        return _failure(
            [
                *compiled.findings,
                {
                    "severity": "error",
                    "code": "materialization_rejected",
                    "node": None,
                    "message": f"The backend rejected the bulk save: {exc.detail}",
                    "fix": "The empty flow shell was deleted. Fix the spec per "
                    "the backend error and retry.",
                },
            ]
        )

    # Errors would have short-circuited above; what remains here are advisory
    # pre-flight warnings (unused input_map key, uninterpolated placeholder,
    # namespace-satisfiable-but-unmapped) worth surfacing on the created flow.
    findings = [*compiled.findings, *preflight_findings]
    storage_summary: dict[str, Any] | None = None
    if parsed.storage_paths:
        storage_summary, storage_warning = await _attach_storage_paths(
            flow_id, parsed.storage_paths
        )
        if storage_warning is not None:
            findings.append(storage_warning)

    suffix_note = (
        f" (renamed from '{parsed.name}' to avoid a name collision)"
        if resolved_name != parsed.name
        else ""
    )
    result: dict[str, Any] = {
        "ok": True,
        "flow_id": flow_id,
        "name": resolved_name,
        "nodes": _created_node_ids(saved, compiled),
        "findings": findings,
        "summary": (
            f"Flow '{resolved_name}' created as flow {flow_id} with "
            f"{len(parsed.nodes) + 2} nodes and {len(parsed.edges)} edges"
            f"{suffix_note}."
        ),
    }
    if storage_summary is not None:
        result["storage"] = storage_summary
    return result


def _failure(findings: list[dict[str, Any]]) -> dict[str, Any]:
    error_count = sum(1 for f in findings if f["severity"] == "error")
    warning_count = len(findings) - error_count
    return {
        "ok": False,
        "findings": findings,
        "summary": (
            f"Spec rejected: {error_count} error(s), {warning_count} warning(s). "
            "No flow was created."
        ),
    }


def _created_node_ids(
    saved_graph: dict[str, Any], compiled: CompiledFlow
) -> dict[str, int]:
    """Map the spec's node names to the real DB ids the bulk save assigned."""
    spec_names = set(compiled.node_temp_ids)
    node_ids: dict[str, int] = {}
    for list_key, _ in flows.NODE_LIST_KEYS:
        for node in saved_graph.get(list_key, []):
            name = node.get("node_name")
            if name in spec_names and node.get("id") is not None:
                node_ids[name] = node["id"]
    return node_ids
