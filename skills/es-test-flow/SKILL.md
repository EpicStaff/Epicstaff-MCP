---
name: es-test-flow
description: Run a pushed EpicStaff flow and debug the result — poll status, read the execution trace, answer human-input requests, iterate. Use after es-push-flow, or to debug any session.
---

# Test a flow (run + debug)

One responsibility: execute a flow and understand what happened.

1. Get the graph id (from the push result or `list_graphs` / `flow.lock.json`).
2. If the flow uses knowledge collections: `get_collection_status` first — a collection
   still indexing means agents run without their knowledge. Wait or warn the user.
3. `run_flow` with the graph id and any `initial_state` the flow's start node expects.
4. Poll `get_session_updates` (a few seconds apart) until `isTerminal` or `wait_for_user`:
   - `wait_for_user` → read the prompt from `get_session` `status_data` /
     `get_session_messages`, ask the user, reply via `answer_to_llm`.
   - `error` → `get_session_messages` for the trace; map the failing node back to the
     flow-source node by `node_name`; fix the source; es-push-flow; rerun.
   - `end` → read `get_session_messages` and summarize the outputs for the user.
5. A run that must be aborted: `stop_session`.

Done when: the user has the run's outcome (result, or diagnosis + fixed source).
