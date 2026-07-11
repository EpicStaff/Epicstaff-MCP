"""Declarative flow-spec models for the validate-then-materialize flow compiler.

A `FlowSpec` describes an entire flow in one document: start variables, nodes,
edges, and CDT routing — all referenced by node NAME. The compiler
(`epicstaff_mcp.flow_compiler`) resolves names to `temp_id`s, assembles the
bulk-save graph, validates it locally with `_validate_graph`, and only then
materializes it in a single atomic POST.

Design rules encoded here:
- Node names are the author's stable references; ids/temp_ids never appear in
  a spec. Edges and CDT routes point at names (`__start__` / `__end__` for the
  synthesized start and end nodes).
- The start and end nodes are NOT authored as nodes — `variables` and
  `output_map` at the top level define them, so a spec can never forget them.
- `extra="forbid"` everywhere: a misspelled field fails loudly at parse time
  instead of silently dropping config.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Reserved names the compiler assigns to the synthesized start/end nodes.
# Authors reference them in edges/routes; they cannot be used as node names.
START_NODE_NAME = "__start__"
END_NODE_NAME = "__end_node__"
# Author-friendly alias for END_NODE_NAME, accepted anywhere a name is referenced.
END_NODE_ALIAS = "__end__"

RESERVED_NODE_NAMES = frozenset({START_NODE_NAME, END_NODE_NAME, END_NODE_ALIAS})


class _SpecModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CodeBlockSpec(_SpecModel):
    """A sandbox-executable python code object (mirrors the API `python_code` shape)."""

    code: str = Field(
        description="Python source. Must define a top-level `def <entrypoint>(...)`."
    )
    entrypoint: str = Field(
        default="main", description="Function the sandbox calls. Default 'main'."
    )
    libraries: list[str] = Field(
        default_factory=list,
        description="pip package names for every non-stdlib import in `code`.",
    )

    def as_python_code(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "entrypoint": self.entrypoint,
            "libraries": self.libraries,
        }


class _BaseNodeSpec(_SpecModel):
    name: str = Field(
        min_length=1,
        description=(
            "Unique node name within the flow — the reference edges and CDT "
            "routes use. '__start__' and '__end__' are reserved."
        ),
    )


class _IoNodeSpec(_BaseNodeSpec):
    input_map: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "kwarg name -> 'variables.<path>' the node reads. Every path must "
            "be declared in start `variables` or written by an upstream "
            "node's output_variable_path."
        ),
    )
    output_variable_path: str | None = Field(
        default=None,
        description=(
            "'variables.<domain>[.<sub>]' path this node's return value is "
            "written to. One writer per path."
        ),
    )


class PythonNodeSpec(_IoNodeSpec):
    """Deterministic python step executed in the sandbox."""

    type: Literal["python"]
    code: str = Field(
        description=(
            "Python source defining `def <entrypoint>(<kwargs matching "
            "input_map keys>)` that returns a dict."
        )
    )
    entrypoint: str = Field(default="main")
    libraries: list[str] = Field(
        default_factory=list,
        description="pip package names for every non-stdlib import in `code`.",
    )
    use_storage: bool = Field(
        default=False,
        description=(
            "Grant this node an `EpicStaffStorage` handle (import "
            "`from epicstaff_storage.storage import EpicStaffStorage`). To persist "
            "across sessions, pair it with `FlowSpec.storage_paths` (or a later "
            "`attach_storage_to_flow`) — without an attached durable folder, writes "
            "are confined to the ephemeral per-session folder and vanish."
        ),
    )


class CodeAgentNodeSpec(_IoNodeSpec):
    """DEPRECATED — LLM agent node (single-agent reasoning over the mapped inputs).

    Slated for removal. Prefer an `agent` node (AgentNodeSpec — single agent with
    ordered inline tasks) or a `task` node (TaskNodeSpec) on the standalone agent
    microservice. Still compiles/runs, but create_flow_from_spec emits a
    `deprecated_node_type` warning.
    """

    type: Literal["code_agent"]
    system_prompt: str
    llm_config_id: int | None = Field(
        default=None, description="Existing LLMConfig id the agent runs on."
    )
    agent_mode: Literal["build", "plan"] = "build"
    stream_handler_code: str = Field(default="")
    libraries: list[str] = Field(default_factory=list)
    output_schema: dict[str, Any] = Field(
        default_factory=dict,
        description="Optional JSON Schema the agent output must conform to.",
    )


class CrewNodeSpec(_IoNodeSpec):
    """DEPRECATED — runs an existing CrewAI crew (multi-agent project).

    Slated for removal. Prefer an `agent` node (AgentNodeSpec — one agent with ordered
    inline tasks) on the standalone agent microservice, which replaces crew. Still
    compiles/runs, but create_flow_from_spec emits a `deprecated_node_type` warning.
    """

    type: Literal["crew"]
    crew_id: int = Field(description="Existing Crew id. Create the crew first.")


class SubgraphNodeSpec(_IoNodeSpec):
    """Runs another existing flow as a sub-workflow."""

    type: Literal["subgraph"]
    subgraph_id: int = Field(description="Existing flow (graph) id to run.")


class FileExtractorNodeSpec(_IoNodeSpec):
    """Extracts text from an uploaded document."""

    type: Literal["file_extractor"]


class AudioTranscriptionNodeSpec(_IoNodeSpec):
    """Transcribes an audio input."""

    type: Literal["audio_transcription"]


class TaskNodeSpec(_IoNodeSpec):
    """Single task run by one AgentDefinition on the standalone agent service."""

    type: Literal["task"]
    agent_definition_id: int = Field(
        description="Existing AgentDefinition id that executes this task."
    )
    instructions: str = Field(default="", description="Prompt text for the agent.")
    output_schema: dict[str, Any] = Field(default_factory=dict)
    remember_output: bool = Field(
        default=False,
        description=(
            "If true, the output is injected as context into subsequently "
            "executed task nodes in the same session."
        ),
    )
    surface_ids: list[int] = Field(
        default_factory=list,
        description="Existing Surface ids (tool/knowledge/storage bundles) to attach.",
    )


class AgentNodeTaskSpec(_SpecModel):
    """Ordered sub-task inside an AgentNode. Executes in list order."""

    name: str = Field(min_length=1, description="Unique within the agent node.")
    instructions: str = Field(default="")
    output_schema: dict[str, Any] = Field(default_factory=dict)
    context_task_names: list[str] = Field(
        default_factory=list,
        description=(
            "Names of EARLIER sub-tasks in this same agent node whose output "
            "is injected as context for this one."
        ),
    )


class AgentNodeSpec(_IoNodeSpec):
    """One AgentDefinition executing an ordered list of sub-tasks (no crew)."""

    type: Literal["agent"]
    agent_definition_id: int = Field(
        description="Existing AgentDefinition id that executes the sub-tasks."
    )
    tasks: list[AgentNodeTaskSpec] = Field(
        min_length=1, description="Sub-tasks, executed in list order."
    )
    surface_ids: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_task_names(self) -> AgentNodeSpec:
        seen: set[str] = set()
        for task in self.tasks:
            if task.name in seen:
                raise ValueError(f"duplicate sub-task name '{task.name}'")
            seen.add(task.name)
        return self


class CdtRouteSpec(_SpecModel):
    """One condition group of a CDT node. First matching group (in list order) wins."""

    group_name: str = Field(min_length=1)
    next_node: str = Field(
        description="NAME of the node this group routes to ('__end__' allowed)."
    )
    expression: str | None = Field(
        default=None,
        description=(
            "Deterministic python boolean over `variables`, which is exposed as "
            "an attribute object (SimpleNamespace) — use DOT notation, e.g. "
            "\"variables.weather.raw.temp >= 20\". Subscripting `variables` "
            "(variables['weather']) raises 'SimpleNamespace is not subscriptable' "
            "at runtime and dead-ends the branch. No LLM call."
        ),
    )
    route_code: str | None = Field(
        default=None,
        description=(
            "Unique per-group connector code the flow editor uses to draw the "
            "branch line. Optional — the compiler defaults it to the group_name. "
            "A null route_code routes at runtime but renders no connector in the UI."
        ),
    )
    prompt_id: str | None = Field(
        default=None,
        description=(
            "prompt_key of a prompt_configs entry — routes on the LLM "
            "classification result instead of an expression."
        ),
    )
    manipulation: str | None = Field(
        default=None,
        description="Optional python statement that tweaks `variables` before routing.",
    )

    @model_validator(mode="after")
    def _require_condition(self) -> CdtRouteSpec:
        if self.expression is None and self.prompt_id is None:
            raise ValueError(
                f"route '{self.group_name}': set `expression` (deterministic) "
                "or `prompt_id` (LLM classification) — a group with neither "
                "can never match"
            )
        return self


class CdtNodeSpec(_BaseNodeSpec):
    """Classification decision table — metadata-based router (no outgoing edges).

    Routing is by node NAME here; the compiler wires it via temp_ids in the
    bulk save. Incoming edges point AT the CDT; never author edges FROM it.
    """

    type: Literal["cdt"]
    routes: list[CdtRouteSpec] = Field(min_length=1)
    default_next_node: str | None = Field(
        default=None, description="NAME of the fallback target when no group matches."
    )
    error_next_node: str | None = Field(
        default=None, description="NAME of the target when evaluation errors."
    )
    default_llm_config_id: int | None = None
    prompt_configs: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "LLM classification prompts: {prompt_key, prompt_text, llm_config, "
            "output_schema, result_variable, variable_mappings}. Only needed "
            "when a route uses prompt_id."
        ),
    )
    pre_code: CodeBlockSpec | None = Field(
        default=None, description="Optional python step run before routing."
    )
    pre_input_map: dict[str, str] = Field(default_factory=dict)
    pre_output_variable_path: str | None = None
    post_code: CodeBlockSpec | None = Field(
        default=None, description="Optional python step run after routing."
    )
    post_input_map: dict[str, str] = Field(default_factory=dict)
    post_output_variable_path: str | None = None

    @model_validator(mode="after")
    def _validate_route_names(self) -> CdtNodeSpec:
        # group_name doubles as the default route_code (the connector code the
        # editor draws each branch from), so duplicates would collide the ports.
        seen: set[str] = set()
        for route in self.routes:
            if route.group_name in seen:
                raise ValueError(f"duplicate route group_name '{route.group_name}'")
            seen.add(route.group_name)
        # An explicit route_code must be unique too, for the same reason.
        codes = [r.route_code for r in self.routes if r.route_code is not None]
        if len(codes) != len(set(codes)):
            raise ValueError("route_code values must be unique within a CDT node")
        return self


class WebhookTriggerNodeSpec(_BaseNodeSpec):
    """HTTP webhook entrypoint. No input port — wire outgoing edges FROM it.

    The handler's returned dict merges into `variables` at the root.
    """

    type: Literal["webhook_trigger"]
    code: str = Field(
        description=(
            "Handler source defining `def <entrypoint>(trigger_payload=None)` "
            "returning a dict."
        )
    )
    entrypoint: str = Field(default="main")
    libraries: list[str] = Field(default_factory=list)
    path: str | None = Field(
        default=None,
        description=(
            "URL path segment the webhook listens on — lands in "
            "`webhook_trigger.path` (NOT `webhook_path`). e.g. 'company-assistant' "
            "makes the flow reachable at the ngrok tunnel's /company-assistant. "
            "Omit to leave unset and configure later via register_webhooks."
        ),
    )


class TelegramTriggerFieldSpec(_SpecModel):
    parent: str = Field(description="'message' or 'callback_query'.")
    field_name: str
    variable_path: str = Field(
        description="variables path the extracted field is written to."
    )


class TelegramTriggerNodeSpec(_BaseNodeSpec):
    """Telegram bot entrypoint. No input port — wire outgoing edges FROM it."""

    type: Literal["telegram_trigger"]
    telegram_bot_api_key: str | None = None
    fields: list[TelegramTriggerFieldSpec] = Field(default_factory=list)


class ScheduleIntervalSpec(_SpecModel):
    every: int | None = Field(default=None, ge=1)
    unit: Literal["seconds", "minutes", "hours", "days", "weeks", "months"] | None = (
        None
    )
    weekdays: list[str] | None = Field(
        default=None, description="Subset of ['mon'..'sun'], for weekly runs."
    )


class ScheduleEndSpec(_SpecModel):
    type: Literal["never", "on_date", "after_n_runs"]
    date_time: str | None = None
    max_runs: int | None = Field(default=None, ge=1)


class ScheduleSpec(_SpecModel):
    run_mode: Literal["once", "repeat"] | None = None
    timezone: str | None = None
    start_date_time: str | None = Field(
        default=None, description="Naive ISO datetime in `timezone`."
    )
    interval: ScheduleIntervalSpec | None = None
    end: ScheduleEndSpec | None = None


class ScheduleTriggerNodeSpec(_BaseNodeSpec):
    """Scheduled entrypoint. No input port — wire outgoing edges FROM it."""

    type: Literal["schedule_trigger"]
    is_active: bool = False
    schedule: ScheduleSpec | None = None


FlowNodeSpec = Annotated[
    PythonNodeSpec
    | CodeAgentNodeSpec
    | CrewNodeSpec
    | SubgraphNodeSpec
    | FileExtractorNodeSpec
    | AudioTranscriptionNodeSpec
    | TaskNodeSpec
    | AgentNodeSpec
    | CdtNodeSpec
    | WebhookTriggerNodeSpec
    | TelegramTriggerNodeSpec
    | ScheduleTriggerNodeSpec,
    Field(discriminator="type"),
]


class EdgeSpec(_SpecModel):
    """Unconditional edge between two nodes, referenced by NAME."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_node: str = Field(
        alias="from", description="Source node name ('__start__' or a trigger allowed)."
    )
    to_node: str = Field(
        alias="to", description="Target node name ('__end__' allowed)."
    )


