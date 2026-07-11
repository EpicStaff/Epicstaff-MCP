"""Pure spec -> graph compiler for the validate-then-materialize flow pipeline.

`compile_flow_spec` turns a declarative `FlowSpec` (nodes and routing by NAME)
into two synchronized artifacts, with zero network I/O:

- a *validation graph*: the `/api/graphs/{id}/` response shape with synthetic
  integer ids, fed to the pure `_validate_graph` seam so every structural
  landmine is caught locally, and
- *bulk-save lists*: the `/api/graphs/{id}/save/` wire format where new nodes
  carry deterministic `temp_id` UUIDs and edges / CDT routing reference them
  via `start_temp_id` / `end_temp_id` / `next_node_temp_id`.

Both are rendered from one resolution pass over the spec, so the graph that is
validated is exactly the graph that is materialized.
"""

from __future__ import annotations

import uuid
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from epicstaff_mcp.models.flow_spec import (
    END_NODE_ALIAS,
    END_NODE_NAME,
    RESERVED_NODE_NAMES,
    START_NODE_NAME,
    AgentNodeSpec,
    AudioTranscriptionNodeSpec,
    CdtNodeSpec,
    CodeAgentNodeSpec,
    CrewNodeSpec,
    FileExtractorNodeSpec,
    FlowSpec,
    PythonNodeSpec,
    ScheduleTriggerNodeSpec,
    SubgraphNodeSpec,
    TaskNodeSpec,
    TelegramTriggerNodeSpec,
    WebhookTriggerNodeSpec,
)
from epicstaff_mcp.tools.flows import _finding, _validate_graph

# Fixed namespace so a node's temp_id is a pure function of its name —
# deterministic payloads are diffable and unit-testable.
_TEMP_ID_NAMESPACE = uuid.UUID("8f8b4a44-6f4e-4c7d-9c3a-2f1d5e9b7a10")

# Node-list keys of the bulk-save payload, in the order save_flow declares them.
_SPEC_TYPE_TO_LIST_KEY: dict[type, str] = {
    PythonNodeSpec: "python_node_list",
    CodeAgentNodeSpec: "code_agent_node_list",
    CrewNodeSpec: "crew_node_list",
    SubgraphNodeSpec: "subgraph_node_list",
    FileExtractorNodeSpec: "file_extractor_node_list",
    AudioTranscriptionNodeSpec: "audio_transcription_node_list",
    TaskNodeSpec: "task_node_list",
    AgentNodeSpec: "agent_node_list",
    CdtNodeSpec: "classification_decision_table_node_list",
    WebhookTriggerNodeSpec: "webhook_trigger_node_list",
    TelegramTriggerNodeSpec: "telegram_trigger_node_list",
    ScheduleTriggerNodeSpec: "schedule_trigger_node_list",
}

_ALL_SAVE_LIST_KEYS: tuple[str, ...] = (
    "start_node_list",
    "end_node_list",
    *_SPEC_TYPE_TO_LIST_KEY.values(),
    "edge_list",
    "conditional_edge_list",
)

_TRIGGER_SPEC_TYPES = (
    WebhookTriggerNodeSpec,
    TelegramTriggerNodeSpec,
    ScheduleTriggerNodeSpec,
)

# Canvas metadata per spec type, mirroring init_flow_metadata's styling so
# compiler-materialized flows render identically to incrementally built ones.
_NODE_STYLE: dict[type | str, tuple[str, str]] = {
    "start": ("#22c55e", "play"),
    "end": ("#ef4444", "stop"),
    PythonNodeSpec: ("#3d4251", "code"),
    CrewNodeSpec: ("#8b5cf6", "users"),
    CdtNodeSpec: ("#f59e0b", "split"),
    WebhookTriggerNodeSpec: ("#06b6d4", "webhook"),
    TelegramTriggerNodeSpec: ("#06b6d4", "webhook"),
    ScheduleTriggerNodeSpec: ("#06b6d4", "webhook"),
    CodeAgentNodeSpec: ("#3b82f6", "bot"),
    AgentNodeSpec: ("#3b82f6", "bot"),
    TaskNodeSpec: ("#3b82f6", "bot"),
}
_DEFAULT_STYLE = ("#3d4251", "node")

