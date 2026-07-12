---
name: flow-debugger
description: Use when an EpicStaff flow session fails, produces wrong output, never starts, hangs, or shows broken wiring in the UI.
---

# Flow Debugger

Process-oriented debugging for EpicStaff flows. All steps use MCP tools — never raw HTTP, CLI wrappers, or Django shell.

Companion skills:
- `epicstaff` — MCP tool reference (all tools used here), plus node types: ports, allowed connections, per-type semantics (also `docs/node-reference.md`).
- `flow-ddd` — shape of `variables`, input/output maps.
- `flow-qa` — post-fix validation.

---

## When to Use

**Use this skill when:**
- A session ended in `[error]` or surfaces a traceback.
- A session ran to completion but produced empty / wrong output.
- A specific node did not execute (missing from `inspect_session` trace).
- A flow "runs forever" (stuck in a loop or waiting on input).
- `run_session` itself fails before any node runs (e.g. "No node connected to start node").
- The UI shows nodes as black dots, edges missing, or ports misaligned.

**Do NOT use when:**
- The flow hasn't been built yet — use `epicstaff-flow`.
- The design is wrong — go back to `epicstaff-flow` (design phase).
- You only want to verify a healthy flow — use `flow-qa`.

---

## Core Principle — Symptom, Scope, Suspect, Fix, Verify

Every debug session follows the same shape:
1. **Symptom** — exact observable failure, captured from sessions.
2. **Scope** — which node or edge is implicated. Narrow from the whole flow down to one place.
3. **Suspect** — specific cause grounded in the code / config, not speculation.
4. **Fix** — smallest change that addresses the suspect, via a patch tool.
5. **Verify** — re-run (if possible) and confirm the symptom is gone without new ones.

Do not skip steps. Do not "just try things" — each change must be tied to a specific suspect.

---

## Debug Ladder — Default Order

Run these in order. Stop at the first one that explains the symptom. Every step is read-only unless stated.

### 1. Recent sessions
```
list_sessions(flow_id=<id>)
```
Pull the last 3–5 sessions. Note:
- Latest status (`finished` / `error` / running / stopped).
- Which sessions share a symptom — one-off vs. pattern.
- Whether the failing session even reached the suspected node.

### 2. Session inspection
For the relevant session:
```
inspect_session(session_id)           # per-node input/output
get_session_timings(session_id)       # per-node duration
get_session_trace(session_id)         # message_history evolution
get_session_crew_input(session_id)    # crew-node inputs (if applicable)
```
What to look for:
- Node appears in the trace but with `error` message → that node failed.
- Node absent from the trace → routing did not reach it.
- Node `input` is `{}` or `None` when it should not be → upstream did not write the expected path, or `input_map` is wrong.
- Node `output` shape does not match downstream `input_map` → contract mismatch.
- Timing shows one node taking orders of magnitude longer → external dependency timeout.

### 3. Graph connectivity
```
get_flow_nodes(flow_id)
get_flow_connections(flow_id)
```
Check:
- Every node from the architecture is present.
- `__start__` is wired to at least one downstream node (missing → "No node connected to start node" at run time).
- Webhook / Telegram trigger nodes do NOT have anything wired into them.
- Every edge expected by the architecture exists.

### 4. CDT route map (only if CDT nodes are involved)
```
get_cdt_route_map(flow_id)
```
Red flags:
- Any group shows "NOT FOUND in metadata" — metadata out of sync, run `init_flow_metadata(flow_id)`.
- `default_next_node` unset and no groups matched — silent fall-through to end.
- Multiple groups route to the same target with overlapping conditions — first match wins.

