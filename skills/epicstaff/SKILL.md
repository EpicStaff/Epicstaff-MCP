---
name: epicstaff
description: Use when working with EpicStaff flows, nodes, sessions, or MCP tools — inspecting, building, patching, or debugging. Reference for all epicstaff-mcp tool signatures, node type requirements, port connection rules, and critical operational gotchas.
---

# EpicStaff Flow Reference

All flow and session operations go through MCP tools. Never write raw HTTP calls against the Django API directly — the API has subtle requirements the MCP tools encapsulate correctly.

---

## Section 0: Platform Capabilities — what EpicStaff can actually do

Read this before designing a flow. Do NOT assume a capability is missing — assuming a
constraint that doesn't exist leads to worse designs (e.g. substituting LLM-recalled facts
for real data). When unsure, **verify empirically** with `run_python_code` before building
around a supposed limitation.

- **The Python sandbox has full outbound internet.** `pythonnode` code (and python tools) can
  call ANY external API/service — REST, geocoders, routers, search, scraping, webhooks, cloud
  SDKs. Verified live: HTTPS to third-party APIs returns 200 in <350 ms from inside the sandbox.
  So fetch **real, authoritative data** rather than having an LLM recall it from memory.
- **Python nodes/tools can install packages.** Set the `libraries` field (e.g. `["requests",
  "httpx", "pandas"]`) and the sandbox pip-installs them before running. Stdlib `urllib` also
  works with zero libraries.
- **Agents can use tools — including internet-facing ones.** Agent/task nodes (and crews)
  attach tools (MCP tools, python tools, custom `BaseTool`s) via Surfaces; those tools can hit
  the internet, call services, read/write storage. An agent is not limited to its own text.
- **Flows persist state across sessions.** Attach a storage folder and use `EpicStaffStorage`
  from a python node (see the `epicstaff-state` skill) — memory, counters, user profiles, files.
- **Flows have real I/O surfaces.** Webhook / Telegram / schedule triggers start flows from
  outside; file-extractor and audio-transcription nodes ingest uploads; EpicChat and the
  run-session REST API drive them from a UI.

**Design rule (deterministic-first):** use real data sources and Python for **facts and every
number** (coordinates, distances, prices, lookups, validation); use the LLM only for **language
and fuzzy text** (parsing a free-text message, composing a reply, classification). Never put the
LLM in the numbers path — LLM-recalled facts are approximate and unverifiable.

---

## Section 1: MCP Tool Catalog

### Flow Inspection

| Tool | Purpose |
|---|---|
| `list_flows` | List all flows |
| `get_flow(flow_id)` | Full flow with all nodes and edges |
| `get_flow_nodes(flow_id)` | All nodes organized by type |
| `get_flow_connections(flow_id)` | All edges + CDT/DT routing |

### CDT Inspection

| Tool | Purpose |
|---|---|
| `get_cdt_node(flow_id, name_or_id)` | Full CDT with pre/post code, prompts, groups |
| `get_cdt_prompts(flow_id, name_or_id)` | Just the prompts dict |
| `get_cdt_route_map(flow_id)` | Routing map for all CDT/DT nodes |

### Node Patching

| Tool | Purpose |
|---|---|
| `patch_python_node(flow_id, name_or_id, code, libraries)` | Update Python node — `libraries` optional, preserved when omitted |
| `patch_webhook_node(flow_id, name_or_id, code, libraries)` | Update Webhook handler — `libraries` optional, preserved when omitted |
| `patch_code_agent_node(flow_id, name_or_id, system_prompt, stream_handler_code, libraries, llm_config_id)` | Update Code Agent |
| `patch_cdt_node(flow_id, name_or_id, pre_computation_code, post_computation_code, prompts, condition_groups)` | Update CDT — rejects a `next_node`-without-`next_node_id` group, or a `conditions`/`group_type` key, with a 400 |
| `patch_dt_node(flow_id, name_or_id, condition_groups)` | Update DT groups — rejects a `next_node`-without-`next_node_id` group with a 400; `conditions: []` auto-filled |
| `patch_node_libraries(flow_id, name_or_id, libraries)` | Update libraries only |
| `patch_start_variables(flow_id, variables)` | Set start node variable definitions |

### Flow Structure

