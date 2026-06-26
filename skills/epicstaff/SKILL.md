---
name: epicstaff
description: Use when working with EpicStaff flows, nodes, sessions, or MCP tools — inspecting, building, patching, or debugging. Reference for all epicstaff-mcp tool signatures, node type requirements, port connection rules, and critical operational gotchas.
---

# EpicStaff Flow Reference

All flow and session operations go through MCP tools. Never write raw HTTP calls against the Django API directly — the API has subtle requirements the MCP tools encapsulate correctly.

---

## Section 1: MCP Tool Catalog

> **Parameter naming matters.** Tools that operate on a built graph take a
> first arg named **`graph_id`** (the inspection, patching, and validation
> tools); the create/structure tools take **`flow_id`**. They're the same
> integer — but when you pass arguments by keyword, the name must match.
>
> **Tool availability.** `describe_flow`, `validate_flow_paths`, `test_flow`,
> `init_flow_metadata`, `get_flow_connections`, `get_cdt_*`, the `patch_*`
> family, `run_session_and_wait`, and the session-debug tools are registered as
> of the v2 server reconciliation. If a call fails with "unknown tool", the
> installed server build predates that fix — stop and tell the user to update.
>
> **Write tools return a semantic envelope**, not the raw API record:
> `{status, what_changed, warnings[], suggested_next[], result}`. The raw API
> object is under `result`. Always read `warnings` (a `status` of `"error"`
> means a blocker-level problem) and follow `suggested_next`.

### Flow Inspection

| Tool | Purpose |
|---|---|
| `list_flows` | List all flows |
| `get_flow(flow_id)` | Full flow with all nodes and edges (raw JSON) |
| `get_flow_nodes(flow_id, compact=False)` | All nodes organized by type. Pass `compact=True` on 40+ node flows — slim projection + `name_to_id` map (the full form can exceed the response-size limit). |
| `get_flow_connections(graph_id)` | All edges + CDT/DT routing (machine shape) |
| `describe_flow(graph_id, fmt)` | **Readable** view: nodes, reads/writes, wiring, orphans, dangling. `fmt`=`text`\|`mermaid`\|`both`. Use this to *see* what you built. |
| `validate_flow_paths(graph_id)` | Check every `input_map`/`output_map` path against declared start variables + upstream writers |

### CDT Inspection

| Tool | Purpose |
|---|---|
| `get_cdt_node(graph_id, name_or_id)` | Full CDT with pre/post code, prompts, groups |
| `get_cdt_prompts(graph_id, name_or_id)` | Just the prompts dict |
| `get_cdt_route_map(graph_id)` | Routing map for all CDT/DT nodes |

### Node Patching

| Tool | Purpose |
|---|---|
| `patch_python_node(graph_id, name_or_id, code, libraries)` | Update Python node — always pass `libraries` |
| `patch_webhook_node(graph_id, name_or_id, code, libraries)` | Update Webhook handler — always pass `libraries` |
| `patch_code_agent_node(graph_id, name_or_id, system_prompt, stream_handler_code, libraries, llm_config_id, agent_mode)` | Update Code Agent |
| `patch_cdt_node(graph_id, name_or_id, pre_computation_code, post_computation_code, prompts, condition_groups)` | Update CDT |
| `patch_dt_node(graph_id, name_or_id, condition_groups, default_next_node, next_error_node)` | Update DT groups + routing |
| `patch_node_libraries(graph_id, name_or_id, libraries)` | Update libraries only |
| `patch_node_metadata(graph_id, name_or_id, position, color)` | Update a node's visual position/color |
| `patch_start_variables(graph_id, variables)` | Set start node variables namespace — a **dict** (see note) |

> **`variables` is a nested domain dict, not a list.** Confirmed against the
> backend: `StartNode.variables` is a `JSONField(default=dict)`, and the runtime
> exposes it as a `DotDict` that nodes read via dotted `input_map` paths
> (`variables.request.city`). Pass `{"request": {"city": null}, ...}`, exactly
> the shape `flow-ddd` teaches. (The `[{name,type,default}]` list shape some docs
> showed belongs to a different model, `PythonCodeTool.variables`.)

### Flow Structure

