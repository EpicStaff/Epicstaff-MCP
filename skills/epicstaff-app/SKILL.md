---
name: epicstaff-app
description: Use when a request is app-shaped — EpicStaff is the backend and the deliverable needs a custom UI shell that users interact with. Covers building a standalone app wired to EpicStaff purely over the run-session REST API (the apps/pallet-quote-chat pattern). Normally invoked by epicstaff-solution AFTER the EpicStaff backend flow is built and its runnable gate passes.
---

# EpicStaff App — Custom UI Shell (EpicStaff as headless backend)

Use this when the request is **app-shaped** (see `epicstaff-solution`): the EpicStaff flow is
the backend, and users need a UI to interact with it.

**Division of labor — do not blur it:** EpicStaff owns *all* server-side logic —
orchestration, agents, RAG, persistence, **and deterministic computation in `pythonnode`s**.
The UI is a **thin shell**: authenticate, send input, render output, show progress. **No
business logic in the UI.** If you're tempted to compute in the frontend, that logic belongs
in a `pythonnode` — fix the backend, not the shell.

This is **ordinary Claude Code work** (write app code), not MCP — MCP built the backend; the
app talks to it over REST. One session, two toolsets.

---

## Reference implementation

`apps/pallet-quote-chat/` — a single-file `index.html` chat UI using EpicStaff as a pure REST
backend (read its `README.md`). Copy its shape; it is the canonical template.

Start with a single-file HTML app unless the UX genuinely needs a framework. Keep it minimal.

---

## The REST contract

Base URL, e.g. `http://localhost:8000`. Two auth modes:

**Auth (prefer API key — durable, no token refresh, no stored password):**
- **API key:** send header `X-Api-Key: <key>` on every request. Mint it with the MCP tool
  `create_api_key(name="<app>-ui")` → returns the raw key **once** (EpicStaff stores only a hash).
- **Email + password JWT (fallback):**
  - `POST /api/auth/login/` body `{ "email": "...", "password": "..." }` → `{ access, refresh }`
    (login uses **`email`**, not username).
  - Send `Authorization: Bearer <access>`; refresh via `POST /api/auth/refresh/` body `{ "refresh": "..." }`.

**Run the flow:**
```
POST /api/run-session/
body: { "graph_id": <int>, "variables": { <start-node namespace> } }
→ returns the session id
```
The `variables` object **must match the flow's start-node DDD namespace** exactly. Example from
the pallet app: `{ "context": { "user_input": "...", "chat_history": [...], "user_action": null } }`.

**Read the answer + live status:**
```
GET /api/graph-session-messages/?session_id=<id>&limit=200
```
Poll (~1 s). Each entry is a node message. The final answer is the entry with
`message_type === "graph_end"` → its **`end_node_result`** (the end node's `output_map`, e.g.
`{ message, quote }`). Map intermediate node events (`start` / `agent_node_stream` with
`task_start` / `tool_call` / `task_finish` / `python_stream` / `finish`) to friendly progress
labels. (`GET /api/sessions/<id>/get-updates/` gives status only — messages carry the result.)

---

## Build steps

1. **Confirm the backend is ready** — the flow exists and `smoke_test_flow` returned
   `runnable: true`. Record `graph_id`, organization id, and the exact start-variables namespace.
2. **Scaffold the UI** as ordinary code (single-file HTML first; framework only if the UX needs it).
3. **Wire auth** — prefer `X-Api-Key` via `create_api_key`; fall back to email/password JWT.
4. **Call `run-session`** with `variables` shaped to the start namespace.
5. **Poll `graph-session-messages`** — render `graph_end.end_node_result`; show live status from
   node events.
6. **Config, not secrets in code** — base URL, `graph_id`, org id, key in `localStorage`/env.
   Never hardcode or commit keys.
7. **Run it end-to-end** against the live backend before declaring done.

---

## Red flags — stop and correct

- Business logic (math, pricing, parsing, rules) in the UI — it belongs in a `pythonnode`.
- Letting an **agent** do deterministic math instead of a `pythonnode` (the pallet failure).
- Rebuilding the EpicChat widget by hand — this is a *custom* shell; use the widget only if the
  user explicitly asks for it.
- Hardcoding or committing an API key.
- Declaring done on a UI that was never run against the live flow.

---

## Done

The UI runs against the live EpicStaff flow: a real user input round-trips through
`run-session`, and the flow's `end_node_result` is rendered in the UI.
