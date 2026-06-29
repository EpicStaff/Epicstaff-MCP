# EpicStaff MCP — Claude Code Plugin

EpicStaff MCP gives Claude Code tools to manage flows, agents, sessions, knowledge, and more via the EpicStaff REST API.

## Setup

Set these environment variables (once, in your shell profile):

```bash
export EPICSTAFF_BASE_URL=http://localhost:8000      # EpicStaff backend URL
export EPICSTAFF_API_KEY=                            # EpicStaff API key (sent as X-Api-Key) — preferred
export EPICSTAFF_API_TOKEN=                          # OR a JWT bearer token (Authorization: Bearer)
export EPICSTAFF_USERNAME=                           # OR basic auth — must be paired with EPICSTAFF_PASSWORD
export EPICSTAFF_PASSWORD=                           # OR basic auth — must be paired with EPICSTAFF_USERNAME
export EPICSTAFF_MCP_PATH=/path/to/epicstaff-mcp     # only for manual `claude mcp add` / dev runs
```

> **Auth:** the backend's `JwtOrApiKeyAuthentication` treats `Bearer` as a JWT and
> reads API keys from `X-Api-Key`. Use `EPICSTAFF_API_KEY` for a long-lived
> EpicStaff API key (recommended for the MCP); use `EPICSTAFF_API_TOKEN` only for
> a short-lived JWT; or use `EPICSTAFF_USERNAME`/`EPICSTAFF_PASSWORD` (paired) for
> HTTP basic auth (`Authorization: Basic`). Set **at most one** method — the server
> rejects more than one as an ambiguous auth config.

> When installed as a plugin (`/plugin install`), `EPICSTAFF_MCP_PATH` is **not** needed —
> the bundled server runs from `${CLAUDE_PLUGIN_ROOT}` automatically. Only set it for the
> manual `claude mcp add` path or local development.

## Skills

| Skill | When to invoke |
|---|---|
| `flow-pipeline` | Building or substantially modifying a flow end to end — the gated orchestrator that conducts the skills below (interview → DDD → build → QA → intent-check) and blocks on failed gates. Start here. |
| `epicstaff-flow` | The interview → plan → build stages conducted by `flow-pipeline` (or standalone for a quick build) |
| `epicstaff` | Anytime you need MCP tool signatures, node type requirements, or critical operational rules |
| `flow-ddd` | Designing the `variables` namespace before building — DDD domain structure, node contracts |
| `flow-debugger` | When a session fails, produces wrong output, hangs, or shows broken wiring |
| `flow-qa` | After a build is complete — pre-submit validation checklist (gate G4) |
| `flow-intent-check` | Final stage — reconcile the built flow against the original interview intent (gate G5) |
| `epicchat-response` | Formatting output for the EpicChat widget (buttons, tables, navigation actions) |

> **Tool reconciliation (v2 server).** The `patch_*`, `init_flow_metadata`,
> `test_flow`, `validate_flow_paths`, `describe_flow`, `get_cdt_*`,
> `get_flow_connections`, `run_session_and_wait`, and session-debug tools are now
> registered in `combined_server.py`. Skills assume these tool names; an older
> server build will reject them.

## Reference Docs

| Domain | Doc |
|---|---|
| Flows & nodes | `docs/node-reference.md` |

> Sessions, agents/crews/tasks, tools, knowledge/RAG, and LLM-config reference material lives in the skills above (invoke `epicstaff` for tool signatures and operational rules), not in standalone docs.