| Tool | Purpose |
|---|---|
| `add_node(flow_id, node_type, config, node_name)` | Add a node. Node-specific fields go **inside `config`** (see below) |
| `add_edge(flow_id, start_node_id, end_node_id)` | Connect two nodes — **integer node IDs**, not names |
| `add_conditional_edge(flow_id, source_node_id, python_code, input_map)` | Add a 2-way conditional branch from a node |
| `delete_node(flow_id, node_id, node_type)` | Remove a node — needs numeric id + type |
| `delete_edge(flow_id, edge_id, conditional)` | Remove a connection (`conditional=True` for a conditional edge) |
| `init_flow_metadata(graph_id)` | **MANDATORY after any structural change** — UI position/sync (the "black dots" fix) |
| `update_flow_metadata(flow_id, name, description, epicchat_enabled)` | Rename/redescribe a flow only — NOT the sync tool above |
| `test_flow(graph_id)` | Structural check → `{ok, issues, summary}`; gate on `ok` |
| `copy_flow(flow_id)` | Duplicate a flow |
| `save_flow(flow_id, ..., allow_incomplete)` | Atomic bulk save (auto-includes the graph's current `save_version`). Gates on validation; pass `allow_incomplete=True` for a WIP save. Best for moderate flows — for 60+ nodes, build incrementally with `add_node`/`add_edge` then `init_flow_metadata` to stay under the response-size limit. |
| `export_flow(flow_id)` | Export flow as JSON |
| `import_flow(payload)` | Import flow from JSON |

> **`add_node` config shape** — fields are nested under `config`, not passed flat:
> ```
> add_node(flow_id, "pythonnode", config={
>     "python_code": {"code": "def main(city): ...", "entrypoint": "main", "libraries": []},
>     "input_map": {"city": "variables.request.city"},
>     "output_variable_path": "variables.weather",
> }, node_name="Fetch Weather")
> ```
> `add_edge`/`delete_node`/`delete_edge` take **integer node IDs**, so resolve
> names → ids via `get_flow_nodes` immediately before the call.

### Sessions

| Tool | Purpose |
|---|---|
| `list_sessions(flow_id)` | Recent sessions for a flow |
| `run_session(flow_id, variables)` | Start a session |
| `run_session_and_wait(flow_id, variables, timeout=600)` | Start and poll until done. Success = terminal status `"end"`; on real timeout returns the latest state with `"incomplete": true` (not a bare error). |
| `get_session_updates(session_id)` | Current session status |
| `stop_session(session_id)` | Stop a running session |
| `inspect_session(session_id)` | Per-node input/output — compact; the go-to for confirming what actually ran (use over raw `get_session`, which embeds the full graph schema). |
| `send_message(session_id, ...)` | Send human input to a waiting session |

### Session Debug

| Tool | Purpose |
|---|---|
| `get_session_warnings(session_id)` | Warnings emitted during execution |
| `list_session_messages(session_id)` | Message history for a session |
| `get_session_timings(session_id)` | Per-node duration breakdown |
| `get_session_trace(session_id)` | `message_history` evolution |
| `get_session_crew_input(session_id)` | Crew node inputs |
| `get_flow_persistent_vars(graph_id)` | Cross-session persistent variables for a flow |

### Crews / Agents / Tasks

| Tool | Purpose |
|---|---|
| `list_crews` / `get_crew` / `create_crew` / `update_crew` | Crew management |
| `list_agents` / `get_agent` / `create_agent` / `update_agent` | Agent management |
| `list_tasks` / `get_task` / `create_task` / `update_task` | Task management |

---

## Section 2: Critical Operational Rules

These rules encode hard-won lessons from production issues. Violating any causes silent failures or data loss.

1. **`init_flow_metadata` is MANDATORY after adding or deleting any node or edge — no exceptions.** Without it new nodes render as black dots, connections are missing, and routing breaks silently.

2. **Node IDs change on every UI save.** The frontend deletes and recreates nodes, so never *persist* a numeric DB ID across calls. The patch/inspection tools accept `name_or_id` (resolve by name). But `add_edge`, `delete_node`, and `delete_edge` require **numeric IDs** — resolve names → ids via `get_flow_nodes` immediately before each such call, never from a remembered value.

3. **`patch_python_node` and `patch_webhook_node` MUST always include `libraries`.** Omitting `libraries` wipes the existing list, causing silent import failures at runtime.

4. **CDT routing is metadata-based, NOT edge-based.** `add_edge` on a CDT output does nothing. Wire targets via `patch_dt_node(..., condition_groups=[{"group_name": ..., "next_node": "<name>", "conditions": [...]}])`. **When the routed-on value comes from a crew node, the expression must unwrap the envelope** — use `variables['x']['message']`, never `variables['x']` (the bare value is `{raw, message, token_usage}`, so a raw comparison *silently misroutes* with no error).

5. **CDT `prompts` must be a dict, not a list.** `converter_service.py` calls `.items()` — passing a list crashes the crew at runtime.

6. **Non-CDT node `ports` must be `null`, not `[]`.** The frontend auto-generates ports only when `ports === null`; an empty array suppresses port generation.

7. **Agent `tool_ids` PATCH is a destructive replace.** When calling `update_agent`, always include ALL existing tool IDs alongside any new ones — partial lists drop tools.

8. **Every CDT `condition_group` must include `"conditions": []`.** The viewset calls `pop("conditions")` — a missing key causes a silent rollback.

9. **Python nodes require a `def <entrypoint>(...)`.** The crew executor calls it with `input_map` keys as kwargs. Confirmed against the backend: `PythonCode.entrypoint` is honored (`run_python_code_service` invokes it) and **defaults to `"main"`**. So `def main(...)` works by default; set `python_code.entrypoint` if you name it otherwise. Code with no matching entrypoint fails with `name '<entrypoint>' is not defined`.

10. **`output_variable_path` for webhook trigger is always `"variables"`.** The runtime forces it — the handler's return dict merges into `variables` wholesale.

---

## Section 3: Node Types Reference

12 active node types. Do not use `llmnode` — it exists in the DB but has no UI panel and cannot be configured. Use `code-agent` for LLM-based reasoning.

| Display name | MCP `node_type` for `add_node` | Required config fields | Input port | Output port | Key gotchas |
|---|---|---|---|---|---|
| Start | `startnode` | `variables` JSON | none | `start-start` (single) | Patch via `patch_start_variables`. Must connect to at least one downstream node. |
| End | `endnode` | `output_map` JSON | `end-in` (multi) | none | Only one end node per flow. Missing vars resolve to string `"not found"`. |
| Python | `pythonnode` | `python_code.code`, `python_code.libraries`, `input_map`, `output_variable_path` | `python-in` (multi) | `python-out` (single) | Must have `def main(...)`. Always pass `libraries` when patching. |
| Code Agent | `codeagentnode` | `system_prompt`, `llm_config_id`, `agent_mode` (defaults to `"build"`), `input_map`, `output_variable_path` | `code-agent-in` (multi) | `code-agent-out` (single) | **`input_map` MUST include a `prompt` or `action` key** — that's the runtime message the agent acts on (the `system_prompt` is only the system role); without it the run fails with `requires a 'prompt' or 'action' in input_map`. `add_node` accepts `llm_config_id` (auto-mapped to the `llm_config` FK). `libraries` applies to `stream_handler_code` only. `output_schema` triggers retry on mismatch. `agent_mode` is a free `CharField(max_length=10)` defaulting to `"build"` — `"build"` is the operative value in the executor. (The `completion`/`streaming` values some docs showed are not used by the code-agent executor.) |
| Project / Crew | `crewnode` | `crew` FK, `input_map`, `output_variable_path` | `project-in` (multi) | `project-out` (single) | Agent `tool_ids` PATCH is destructive — send all IDs. **Output is an envelope** `{raw, message, token_usage}`, not the bare result — downstream readers/DT expressions must unwrap `.message`/`.raw`. |
| Table / CDT | `decisiontablenode` | `condition_groups[]`, `default_next_node`, `next_error_node` | `input` (input) | `decision-default`, `decision-error`, `decision-out-{group_name}` | Routing is metadata-only. `add_edge` does nothing here — wire via `patch_dt_node` (give targets by name or id; stored as `next_node_id`/`default_next_node_id`). `prompts` must be dict. Each group needs `"conditions": []`. |
| Subgraph | `subgraphnode` | `subgraph` FK, `input_map`, `output_variable_path` | `subgraph-in` (multi) | `subgraph-out` (single) | Circular references detected and blocked. **I/O mapping is non-obvious (confirmed in the executor + at runtime):** each `input_map` *key* becomes a **top-level** variable in the child (`child_vars = child_start_vars \| mapped_input`) — to feed a child that reads `variables.request.x`, map `{"request": "variables.request"}` (the key `request` lands as `variables.request` in the child). `output_variable_path` receives the **entire child `variables` namespace**, NOT the child's end `output_map` — so read `variables.<out>.<child_field>` (e.g. `variables.s1.result.upper`). Nesting works to any depth; each nested subflow runs as its own tracked session. |
| Webhook Trigger | `webhooktriggernode` | `webhook_trigger.webhook_path`, `python_code.code` | none | `webhook-trigger-out` (single) | No input port — nothing wires TO it. Also connect `__start__` to same downstream node for manual runs. |
| Telegram Trigger | `telegramtriggernode` | `telegram_bot_api_key`, `fields[]` | none | `telegram-trigger-out` (single) | Same dual-wiring rule as webhook trigger. `fields[]` maps telegram payload → variables paths. |
| File Extractor | `fileextractornode` | `input_map`, `output_variable_path` | `file-extractor-in` (multi) | `file-extractor-out` (single) | Reads `GraphFile` uploads; outputs extracted text. |
| Audio to Text | `audiotranscriptionnode` | `input_map`, `output_variable_path` | `audio-to-text-in` (multi) | `audio-to-text-out` (single) | Same contract shape as file-extractor. |
| Note | (canvas only, no MCP creation) | `content`, `backgroundColor` | none | none | No runtime effect. Annotation only. |

### Quick Picker

| Requirement | Pick |
|---|---|
| Deterministic transform, external HTTP, data reshaping | `python` |
| Agent reasoning, tool use, file work, EpicChat-facing | `code-agent` |
| Multi-agent collaboration with specialized roles | `project` (crew) |
| Branch to N nodes by rule | `table` (CDT) |
| Branch by Python predicate (2 paths) | `edge` (conditional edge) |
| External HTTP event starts the flow | `webhook-trigger` |
| Telegram bot starts the flow | `telegram-trigger` |
| Parse uploaded document | `file-extractor` |
| Transcribe audio | `audio-to-text-node` |
| Reuse an existing flow as a block | `subgraph` |
| Annotate the canvas | `note` |

---

## Section 4: Port Connection Rules

### Main flow highway

All standard execution nodes connect freely along the primary path:

- **Sources (out):** `start-start`, `python-out`, `project-out`, `file-extractor-out`, `subgraph-out`, `audio-to-text-out`, `code-agent-out`, `webhook-trigger-out`, `telegram-trigger-out`, `table-out`, `edge-out`
- **Targets (in):** `python-in`, `project-in`, `edge-in`, `table-in`, `file-extractor-in`, `subgraph-in`, `audio-to-text-in`, `code-agent-in`, `end-in`

Rule of thumb: if both nodes are on the main execution path, source out → target in "just works".

### Special ports

| Port | Connects only to | Notes |
|---|---|---|
| `webhook-trigger-out`, `telegram-trigger-out` | any main-flow input port | Trigger nodes fan out into normal path |
| CDT `table-*` ports | metadata routing only — NOT wired with edges | Use `patch_dt_node` to wire CDT branches |

### Fan-in / fan-out rules

- **Multi-in (fan-in allowed):** `python-in`, `project-in`, `code-agent-in`, `table-in`, `subgraph-in`, `file-extractor-in`, `audio-to-text-in`, `end-in`, `edge-in`, `edge-out`
- **Single outgoing edge:** `python-out`, `code-agent-out`, `project-out`, `subgraph-out`, `file-extractor-out`, `audio-to-text-out`, `table-out`, `webhook-trigger-out`, `telegram-trigger-out`, `start-start`

To branch execution from one source to two downstream nodes: use a CDT or conditional edge node — single-out ports cannot fan out directly.

---

## Section 5: Knowledge & RAG

Retrieval-augmented generation lets a **crew agent** ground its answers in uploaded documents. Read the constraints first — they shape the whole design.

### Critical Operational Rules

1. **RAG is NOT a tool the agent calls — it is a pre-execution retrieval step.** Before a crew agent runs its task, the runtime issues one knowledge search (`search_knowledges`) over the agent's bound collection and injects the snippets into the task prompt. The agent never decides whether or what to retrieve; it always retrieves once, using the task/query text. There is no "search the knowledge base" tool to wire up.

2. **An agent is statically bound to exactly ONE collection + ONE rag config at design time.** The binding lives on the **agent** record (`knowledge_collection`, plus a rag type `"naive:{id}"` and a search config of `search_limit` + `similarity_threshold`). To search a *different* collection you need a *different* agent. There is **no per-request collection switching**.

3. **The only dynamic part of a search is the query string.** No metadata filtering, no role/tag filtering, no narrowing by document at runtime. If you need access control over documents, that is a *modeling* decision (see rule 4), not a runtime filter.

4. **Document access control = one collection per audience + route the query only to permitted agents.** Because retrieval is collection-bound per agent and there is no query-time filtering, you cannot keep restricted and public docs in one collection and filter by role. Put each audience's documents in their own collection, bind one agent per collection, and route the request only to the agent(s) the user is permitted to use. You never query a forbidden collection. (See `flow-ddd` → Patterns That Work → "Access-controlled RAG".)

5. **Only crew agents (`crewnode`) retrieve knowledge. `code-agent` (`codeagentnode`) CANNOT do RAG.** A code-agent has an `llm_config_id` but no knowledge binding. If a responsibility needs grounding in uploaded docs, it must be a crew agent inside a `crewnode`.

6. **`python` nodes have no RAG access at all.** A python/webhook node executor only receives `state = {variables, state_history}` in its globals — no session id, no retrieval handle. Knowledge cannot be fetched from arbitrary code; it only enters via a crew agent's pre-task retrieval.

7. **Indexing must complete before queries return anything.** A collection with documents but no embeddings returns empty retrieval. An embedding config is required on the collection/RAG before indexing. Always run indexing after uploading or re-chunking.

8. **`knowledge_collection` alone does NOT enable retrieval — you must ALSO set `naive_rag_id`.** Retrieval fires only when the agent has an `AgentNaiveRag` join row (the runtime guard is literally `if self.rag_type_id:`, and `rag_type_id` is derived *solely* from that join — never from `knowledge_collection`). The backend creates the join from a `rag` field on the agent write API (`{"rag_type":"naive","rag_id":<naive_rag_id>}`) and *requires* it whenever `knowledge_collection` is set. The MCP `create_agent`/`update_agent` tools expose a **`naive_rag_id`** param that forwards this `rag` field — so to make a crew agent RAG-capable, pass **BOTH** `knowledge_collection=<collection_id>` and `naive_rag_id=<naive_rag_id>`. Setting only `knowledge_collection` is rejected (`"rag is required"`); setting neither = no retrieval.

### Data model (hierarchy)

```
SourceCollection
 └─ DocumentMetadata        (each document FK to exactly one collection)
NaiveRag                    (a RAG index over a collection; has an embedding config)
 └─ NaiveRagDocumentConfig  (per-document chunking: chunk_strategy/size/overlap; unique per (rag, document))
     └─ NaiveRagChunk
         └─ NaiveRagEmbedding (pgvector)
Agent ── AgentNaiveRag (M:M) ── NaiveRag   (the static binding that makes an agent RAG-capable)
```

### MCP build sequence for a queryable collection

| Step | Tool | Notes |
|---|---|---|
| 1. Create the collection | `create_source_collection(collection_name, embedding_config)` | Pass an `embedding_config` id; embeddings are required to query. Create one first with `create_embedding_config(custom_name, model)` / pick via `list_embedding_configs`, `list_embedding_models`. |
| 2. Add documents | `upload_document_file(collection_id, file_content_base64, filename)` — the supported path | The tool sends the multipart field as `files` (required). `add_document` POSTs to a list-only endpoint and returns **405 — do not use it**. |
| 3. Create the RAG index | `create_naive_rag(collection_id, embedder_id, chunk_strategy, chunk_size, chunk_overlap)` | `embedder_id` is **REQUIRED** (the EmbeddingConfig id — use the one the collection was created with). The chunk_* args set defaults applied when document configs are initialized. |
| 4. Initialize per-doc chunk configs | `init_naive_rag_document_configs(naive_rag_id)` | Creates a `NaiveRagDocumentConfig` for every document in the collection. |
| 5. (Optional) tune chunking | `bulk_update_naive_rag_document_configs(naive_rag_id, configs=[{"id":..., ...}])` or `update_naive_rag_document_config(...)` | Each config item must include its `id`. |
| 6. (Optional) preview chunking | `process_chunking(naive_rag_id, config_id)` | **Preview only — does not save.** Per-config; use to eyeball how a document will split before indexing. |
| 7. Index | `trigger_rag_indexing(rag_id, rag_type="naive")` — pass the **naive_rag_id**, NOT the collection id | Computes embeddings + builds the pgvector index. Must finish before retrieval returns results. (Indexing is async; poll `get_naive_rag(naive_rag_id)` until `rag_status == "completed"`.) |
| 8. Bind a crew agent | `create_agent(role, goal, backstory, llm_config=<id>, knowledge_collection=<collection_id>, naive_rag_id=<naive_rag_id>)` (or `update_agent`) | Pass **BOTH** `knowledge_collection` and `naive_rag_id` — see rule 8. The agent then runs inside a `crewnode` (with a task whose instructions reference the question). (`update_agent` `tool_ids` is a destructive replace — see Section 2 rule 7.) |

Inspection: `list_source_collections`, `get_source_collection`, `list_collection_documents` / `list_documents`, `list_naive_rag_for_collection`, `get_naive_rag`, `list_naive_rag_chunks` / `list_naive_rag_document_chunks`, `get_naive_rag_document_config`, `list_naive_rag_document_configs`.

---

## Section 6: EpicChat Integration

A flow becomes the brain behind the EpicChat widget. The widget — not the flow — owns the conversation; the flow runs once per message.

### Critical Operational Rules

1. **`epicchat_enabled` is a marker only — there is no runtime branching on it.** It just flags the flow as chat-connected so the widget can pick it up. Set it with `update_flow_metadata(flow_id, epicchat_enabled=True)`. The flow runs identically whether invoked from the widget or a manual run.

2. **Default model = one fresh, stateless session PER user message.** Each user message triggers a new `run_session`. The flow keeps no memory between turns by itself — the **widget replays history** on every call. Don't design EpicChat flows assuming in-session memory; for true cross-session memory use persistent variables (see `flow-ddd`).

3. **Read the message from `variables.context`, not from a custom start variable.** Every widget call seeds `variables.context` with:

   | Path | Contents |
   |---|---|
   | `variables.context.user_input` | The current message text — **this is the key the flow reads for the question.** |
   | `variables.context.chat_history` | `[{role, content}, ...]` of prior turns (widget-supplied; the flow's only view of the conversation). |
   | `variables.context.user_params` | Arbitrary metadata parsed from the widget's `userData` HTML attribute — the channel for identity/context from the embedding page (client-trusted). |
   | `variables.context.user_action` | Optional; set when the user clicks an action button (see `epicchat-response`). |
   | `variables.context.chat_session_id` | Present **only** in the Code-Agent "stateful" mode (preserves an OpenCode workspace); flow sessions are still independent per message. |

   Declare these paths in the start node's `variables.context` (even as `null`/`[]`) so `input_map` reads resolve — undeclared paths raise at runtime.

4. **The response to the widget = the End node's `output_map`, and it must include a `message` field.** The end node applies `output_map` against `variables` and that dict is sent to the widget. The default `output_map` is `{"context": "variables"}` — usually you override it to emit a `message` (plus optional `ef_tables`, `action_message`, etc.). See the `epicchat-response` skill for the full rich-formatting contract (buttons, tables, navigation actions).

5. **User identity is NOT auto-injected into `variables`, and nodes cannot read `session_id`/`graph_user` at runtime.** The logged-in user is resolved from `username` (= email) into `Session.graph_user`, but that never lands in `variables`. Two supported ways to get identity into a node's reach:
   - **Widget `userData` → `variables.context.user_params`** — set by the embedding page; client-trusted (don't authorize on it).
   - **Pre-seed `GraphOrganizationUser.persistent_variables` per user** — these are merged into the session `variables` at start via a shallow top-level `variables.update(...)`; server-trusted. (See `flow-ddd` → Persistent Variables.)

6. **Don't reach for `wait_for_user` for normal chat multi-turn.** `wait_for_user` is a *separate* mechanism: setting `human_input=True` on a crew Task pauses the session (`WAIT_FOR_USER`) and resumes via the AnswerToLLM endpoint. EpicChat multi-turn is already handled by the widget's per-message sessions + `chat_history` — using `wait_for_user` for it just deadlocks the chat. Reserve it for genuine mid-flow human approval loops.

---

## Flow Creation Checklist

```
1. create_flow("Flow Name")
2. add_node(flow_id, "<node_type>", config={...}, node_name="NodeName")  # code+libraries inside config
3. nodes = get_flow_nodes(flow_id)                     # resolve names -> ids
   add_edge(flow_id, start_id, node_id)                # integer ids, not names
4. init_flow_metadata(graph_id)                        # MANDATORY (sync)
5. patch_start_variables(graph_id, [...])
6. test_flow(graph_id)        # gate on .ok
   validate_flow_paths(graph_id)
   describe_flow(graph_id)    # eyeball the assembled flow
```

**Trigger node dual-wiring** — resolve ids first, then wire both entry paths to
the same downstream node:
```
nodes = get_flow_nodes(flow_id)        # -> {"__start__": id_s, "API Intake": id_t, "Data Enricher": id_d}
add_edge(flow_id, id_s, id_d)          # enables manual Run button
add_edge(flow_id, id_t, id_d)          # webhook-triggered path
```
Without the `__start__` edge, `run_session` fails: "No node connected to start node".
