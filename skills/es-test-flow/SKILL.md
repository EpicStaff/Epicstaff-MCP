---
name: es-test-flow
description: Run a pushed EpicStaff flow and debug the result — poll status, read the execution trace, iterate. Use after es-push-flow, or to debug any session.
---

# Test a flow (run + debug)

One responsibility: execute a flow and understand what happened.

1. Get the graph id (from the push result or `list_graphs` / `flow.lock.json`).
2. If the flow uses knowledge collections: JOIN on indexing before running. Call
   `wait_for_collections(collection_ids, timeout_seconds)` with the collection ids from the
   push / `provision_knowledge` result — it blocks until every RAG is terminal (completed /
   warning / failed) or the timeout elapses. Running before this returns means agents run
   without their knowledge. If it reports `timedOut` or a failed RAG, surface that to the user
   (raise the timeout or inspect with `get_collection_status`) rather than running blind.
3. `run_flow` with the graph id and the `initial_state` the flow's start node expects. Pass the
   FULL variables map you want, keyed by top-level variable name (e.g.
   `{"chat": {"message": "..."}, "quote": {}, "reply": null}`) — for `persistent_variables`
   graphs the backend merges the previous ended session's variables as a base, so reset the
   downstream fields to avoid stale carryover from an earlier run.
4. Poll `get_session_updates` (a few seconds apart) until `isTerminal` or `wait_for_user`:
   - `wait_for_user` → read the prompt from `get_session` `status_data` /
     `get_session_messages` and report it to the user. The MCP cannot reply: EpicStaff removed
     the crew-era `answer-to-llm/` endpoint, so there is no answer tool — `stop_session` if the
     run cannot proceed.
   - `error` → `get_session_messages` for the trace; map the failing node back to the
     flow-source node by `node_name`; fix the source; es-push-flow; rerun.
   - `end` → read `get_session_messages` (defaults to the concise view: a compact timeline plus
     `final_reply` / `final_variables`) and summarize the outputs for the user. Use
     `view: "full"` only when you need the raw per-message trace.
5. A run that must be aborted: `stop_session`.

**Trigger-started flows** (webhook / Telegram trigger instead of a start node): test with
`run_flow_from_trigger(graph_id, node, payload)` instead of `run_flow` — it starts the run at the
trigger node as if the request / update had arrived (no tunnel, webhook trigger or bot needed), and
returns a session_id you poll the same way. The payload reaches the flow as
`variables.trigger_payload` (webhook, through the node's code) or `variables.telegram_payload`;
omit it to use the test payload saved on the node. A Telegram payload may only use the fields selected
on the node (`list_telegram_trigger_fields`) — flow source cannot select them, so a freshly pushed
Telegram trigger needs its fields picked in the EpicStaff editor first.

**One python node misbehaves:** `run_node_code(graph_id, node, variables)` runs that node's stored
code alone (python nodes and webhook-trigger code) and returns stdout / stderr / result — no session,
no other nodes. `use_last_session_input: true` replays what the node received in the newest ended
session. It runs what was pushed: fix the source, es-push-flow, then rerun the node before the flow.

Done when: the user has the run's outcome (result, or diagnosis + fixed source). If the task also
needs a UI or integration on top of the flow, **es-deliver** owns that decision and the next step.