_LAYOUT_X_STEP = 400
_LAYOUT_Y_STEP = 200


@dataclass(frozen=True)
class _NodeHandle:
    """One resolved node: the author's name bound to both id spaces."""

    name: str
    node_id: int  # synthetic integer id for the local validation graph
    temp_id: str  # deterministic UUID for the bulk-save wire format
    spec: Any  # the node's spec model; None for the synthesized start/end


@dataclass
class CompiledFlow:
    """Result of compiling a FlowSpec. Pure data — no network I/O happened."""

    spec: FlowSpec
    findings: list[dict[str, Any]]
    node_temp_ids: dict[str, str]
    validation_graph: dict[str, Any] | None
    save_lists: dict[str, list[dict[str, Any]]] | None

    @property
    def ok(self) -> bool:
        return not any(f["severity"] == "error" for f in self.findings)

    def save_flow_lists(self, flow_id: int) -> dict[str, list[dict[str, Any]]]:
        """Bulk-save node/edge lists with `graph` stamped onto every entry."""
        if self.save_lists is None:
            raise ValueError(
                "Flow did not compile cleanly — there is no save payload. "
                "Check `findings` for the errors."
            )
        stamped = deepcopy(self.save_lists)
        for entries in stamped.values():
            for entry in entries:
                entry["graph"] = flow_id
        return stamped


def compile_flow_spec(spec: FlowSpec) -> CompiledFlow:
    """Compile a FlowSpec: resolve names, assemble, and validate locally.

    Never performs I/O. Returns a CompiledFlow whose `findings` combine
    compile-stage errors (duplicate/reserved/unknown names, persistence-rule
    violations) with the full `_validate_graph` structural findings. When any
    name fails to resolve, assembly is skipped (`validation_graph` and
    `save_lists` are None) because a graph with dangling references cannot be
    meaningfully assembled.
    """
    findings: list[dict[str, Any]] = []

    handles = _build_handles(spec, findings)
    _check_references(spec, handles, findings)
    _check_persistent_variables(spec, findings)

    if any(f["severity"] == "error" for f in findings):
        return CompiledFlow(
            spec=spec,
            findings=findings,
            node_temp_ids={name: handle.temp_id for name, handle in handles.items()},
            validation_graph=None,
            save_lists=None,
        )

    positions = _layout_positions(spec, handles)
    validation_graph = _render_graph(
        spec, handles, positions, resolver=_IntIdResolver(handles)
    )
    save_lists = _render_graph(
        spec, handles, positions, resolver=_TempIdResolver(handles)
    )
    # The validation graph additionally needs a graph-level shape.
    validation_graph = {"id": 0, "name": spec.name, **validation_graph}

    findings.extend(_validate_graph(validation_graph))

    return CompiledFlow(
        spec=spec,
        findings=findings,
        node_temp_ids={name: handle.temp_id for name, handle in handles.items()},
        validation_graph=validation_graph,
        save_lists=save_lists,
    )


# ---------------------------------------------------------------------------
# Name resolution
# ---------------------------------------------------------------------------


def _canonical_name(name: str) -> str:
    return END_NODE_NAME if name == END_NODE_ALIAS else name