| Tool | Purpose |
|---|---|
| `add_node(flow_id, node_type, node_name, ..., sync_metadata=True)` | Add a node — auto-syncs metadata unless `sync_metadata=False` |
| `add_edge(flow_id, start_node_name, end_node_name, sync_metadata=True)` | Connect two nodes — auto-syncs metadata |
| `delete_node(flow_id, name_or_id, sync_metadata=True)` | Remove a node — auto-syncs metadata |
| `delete_edge(flow_id, edge_id, sync_metadata=True)` | Remove a connection — auto-syncs metadata |
| `init_flow_metadata(flow_id)` | Re-lay-out and re-style all nodes — called automatically by the tools above; run manually only after `sync_metadata=False` batches |
| `test_flow(flow_id)` | Structural check only: connectivity, required fields (does NOT run the flow) |
| `smoke_test_flow(flow_id, variables=…, execute=True)` | **Runnable gate.** Static `_validate_graph` + one live run; verdict `{runnable, reached_end, holes, node_errors, …}`. Use this — not `test_flow` — to prove a built/edited flow is ready to test. `execute=False` = static-only. |
| `copy_flow(flow_id)` | Duplicate a flow |
| `save_flow(flow_id, ..., sync_metadata=True)` | Persist flow state — auto-syncs metadata |
| `export_flow(flow_id)` | Export flow as JSON |
| `import_flow(payload)` | Import flow from JSON |

### Sessions

| Tool | Purpose |
|---|---|
| `list_sessions(flow_id)` | Recent sessions for a flow |
| `run_session(flow_id, variables)` | Start a session |
| `run_session_and_wait(flow_id, variables, timeout)` | Start and poll until done |
| `get_session_updates(session_id)` | Current session status |
| `stop_session(session_id)` | Stop a running session |
| `inspect_session(session_id)` | Per-node input/output |
| `send_message(session_id, ...)` | Send human input to a waiting session |

### Session Debug

| Tool | Purpose |
|---|---|
| `get_session_warnings(session_id)` | Warnings emitted during execution |
| `list_session_messages(session_id)` | Message history for a session |
| `get_session_timings(session_id)` | Per-node duration breakdown |
| `get_session_trace(session_id)` | `message_history` evolution |
| `get_session_crew_input(session_id)` | Crew node inputs |

### Crews / Agents / Tasks

| Tool | Purpose |
|---|---|
| `list_crews` / `get_crew` / `create_crew` / `update_crew` | Crew management |
| `list_agents` / `get_agent` / `create_agent` / `update_agent` | Agent management |
| `list_tasks` / `get_task` / `create_task` / `update_task` | Task management |

---

## Section 2: Critical Operational Rules

These rules encode hard-won lessons from production issues. Violating any causes silent failures or data loss.

1. **`init_flow_metadata` runs automatically after `add_node`/`delete_node`/`add_edge`/`delete_edge`/`save_flow`.** Each of those tools takes a `sync_metadata: bool = True` param — leave it default and you never need to think about black-dot nodes. Only pass `sync_metadata=False` when batching several structural writes back-to-back, and call `init_flow_metadata(flow_id)` yourself once at the end.

2. **Node IDs change on every UI save.** The frontend deletes and recreates nodes. Never hardcode numeric DB IDs — always look up nodes by name using `name_or_id`.

3. **`patch_python_node` and `patch_webhook_node` preserve `libraries` when you omit them.** Both tools fetch the node's current `libraries` first and re-send them if you don't pass a new list — omitting the parameter is safe. Pass `libraries` explicitly only when you actually want to change the set.

4. **CDT/DT routing is metadata-based, NOT edge-based.** `add_edge` on a CDT/DT output does nothing. Wire each group by its target's **numeric `next_node_id`** via `patch_cdt_node` (CDT) or `patch_dt_node` (DT), and set `default_next_node_id` + `next_error_node_id`. Both tools now **reject** (with a 400 telling you exactly what to send) a group that sets `next_node` (a name) without an integer `next_node_id`, instead of silently stripping it and leaving the group unrouted.

5. **CDT `prompts` must be a dict, not a list.** `converter_service.py` calls `.items()` — passing a list crashes the crew at runtime.

6. **Non-CDT node `ports` must be `null`, not `[]`.** The frontend auto-generates ports only when `ports === null`; an empty array suppresses port generation.

