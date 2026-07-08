# EpicStaff MCP — Claude Code Plugin

EpicStaff MCP gives Claude Code tools to manage flows, agents, sessions, knowledge, and more via the EpicStaff REST API.

## Setup

Set these environment variables (once, in your shell profile):

```bash
export EPICSTAFF_BASE_URL=http://localhost:8000      # EpicStaff backend URL
export EPICSTAFF_API_TOKEN=                          # optional JWT, sent as Authorization: Bearer <token>
export EPICSTAFF_USERNAME=                            # optional login email — JWT login + auto-refresh (frontend-equivalent)
export EPICSTAFF_PASSWORD=                            # optional login password (pair with EPICSTAFF_USERNAME)
export EPICSTAFF_MCP_PATH=/path/to/epicstaff-mcp     # only for manual `claude mcp add` / dev runs
```

> Auth: the backend accepts only `Authorization: Bearer <JWT>` / `X-Api-Key` / `ApiKey` — **not** HTTP Basic.
> Set **either** `EPICSTAFF_API_TOKEN` (a JWT, sent as `Bearer` verbatim) **or**
> `EPICSTAFF_USERNAME`/`EPICSTAFF_PASSWORD`, which log in via `POST /api/auth/login/` and
> auto-refresh via `POST /api/auth/refresh/` (re-login on refresh expiry) — the same JWT flow the frontend uses.

> When installed as a plugin (`/plugin install`), `EPICSTAFF_MCP_PATH` is **not** needed —
> the bundled server runs from `${CLAUDE_PLUGIN_ROOT}` automatically. Only set it for the
> manual `claude mcp add` path or local development.

## Skills

| Skill | When to invoke |
|---|---|
| `epicstaff-flow` | Building a new flow or modifying an existing one — runs the full interview → plan → build pipeline |
| `epicstaff` | Anytime you need MCP tool signatures, node type requirements, or critical operational rules |
| `flow-ddd` | Designing the `variables` namespace before building — DDD domain structure, node contracts |
| `flow-debugger` | When a session fails, produces wrong output, hangs, or shows broken wiring |
| `flow-qa` | After a build is complete — pre-submit validation checklist |
| `epicchat-response` | Formatting output for the EpicChat widget (buttons, tables, navigation actions) |

## Reference Docs

| Domain | Doc |
|---|---|
| Flows & nodes | `docs/node-reference.md` |

> Sessions, agents/crews/tasks, tools, knowledge/RAG, and LLM-config reference material lives in the skills above (invoke `epicstaff` for tool signatures and operational rules), not in standalone docs.