def _build_handles(
    spec: FlowSpec, findings: list[dict[str, Any]]
) -> dict[str, _NodeHandle]:
    handles: dict[str, _NodeHandle] = {
        START_NODE_NAME: _NodeHandle(
            START_NODE_NAME,
            1,
            str(uuid.uuid5(_TEMP_ID_NAMESPACE, START_NODE_NAME)),
            None,
        ),
        END_NODE_NAME: _NodeHandle(
            END_NODE_NAME, 2, str(uuid.uuid5(_TEMP_ID_NAMESPACE, END_NODE_NAME)), None
        ),
    }
    next_id = 3
    for node in spec.nodes:
        if node.name in RESERVED_NODE_NAMES:
            findings.append(
                _finding(
                    "error",
                    "reserved_node_name",
                    f"Node name '{node.name}' is reserved for the synthesized "
                    "start/end nodes.",
                    "Rename the node; reference the start/end nodes in edges as "
                    "'__start__' / '__end__' instead of authoring them.",
                    node=node.name,
                )
            )
            continue
        if node.name in handles:
            findings.append(
                _finding(
                    "error",
                    "duplicate_node_name",
                    f"Node name '{node.name}' is used more than once.",
                    "Node names are the spec's references — give every node a "
                    "unique name.",
                    node=node.name,
                )
            )
            continue
        handles[node.name] = _NodeHandle(
            node.name,
            next_id,
            str(uuid.uuid5(_TEMP_ID_NAMESPACE, node.name)),
            node,
        )
        next_id += 1
    return handles


def _check_references(
    spec: FlowSpec,
    handles: dict[str, _NodeHandle],
    findings: list[dict[str, Any]],
) -> None:
    def check(referrer: str, label: str, name: str | None) -> None:
        if name is None:
            return
        if _canonical_name(name) not in handles:
            findings.append(
                _finding(
                    "error",
                    "unknown_node_reference",
                    f"'{referrer}' references {label} '{name}', which is not a "
                    "node in this spec.",
                    "Point it at an existing node's `name` ('__start__' / "
                    "'__end__' for the synthesized nodes).",
                    node=referrer,
                )
            )

    for index, edge in enumerate(spec.edges):
        referrer = f"edges[{index}]"
        check(referrer, "from", edge.from_node)
        check(referrer, "to", edge.to_node)

    for node in spec.nodes:
        if isinstance(node, CdtNodeSpec):
            for route in node.routes:
                check(
                    node.name, f"route '{route.group_name}' next_node", route.next_node
                )
            check(node.name, "default_next_node", node.default_next_node)
            check(node.name, "error_next_node", node.error_next_node)
        elif isinstance(node, AgentNodeSpec):
            for position, task in enumerate(node.tasks):
                earlier = {t.name for t in node.tasks[:position]}
                for context_name in task.context_task_names:
                    if context_name not in earlier:
                        findings.append(
                            _finding(
                                "error",
                                "invalid_context_task",
                                f"Agent node '{node.name}' task '{task.name}' "
                                f"lists context task '{context_name}', which is "
                                "not an EARLIER task in the same node.",
                                "Context tasks must appear before the task that "
                                "consumes them — reorder the `tasks` list or fix "
                                "the name.",
                                node=node.name,
                            )
                        )


def _check_persistent_variables(spec: FlowSpec, findings: list[dict[str, Any]]) -> None:
    persistence = spec.persistent_variables
    if persistence is None:
        return

    scoped = [("organization", persistence.organization), ("user", persistence.user)]
    seen: dict[str, str] = {}
    for scope, paths in scoped:
        for path in paths:
            if path in seen and seen[path] != scope:
                findings.append(
                    _finding(
                        "error",
                        "persistent_path_duplicate",
                        f"Persistent path '{path}' appears in both organization "
                        "and user scopes.",
                        "A path may persist in exactly one scope — remove it "
                        "from one of the two lists.",
                    )
                )
                continue
            seen[path] = scope

            segments = path.split(".")
            if segments[0] != "context":
                findings.append(
                    _finding(
                        "error",
                        "persistent_path_outside_context",
                        f"Persistent path '{path}' ({scope}) is not under 'context.'.",
                        "The platform only persists paths under "
                        "`variables.context` — move the state there.",
                    )
                )
                continue
            if any(segment.isdigit() for segment in segments):
                findings.append(
                    _finding(
                        "error",
                        "persistent_path_array_index",
                        f"Persistent path '{path}' ({scope}) navigates an array index.",
                        "Persistent paths may only navigate object properties.",
                    )
                )
                continue
            if not _path_declared(spec.variables, segments):
                findings.append(
                    _finding(
                        "error",
                        "persistent_path_undeclared",
                        f"Persistent path '{path}' ({scope}) is not declared in "
                        "`variables`.",
                        "Declare the full path in `variables` (even as null or "
                        "[]) — the persistence merge overwrites, it does not "
                        "create keys.",
                    )
                )