### 5. Node code and libraries
For the suspect node (say it's `Fetch Weather`, a python node):
```
get_flow_nodes(flow_id)   # find type and name_or_id
```
If it's a python / webhook / code-agent node:
- Read the current code.
- Confirm `def main(...)` exists — missing entrypoint → `name 'main' is not defined`.
- Confirm `libraries` is present and non-empty if the code imports non-stdlib.
- Confirm `input_map` keys match the parameter names of `main` (or are explicit paths).
- Confirm `output_variable_path` is not `None` when downstream reads its output.

### 6. Start variables
```
# read the start node via get_flow_nodes, look at `variables` field
```
Verify every `variables.<path>` any downstream `input_map` reads is declared at session start, even as `null`. Missing paths raise `AttributeError` inside `map_variables_to_input`.

### 7. Session messages (narrative)
```
get_session_trace(session_id)
```
The `message_history` evolves turn by turn — useful for code-agent loops, multi-turn crew executions, and EpicChat sessions. Look for the exact point a message with `type: error` appears.

---

## Error Fingerprints — Fast Match

Map the exact error to its likely root cause. Apply the fix, then re-run.

| Error / symptom | Likely root cause | Fix |
|---|---|---|
| "No node connected to start node" | `__start__` is not wired to any downstream node. | `add_edge(flow_id, "__start__", <first-node>)` then `init_flow_metadata`. |
| "name 'main' is not defined" | Python/webhook node code has no `def main(...)` entrypoint. | `patch_python_node` (or `patch_webhook_node`) with fixed code. Always pass `libraries`. |
| `AttributeError: 'DotDict' object has no attribute '<path>'` | An `input_map` references `variables.<path>` that is not set in start variables and not written by any upstream node. | Declare the path in start variables (`patch_start_variables`) or add an upstream writer. |
| `ModuleNotFoundError` in a python/webhook/code-agent node | `libraries` is empty or was wiped by a prior `patch_python_node` without `libraries`. | `patch_node_libraries` (or full patch with `libraries` included). |
| Node shows as black dot in UI, edges missing | Metadata out of sync with DB. | `init_flow_metadata(flow_id)`. |
| `"Found edge starting at unknown node"` | Node was renamed; its edges still reference the old ID (or metadata still holds the old name). | Metadata refresh: `init_flow_metadata`. If truly stale, delete and re-add the edge. |
| CDT "NOT FOUND in metadata" for a group target | Metadata-routing can't resolve the target `node_name`. | Confirm the target exists, then `init_flow_metadata`. |
| Decision Table silently routes to default for every input | `condition_groups[*].next_node` never set, or `conditions: []` missing on a group → viewset silently rolled back the patch. | Re-patch with `patch_dt_node`, include `"conditions": []` on every group. |
| `patch_cdt_node`/`patch_dt_node` returns a 400 naming a `next_node` | Routed a group by a node **name** (`next_node`) without an integer `next_node_id`. | Look the target id up via `get_flow_nodes`/`get_flow_connections`, re-patch with `"next_node_id": <int>`. |
| 400 on a CDT group mentioning `group_type` / `conditions` | Sent DT-only fields on a CDT group — rejected before the backend. | Remove `group_type`/`conditions`; a CDT group carries only `expression`/`next_node_id`/`route_code` (+ optional `manipulation`/`prompt_id`). |
| Empty output from end node, everything looks right | `output_map` references a `variables.<path>` that was never written — `map_variables_to_input(set_missing_variables=True)` returned literal `"not found"`. | Confirm the writer actually sets the path (inspect the session), or fix the `output_map` path. |
| Code Agent never starts / response timeout | Underlying AI instance unhealthy, wrong `llm_config_id`, or API key missing on the LLM config. | Verify `llm_config_id` resolves to a healthy provider and has a valid API key. Ask an operator to restart the code instance if stuck. |
| Code Agent behaves as old prompt after UI edit | `system_prompt` only applies to NEW sessions. | Start a fresh session — the running/old ones keep the previous prompt. |
| Crew node hangs | Crew's agent lost a tool it depends on — usually from a prior `update_agent(..., replace_tool_ids=True)` that didn't include it. | Re-check the agent's tools (`get_agent`) and re-add the missing one via `update_agent(tool_ids=[...])` (merges by default). |
| `condition_group` expressions evaluate to non-bool | CDT expression returned a truthy non-bool (string, int). Runtime asserts `isinstance(result, bool)`. | Wrap with `bool(...)` or rewrite as an explicit boolean. |
| `session_id=` filter returns wrong data | Code used `session=` instead of `session_id=` on the session messages endpoint. | Use `session_id=` — the other silently returns all rows. |
| Python node returns non-dict | Output write target is a DotDict but executor needs a dict to merge. | Return a `dict`. |
| End node result silently empty after rename | Renamed the start writer — `output_map` path still references old `variables.<path>`. | Update `output_map` to the new path. |

---

## Playbooks by Symptom Category

### Session ended in `[error]`
1. `list_sessions(flow_id=<id>)` — grab the failing session_id.
2. `inspect_session(session_id)` — find which node's entry carries the error.
3. Read the error's `stderr` or exception message.
4. Match it to the Error Fingerprints table. If not listed, go to step 5.
5. Read the node's code and config via `get_flow_nodes`.
6. Form a specific suspect. Fix. Run `test_flow(flow_id)`, then `run_session_and_wait` with the same inputs that failed.

### Session finished but output is wrong or empty
1. `inspect_session(session_id)` — examine each node's input/output. Find the earliest node whose output is not what downstream needs.
2. Check that node's `output_variable_path`. Is it set? Does it match the downstream `input_map`?
3. Check the start variables — does every path exist?
4. If the problem is at the end node, read its `output_map` and confirm the paths align with what's actually in `variables` at end time.
5. Fix and verify.

### Session never starts / `run_session` fails immediately
1. `get_flow_connections(flow_id)` — confirm `__start__` has at least one outgoing edge.
2. If there's a trigger node: confirm `__start__` is still wired independently into the first real node (not into the trigger).
3. `test_flow(flow_id)` — surfaces structural errors.
4. `init_flow_metadata(flow_id)` — in case prior changes didn't sync.

### Node did not execute
1. `get_session_trace(session_id)` — which nodes ran? What was the last-reached node?
2. From the last-reached node: check `get_flow_connections(flow_id)` for its outgoing edge(s).
3. If the last-reached is a CDT: `get_cdt_route_map(flow_id)` — did the chosen group's `next_node` resolve?
4. If the last-reached is a conditional `edge`: read its code, verify return is a valid target name.
5. If the last-reached is a `project` (crew): check crew configuration — tasks, agents, tool_ids all intact.

### Flow runs forever / hangs
1. `get_session_timings(session_id)` — find the node with the largest duration.
2. For `code-agent`: check `polling_interval_ms`, `max_wait_s`, `inactivity_timeout_s`. Timeouts may be set too high.
3. For a python node: likely an external HTTP call with no timeout. Patch the code to add a timeout, re-run.
4. For a CDT / conditional edge: confirm it routes to a real target, not an undefined one (undefined → may re-enter the same node in a loop).
5. For a crew node: a misconfigured task can loop inside CrewAI. Check `get_session_crew_input` and the crew's task definitions.

### UI shows nodes as black dots / broken wiring
Single fix: `init_flow_metadata(flow_id)`. If that doesn't resolve, the metadata and DB are badly out of sync — re-verify with `get_flow_nodes` and `get_flow_connections` and re-apply any recent structural changes.

---

## Patch Rules (do not break the flow while fixing it)

Every patch tool has constraints. Follow them exactly.

- `patch_python_node`, `patch_webhook_node` — `libraries` is optional; omitting it now preserves the node's existing list (fetched and re-sent for you). Pass it explicitly only to change the set.
- `patch_code_agent_node` — include `libraries` when passing code-like fields. Updating `system_prompt` does not affect running sessions.
- `patch_dt_node` — `"conditions": []` is auto-filled per group if you omit it. A group with `next_node` (a name) and no integer `next_node_id` is now rejected with a 400 before any network call, telling you to resolve the target's id.
- `patch_cdt_node` — same `next_node`-without-`next_node_id` rejection as `patch_dt_node`, plus a group carrying `conditions` or `group_type` (DT-only fields) is rejected with a 400 instead of crashing the backend.
- `update_agent`'s `tool_ids` — no longer destructive: the tool always fetches the agent's current tools first. `tool_ids=None` preserves them; `tool_ids=[...]` merges with the existing set by default; pass `replace_tool_ids=True` to replace exactly.
- Renaming a node: edges use integer IDs under the hood, so they follow the rename automatically — but metadata still holds the old name until you re-run `init_flow_metadata`. If the rename MCP tool is unavailable, delete + re-create the node (preserving code, libraries, input_map, output_variable_path) and re-wire its edges.
- Any structural change (add/delete node or edge, or `save_flow`) auto-runs `init_flow_metadata(flow_id)` unless you passed `sync_metadata=False` to batch — in which case run it yourself once before the next session.

---

## Verification After a Fix

Once you apply a patch:
1. `test_flow(flow_id)` — structural check.
2. If the patched node was python/webhook/code-agent: run the simplest possible session that exercises only that path:
   ```
   run_session_and_wait(flow_id, variables=<minimal inputs>, timeout=60)
   ```
3. `inspect_session(new_session_id)` — confirm the previously-failing node now shows expected input and output.
4. If more than one bug fell out in the process, resist chaining fixes — verify each independently before proceeding.

---

## What NOT to Do

- Do not patch a node "just in case" without a specific suspect — patches have side effects (libraries wipes, metadata drift).
- Do not change architecture during a debug session. If the root cause is an architectural flaw, stop debugging and loop back to `epicstaff-flow` (design phase).
- Do not run production sessions as debug canaries — use minimal synthetic inputs.
- Do not guess LLM / model / prompt changes as a fix for a deterministic error (missing variable path, wrong `input_map`). Fix the deterministic cause first.
- Do not rely on UI visual inspection alone — always back-check with `get_flow_nodes` / `get_flow_connections`. The UI can lag behind DB.

---

## Reporting the Fix

When running in EpicChat mode, after a successful fix and verification:

```json
{
  "message": "Fixed **<Node Name>**. Root cause: <one sentence>. Verified with a fresh session.",
  "tools": ["Build mode"],
  "action_message": [
    {"type": "button", "text": "Open node", "action": "openNode", "params": {"flowId": "<id>", "nodeId": "<uuid>"}},
    {"type": "button", "text": "Refresh to see changes", "action": "refreshCache"},
    {"type": "prompt", "text": "Run the QA checklist"},
    {"type": "prompt", "text": "Show the latest session"}
  ]
}
```

Plain text output otherwise — keep the report focused on symptom, root cause, fix, and verification.
