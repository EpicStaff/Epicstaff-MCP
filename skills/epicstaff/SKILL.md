---
name: EpicStaff-Flow-Reference
description: Use when working with EpicStaff flows, nodes, sessions, or MCP tools — inspecting, building, patching, or debugging. Reference for all epicstaff-mcp tool signatures, node type requirements, port connection rules, and critical operational gotchas.
---

# EpicStaff Flow Reference

All flow and session operations go through MCP tools. Never write raw HTTP calls against the Django API directly — the API has subtle requirements the MCP tools encapsulate correctly.

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
| `patch_python_node(flow_id, name_or_id, code, libraries)` | Update Python node — always pass `libraries` |
| `patch_webhook_node(flow_id, name_or_id, code, libraries)` | Update Webhook handler — always pass `libraries` |
| `patch_code_agent_node(flow_id, name_or_id, system_prompt, stream_handler_code, libraries, llm_config_id)` | Update Code Agent |
| `patch_cdt_node(flow_id, name_or_id, pre_computation_code, post_computation_code, prompts, condition_groups)` | Update CDT |
| `patch_dt_node(flow_id, name_or_id, condition_groups)` | Update DT groups |
| `patch_node_libraries(flow_id, name_or_id, libraries)` | Update libraries only |
| `patch_start_variables(flow_id, variables)` | Set start node variable definitions |

### Flow Structure

| Tool | Purpose |
|---|---|
| `add_node(flow_id, node_type, node_name, ...)` | Add a node |
| `add_edge(flow_id, start_node_name, end_node_name)` | Connect two nodes |
| `delete_node(flow_id, name_or_id)` | Remove a node |
| `delete_edge(flow_id, edge_id)` | Remove a connection |
| `init_flow_metadata(flow_id)` | **MANDATORY after any structural change** |
| `test_flow(flow_id)` | Structural check: connectivity, required fields |
| `copy_flow(flow_id)` | Duplicate a flow |
| `save_flow(flow_id)` | Persist flow state |
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

1. **`init_flow_metadata` is MANDATORY after adding or deleting any node or edge — no exceptions.** Without it new nodes render as black dots, connections are missing, and routing breaks silently.

2. **Node IDs change on every UI save.** The frontend deletes and recreates nodes. Never hardcode numeric DB IDs — always look up nodes by name using `name_or_id`.

3. **`patch_python_node` and `patch_webhook_node` MUST always include `libraries`.** Omitting `libraries` wipes the existing list, causing silent import failures at runtime.

4. **CDT routing is metadata-based, NOT edge-based.** `add_edge` on a CDT output does nothing. Wire targets via `patch_dt_node(..., condition_groups=[{"group_name": ..., "next_node": "<name>", "conditions": [...]}])`.

5. **CDT `prompts` must be a dict, not a list.** `converter_service.py` calls `.items()` — passing a list crashes the crew at runtime.

6. **Non-CDT node `ports` must be `null`, not `[]`.** The frontend auto-generates ports only when `ports === null`; an empty array suppresses port generation.

7. **Agent `tool_ids` PATCH is a destructive replace.** When calling `update_agent`, always include ALL existing tool IDs alongside any new ones — partial lists drop tools.

8. **Every CDT `condition_group` must include `"conditions": []`.** The viewset calls `pop("conditions")` — a missing key causes a silent rollback.

9. **Python nodes require `def main(...)` as the entrypoint.** The crew executor calls it with `input_map` keys as kwargs. Code without `def main` fails with `name 'main' is not defined`.

10. **`output_variable_path` for webhook trigger is always `"variables"`.** The runtime forces it — the handler's return dict merges into `variables` wholesale.

---

## Section 3: Node Types Reference

12 active node types. Do not use `llmnode` — it exists in the DB but has no UI panel and cannot be configured. Use `code-agent` for LLM-based reasoning.

| Display name | MCP `node_type` for `add_node` | Required config fields | Input port | Output port | Key gotchas |
|---|---|---|---|---|---|
| Start | `startnode` | `variables` JSON | none | `start-start` (single) | Patch via `patch_start_variables`. Must connect to at least one downstream node. |
| End | `endnode` | `output_map` JSON | `end-in` (multi) | none | Only one end node per flow. Missing vars resolve to string `"not found"`. |
| Python | `pythonnode` | `python_code.code`, `python_code.libraries`, `input_map`, `output_variable_path` | `python-in` (multi) | `python-out` (single) | Must have `def main(...)`. Always pass `libraries` when patching. |
| Code Agent | `codeagentnode` | `system_prompt`, `llm_config_id`, `agent_mode` (`build`/`plan`), `input_map`, `output_variable_path` | `code-agent-in` (multi) | `code-agent-out` (single) | `libraries` applies to `stream_handler_code` only. `output_schema` triggers retry on mismatch. |
| Project / Crew | `crewnode` | `crew` FK, `input_map`, `output_variable_path` | `project-in` (multi) | `project-out` (single) | Agent `tool_ids` PATCH is destructive — send all IDs. |
| Table / CDT | `decisiontablenode` | `condition_groups[]`, `default_next_node`, `next_error_node` | `input` (input) | `decision-default`, `decision-error`, `decision-out-{group_name}` | Routing is metadata-only. `add_edge` does nothing here. `prompts` must be dict. Each group needs `"conditions": []`. |
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

## Flow Creation Checklist

```
1. create_flow("Flow Name")
2. add_node(flow_id, "<node_type>", "NodeName", ...)   # include code and libraries
3. add_edge(flow_id, "__start__", "NodeName")
4. init_flow_metadata(flow_id)                         # MANDATORY
5. patch_start_variables(flow_id, [...])
6. test_flow(flow_id)
```

**Trigger node dual-wiring:**
```
add_edge(flow_id, "__start__", "Data Enricher")    # enables manual Run button
add_edge(flow_id, "API Intake", "Data Enricher")   # webhook-triggered path
```
Without the `__start__` edge, `run_session` fails: "No node connected to start node".