def _path_declared(variables: dict[str, Any], segments: list[str]) -> bool:
    current: Any = variables
    for segment in segments:
        if not isinstance(current, dict) or segment not in current:
            return False
        current = current[segment]
    return True


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def _layout_positions(
    spec: FlowSpec, handles: dict[str, _NodeHandle]
) -> dict[str, dict[str, int]]:
    """BFS column layout from the entrypoints, matching init_flow_metadata."""
    adjacency: dict[str, list[str]] = {}

    def link(source: str, target: str | None) -> None:
        if target is None:
            return
        adjacency.setdefault(_canonical_name(source), []).append(
            _canonical_name(target)
        )

    for edge in spec.edges:
        link(edge.from_node, edge.to_node)
    for node in spec.nodes:
        if isinstance(node, CdtNodeSpec):
            for route in node.routes:
                link(node.name, route.next_node)
            link(node.name, node.default_next_node)
            link(node.name, node.error_next_node)

    entrypoints = [START_NODE_NAME] + [
        node.name for node in spec.nodes if isinstance(node, _TRIGGER_SPEC_TYPES)
    ]

    positions: dict[str, dict[str, int]] = {}
    depth_counts: dict[int, int] = {}
    visited: set[str] = set(entrypoints)
    queue: list[tuple[str, int]] = [(name, 0) for name in entrypoints]
    while queue:
        current, depth = queue.pop(0)
        slot = depth_counts.get(depth, 0)
        depth_counts[depth] = slot + 1
        positions[current] = {"x": depth * _LAYOUT_X_STEP, "y": slot * _LAYOUT_Y_STEP}
        for neighbor in adjacency.get(current, []):
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append((neighbor, depth + 1))

    stray_column = max(depth_counts, default=0) + 1
    stray_slot = 0
    for name in handles:
        if name not in positions:
            positions[name] = {
                "x": stray_column * _LAYOUT_X_STEP,
                "y": stray_slot * _LAYOUT_Y_STEP,
            }
            stray_slot += 1
    return positions


def _metadata_for(style_key: type | str, position: dict[str, int]) -> dict[str, Any]:
    color, icon = _NODE_STYLE.get(style_key, _DEFAULT_STYLE)
    return {
        "position": position,
        "color": color,
        "icon": icon,
        "size": {"width": 180, "height": 50},
        "parentId": None,
    }


# ---------------------------------------------------------------------------
# Rendering — one field-builder pass, two id spaces
# ---------------------------------------------------------------------------


class _IntIdResolver:
    """Renders references as synthetic integer ids (local validation graph)."""

    is_wire_format = False

    def __init__(self, handles: dict[str, _NodeHandle]) -> None:
        self._handles = handles

    def identity(self, handle: _NodeHandle) -> dict[str, Any]:
        return {"id": handle.node_id}

    def edge_refs(self, source: _NodeHandle, target: _NodeHandle) -> dict[str, Any]:
        return {"start_node_id": source.node_id, "end_node_id": target.node_id}

    def route_ref(self, field_prefix: str, target: str | None) -> dict[str, Any]:
        if target is None:
            return {f"{field_prefix}_id": None}
        handle = self._handles[_canonical_name(target)]
        return {f"{field_prefix}_id": handle.node_id}