7. **`update_agent`'s `tool_ids` is safe by default.** The backend PATCH is unconditionally destructive server-side (omitting `tool_ids` from the request wipes all tools), so `update_agent` always fetches the agent's current tools first: `tool_ids=None` (default) preserves them untouched; `tool_ids=[...]` **merges** with the existing set unless you pass `replace_tool_ids=True`, which replaces them exactly (use that to remove a tool).

8. **Every plain DT `condition_group` must include `"conditions": []`.** `patch_dt_node` injects this automatically — omitting it in your call is safe. (This key does NOT exist on CDT groups — see rule 12.)

9. **Python nodes require `def main(...)` as the entrypoint.** The crew executor calls it with `input_map` keys as kwargs. Code without `def main` fails with `name 'main' is not defined`.

10. **`output_variable_path` for webhook trigger is always `"variables"`.** The runtime forces it — the handler's return dict merges into `variables` wholesale.

11. **CDT expressions use dot-notation against `variables`, NOT subscript.** `variables.routing.category == "hr"` works; `variables['routing']['category']` raises `'types.SimpleNamespace' object is not subscriptable` at runtime.

12. **CDT condition groups must NOT include `group_type` or `conditions` fields (those are DT-only).** `patch_cdt_node` now rejects a group carrying either with a 400 before it reaches the backend, instead of letting it crash the viewset. Send only `group_name`, `order`, `expression`, `prompt_id`, `manipulation`, `continue_flag`, `next_node_id`, `dock_visible`, `field_expressions`, `field_manipulations`, `route_code`, `section`.

13. **A conditional edge's `main()` must return the string `"NodeName #id"`** (e.g. `"Escalation #76"`). A bare name silently routes to graph end; an int errors with "output should be a string".

14. **UI saves can drop CDT group `next_node_id` (routing silently wiped).** After any UI edit of a flow containing CDTs, re-verify with `get_cdt_route_map` and re-patch the groups.

15. **Subgraph I/O is fragile — use flat vars + a scoped output path.** Child subflows should read/write FLAT top-level vars (nested `input_map` keys do not reach `variables.input.*`), and the parent `subgraphnode` must set a SCOPED `output_variable_path` (e.g. `variables.live`) — never `"variables"`, which clobbers the whole parent dict.

---

## Related skills

- **`epicstaff-channels`** — receiving from / replying to Telegram (messages, inline buttons, `callback_query`), webhooks, and file/voice inputs. There is no built-in reply node; you build one.
- **`epicstaff-state`** — persisting data across sessions / per user. Python-node storage is path-locked to `sessions/<id>/` until you attach a folder via `attach_storage_to_flow`.

---

## Section 3: Node Types Reference

Do not use `llmnode` — it exists in the DB but has no UI panel and cannot be configured. For LLM-based reasoning use an **`agentnode`** (single agent with ordered inline tasks) or **`tasknode`** (one task) — the standalone agent microservice.

> **Deprecated (still run, slated for removal):** `codeagentnode` (Code Agent) and `crewnode` (Crew/Project). Prefer `agentnode`/`tasknode`. Creating them via `add_node` returns a `deprecation_warning`; `create_flow_from_spec` emits a `deprecated_node_type` warning.

