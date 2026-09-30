---
name: es-test-flow
description: Run a pushed EpicStaff flow and debug the result — poll status, read the execution trace, answer human-input requests, iterate. Use after es-push-flow, or to debug any session.
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
     `get_session_messages`, ask the user, reply via `answer_to_llm`.
   - `error` → `get_session_messages` for the trace; map the failing node back to the
     flow-source node by `node_name`; fix the source; es-push-flow; rerun.
   - `end` → read `get_session_messages` (defaults to the concise view: a compact timeline plus
     `final_reply` / `final_variables`) and summarize the outputs for the user. Use
     `view: "full"` only when you need the raw per-message trace.
5. A run that must be aborted: `stop_session`.

Done when: the user has the run's outcome (result, or diagnosis + fixed source). If the task also
needs a UI or integration on top of the flow, **es-deliver** owns that decision and the next step.