class _TempIdResolver:
    """Renders references as temp_id UUIDs (bulk-save wire format)."""

    is_wire_format = True

    def __init__(self, handles: dict[str, _NodeHandle]) -> None:
        self._handles = handles

    def identity(self, handle: _NodeHandle) -> dict[str, Any]:
        return {"id": None, "temp_id": handle.temp_id}

    def edge_refs(self, source: _NodeHandle, target: _NodeHandle) -> dict[str, Any]:
        return {"start_temp_id": source.temp_id, "end_temp_id": target.temp_id}

    def route_ref(self, field_prefix: str, target: str | None) -> dict[str, Any]:
        if target is None:
            return {f"{field_prefix}_id": None}
        handle = self._handles[_canonical_name(target)]
        return {f"{field_prefix}_temp_id": handle.temp_id}


def _render_graph(
    spec: FlowSpec,
    handles: dict[str, _NodeHandle],
    positions: dict[str, dict[str, int]],
    resolver: _IntIdResolver | _TempIdResolver,
) -> dict[str, Any]:
    graph: dict[str, Any] = {key: [] for key in _ALL_SAVE_LIST_KEYS}

    start_variables: dict[str, Any] = spec.variables
    if resolver.is_wire_format and spec.persistent_variables is not None:
        # Wire format for persistence-enabled flows wraps the namespace; the
        # validation graph keeps the flat namespace `_validate_graph` checks
        # paths against (the wrapper is a storage detail, not runtime shape).
        start_variables = {
            "variables": spec.variables,
            "persistent_variables": spec.persistent_variables.model_dump(),
        }

    start = handles[START_NODE_NAME]
    graph["start_node_list"].append(
        {
            **resolver.identity(start),
            "node_name": START_NODE_NAME,
            "variables": start_variables,
            "metadata": _metadata_for("start", positions[START_NODE_NAME]),
        }
    )
    end = handles[END_NODE_NAME]
    graph["end_node_list"].append(
        {
            **resolver.identity(end),
            "node_name": END_NODE_NAME,
            "output_map": spec.output_map,
            "metadata": _metadata_for("end", positions[END_NODE_NAME]),
        }
    )

    for node in spec.nodes:
        handle = handles[node.name]
        fields = _node_fields(node, resolver)
        graph[_SPEC_TYPE_TO_LIST_KEY[type(node)]].append(
            {
                **resolver.identity(handle),
                "node_name": node.name,
                "metadata": _metadata_for(type(node), positions[node.name]),
                **fields,
            }
        )

    for edge in spec.edges:
        source = handles[_canonical_name(edge.from_node)]
        target = handles[_canonical_name(edge.to_node)]
        graph["edge_list"].append(resolver.edge_refs(source, target))

    return graph