| Display name | MCP `node_type` for `add_node` | Required config fields | Input port | Output port | Key gotchas |
|---|---|---|---|---|---|
| Start | `startnode` | `variables` JSON | none | `start-start` (single) | Patch via `patch_start_variables`. Must connect to at least one downstream node. |
| End | `endnode` | `output_map` JSON | `end-in` (multi) | none | Only one end node per flow. Missing vars resolve to string `"not found"`. |
| Python | `pythonnode` | `python_code.code`, `python_code.libraries`, `input_map`, `output_variable_path` | `python-in` (multi) | `python-out` (single) | Must have `def main(...)`. Always pass `libraries` when patching. |
| Code Agent | `codeagentnode` | `system_prompt`, `llm_config_id`, `agent_mode` (`build`/`plan`), `input_map`, `output_variable_path` | `code-agent-in` (multi) | `code-agent-out` (single) | **⚠ DEPRECATED — prefer `agentnode`/`tasknode`.** `libraries` applies to `stream_handler_code` only. `output_schema` triggers retry on mismatch. |
| Project / Crew | `crewnode` | `crew` FK, `input_map`, `output_variable_path` | `project-in` (multi) | `project-out` (single) | **⚠ DEPRECATED — prefer `agentnode` (ordered inline tasks).** Agent `tool_ids` PATCH is destructive — send all IDs. |
| Agent | `agentnode` | `agent_definition`, `tasks[]` (ordered), `input_map`, `output_variable_path`, optional `surface_list`/`inline_surface` | `agent-in` (multi) | `agent-out` (single) | **Preferred agent node** (standalone microservice, no crew). Task output is a plain string under `.message`; map end node to the path itself, not `.message`. Never send `ports`. |
| Task | `tasknode` | `agent_definition`, `instructions`, `input_map`, `output_variable_path`, optional `output_schema`/`surface_list` | `task-in` (multi) | `task-out` (single) | Single-task variant of agentnode. Never send `ports`. |
| Decision Table (DT) | `decisiontablenode` | `condition_groups[]`, `default_next_node_id`, `next_error_node_id` | `input` (input) | `decision-default`, `decision-error`, `decision-out-{group_name}` | **Avoid — prefer CDT.** Routing is metadata-only (`add_edge` does nothing); wire via `patch_dt_node`. Backend PATCH 500s on a stray `next_node` NAME (route by `next_node_id`). |
| Classification Decision Table (CDT) | `classificationdecisiontablenode` | `condition_groups[]` (each `expression` + `next_node_id`), `default_next_node_id`, `next_error_node_id`; optional `prompts` | `input` | metadata routing | **Preferred brancher.** Deterministic superset of DT — routes on a group `expression` against `variables` with NO LLM unless a group sets `prompt_id`. Wire via `patch_cdt_node`. |
| Subgraph | `subgraphnode` | `subgraph` FK, `input_map`, `output_variable_path` | `subgraph-in` (multi) | `subgraph-out` (single) | Circular references detected and blocked. |
| Webhook Trigger | `webhooktriggernode` | `webhook_trigger.webhook_path`, `python_code.code` | none | `webhook-trigger-out` (single) | No input port — nothing wires TO it. Also connect `__start__` to same downstream node for manual runs. |
| Telegram Trigger | `telegramtriggernode` | `telegram_bot_api_key`, `fields[]` | none | `telegram-trigger-out` (single) | Same dual-wiring rule as webhook trigger. `fields[]` maps telegram payload → variables paths. |
| File Extractor | `fileextractornode` | `input_map`, `output_variable_path` | `file-extractor-in` (multi) | `file-extractor-out` (single) | Reads `GraphFile` uploads; outputs extracted text. |
| Audio to Text | `audiotranscriptionnode` | `input_map`, `output_variable_path` | `audio-to-text-in` (multi) | `audio-to-text-out` (single) | Same contract shape as file-extractor. |
| Note | (canvas only, no MCP creation) | `content`, `backgroundColor` | none | none | No runtime effect. Annotation only. |

### Quick Picker

| Requirement | Pick |
|---|---|
| Deterministic transform, external HTTP, data reshaping | `python` |
| Agent reasoning, tool use, file work, EpicChat-facing | `agentnode` (ordered inline tasks) or `tasknode` — *not* `code-agent` (deprecated) |
| Multi-agent / multi-step role work | `agentnode` with ordered `tasks[]` — *not* `project`/`crew` (deprecated) |
| Branch to N nodes by rule | `classificationdecisiontablenode` (CDT — preferred; avoid plain `decisiontablenode`) |
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

## Flow Creation Checklist

```
1. create_flow("Flow Name")
2. add_node(flow_id, "<node_type>", "NodeName", ...)   # metadata syncs automatically
3. add_edge(flow_id, "__start__", "NodeName")          # metadata syncs automatically
4. patch_start_variables(flow_id, [...])
5. test_flow(flow_id)
```

Pass `sync_metadata=False` to `add_node`/`add_edge`/`delete_node`/`delete_edge`/`save_flow`
when batching several structural writes, then call `init_flow_metadata(flow_id)`
yourself once at the end.

**Trigger node dual-wiring:**
```
add_edge(flow_id, "__start__", "Data Enricher")    # enables manual Run button
add_edge(flow_id, "API Intake", "Data Enricher")   # webhook-triggered path
```
Without the `__start__` edge, `run_session` fails: "No node connected to start node".