class PersistentVariablesSpec(_SpecModel):
    """Cross-session state. All paths are relative to `variables`, must start
    with 'context.', and must be declared in `variables` (even as null/[])."""

    organization: list[str] = Field(
        default_factory=list,
        description="Paths shared by all users of the flow, e.g. 'context.user_prefs'.",
    )
    user: list[str] = Field(
        default_factory=list,
        description="Per-user paths, e.g. 'context.history'.",
    )


class FlowSpec(_SpecModel):
    """One-shot declarative description of an entire flow.

    The compiler synthesizes the start node from `variables` and the end node
    from `output_map` — do not author them in `nodes`. Reference them in
    `edges` as '__start__' and '__end__'.
    """

    name: str = Field(min_length=1)
    description: str | None = None
    variables: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Start-node namespace, shaped as DDD domain dicts (e.g. "
            "{'request': {...}, 'weather': {...}}). Every path any input_map "
            "reads must be declared here (even as null) unless an upstream "
            "node writes it."
        ),
    )
    output_map: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "End-node projection: response key -> 'variables.<path>'. Empty "
            "means the backend default ({'context': 'variables'})."
        ),
    )
    nodes: list[FlowNodeSpec] = Field(min_length=1)
    edges: list[EdgeSpec] = Field(default_factory=list)
    persistent_variables: PersistentVariablesSpec | None = Field(
        default=None,
        description="Optional cross-session persistence hints (see PersistentVariablesSpec).",
    )
    storage_paths: list[str] = Field(
        default_factory=list,
        description=(
            "Durable storage folder/file paths to attach to this flow "
            "(GraphStorageFile) right after it is created, so `use_storage` python "
            "nodes read/write survive across sessions. A folder path should end in "
            "'/' (it grants access to everything under it). Missing folders are "
            "created automatically. This is what makes a storage-backed flow "
            "buildable one-shot — without it, an attached folder must be added "
            "later via attach_storage_to_flow."
        ),
    )
    epicchat_enabled: bool = False