def _node_fields(node: Any, resolver: Any) -> dict[str, Any]:
    if isinstance(node, PythonNodeSpec):
        return {
            "python_code": {
                "code": node.code,
                "entrypoint": node.entrypoint,
                "libraries": node.libraries,
            },
            "input_map": node.input_map,
            "output_variable_path": node.output_variable_path,
            "use_storage": node.use_storage,
        }
    if isinstance(node, CodeAgentNodeSpec):
        return {
            "system_prompt": node.system_prompt,
            "llm_config": node.llm_config_id,
            "agent_mode": node.agent_mode,
            "stream_handler_code": node.stream_handler_code,
            "libraries": node.libraries,
            "output_schema": node.output_schema,
            "input_map": node.input_map,
            "output_variable_path": node.output_variable_path,
        }
    if isinstance(node, CrewNodeSpec):
        return {
            "crew_id": node.crew_id,
            "input_map": node.input_map,
            "output_variable_path": node.output_variable_path,
        }
    if isinstance(node, SubgraphNodeSpec):
        return {
            "subgraph": node.subgraph_id,
            "input_map": node.input_map,
            "output_variable_path": node.output_variable_path,
        }
    if isinstance(node, (FileExtractorNodeSpec, AudioTranscriptionNodeSpec)):
        return {
            "input_map": node.input_map,
            "output_variable_path": node.output_variable_path,
        }
    if isinstance(node, TaskNodeSpec):
        return {
            "agent_definition": node.agent_definition_id,
            "instructions": node.instructions,
            "output_schema": node.output_schema,
            "remember_output": node.remember_output,
            "surface_list": node.surface_ids,
            "input_map": node.input_map,
            "output_variable_path": node.output_variable_path,
        }
    if isinstance(node, AgentNodeSpec):
        return {
            "agent_definition": node.agent_definition_id,
            "surface_list": node.surface_ids,
            "tasks": _agent_tasks(node),
            "input_map": node.input_map,
            "output_variable_path": node.output_variable_path,
        }
    if isinstance(node, CdtNodeSpec):
        return _cdt_fields(node, resolver)
    if isinstance(node, WebhookTriggerNodeSpec):
        webhook_fields: dict[str, Any] = {
            "python_code": {
                "code": node.code,
                "entrypoint": node.entrypoint,
                "libraries": node.libraries,
            },
        }
        if node.path is not None:
            # The path lives on the nested webhook_trigger object, NOT a flat
            # `webhook_path` field — sending it flat silently drops it.
            webhook_fields["webhook_trigger"] = {"path": node.path}
        return webhook_fields
    if isinstance(node, TelegramTriggerNodeSpec):
        return {
            "telegram_bot_api_key": node.telegram_bot_api_key,
            "fields": [field.model_dump() for field in node.fields],
        }
    if isinstance(node, ScheduleTriggerNodeSpec):
        fields: dict[str, Any] = {"is_active": node.is_active}
        if node.schedule is not None:
            fields["schedule"] = node.schedule.model_dump(exclude_none=True)
        return fields
    raise TypeError(f"Unsupported node spec type: {type(node).__name__}")


def _agent_tasks(node: AgentNodeSpec) -> list[dict[str, Any]]:
    task_temp_ids = {
        task.name: str(uuid.uuid5(_TEMP_ID_NAMESPACE, f"{node.name}/task/{task.name}"))
        for task in node.tasks
    }
    return [
        {
            "temp_id": task_temp_ids[task.name],
            "name": task.name,
            "order": order,
            "instructions": task.instructions,
            "output_schema": task.output_schema,
            "context_task_temp_ids": [
                task_temp_ids[context_name] for context_name in task.context_task_names
            ],
        }
        for order, task in enumerate(node.tasks)
    ]


def _cdt_fields(node: CdtNodeSpec, resolver: Any) -> dict[str, Any]:
    condition_groups = [
        {
            "group_name": route.group_name,
            "order": order,
            "expression": route.expression,
            "prompt_id": route.prompt_id,
            "manipulation": route.manipulation,
            # route_code is what the editor draws each branch connector from; a
            # null one routes at runtime but renders no line, so default it to
            # the group_name (unique per node — enforced by CdtNodeSpec).
            "route_code": route.route_code or route.group_name,
            **resolver.route_ref("next_node", route.next_node),
        }
        for order, route in enumerate(node.routes)
    ]
    fields: dict[str, Any] = {
        "condition_groups": condition_groups,
        **resolver.route_ref("default_next_node", node.default_next_node),
        **resolver.route_ref("next_error_node", node.error_next_node),
        "default_llm_config": node.default_llm_config_id,
        "prompt_configs": node.prompt_configs,
        "pre_input_map": node.pre_input_map,
        "pre_output_variable_path": node.pre_output_variable_path,
        "post_input_map": node.post_input_map,
        "post_output_variable_path": node.post_output_variable_path,
    }
    fields["pre_python_code"] = (
        node.pre_code.as_python_code() if node.pre_code else None
    )
    fields["post_python_code"] = (
        node.post_code.as_python_code() if node.post_code else None
    )
    return fields
