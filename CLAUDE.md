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

## Versioning & Releases (developers)

This MCP is maintained **release-for-release with EpicStaff**. The rule is simple and
the same one users see in the README:

- **MCP `major.minor` mirrors the EpicStaff `major.minor` it targets.** MCP for EpicStaff
  `1.1.x` is versioned `1.1.x`. The MCP **patch** number is independent — bump it for
  MCP-only fixes that still target the same EpicStaff minor.
- The supported range is declared in `.claude-plugin/plugin.json` →
  `"epicstaffCompatibility"` (e.g. `">=1.1.0 <1.2.0"`). Keep `version` (here and in
  `pyproject.toml`) and this field in lockstep.

**Compatibility matrix (source of truth — keep README's copy identical):**

| MCP version | EpicStaff release | Git tag |
|---|---|---|
| `1.0.x` | `1.0.4` – `1.0.12` | `v1.0.0` (frozen at `95bce38`) |
| `1.1.x` | `1.1.0` – `1.1.x` | `v1.1.0` |

**When EpicStaff cuts a new release** (e.g. `1.2.0`):

1. Test the current MCP against the new backend; note every API/contract change.
2. Update tools/skills to match, then bump `version` in `pyproject.toml` **and**
   `.claude-plugin/plugin.json`, and update `epicstaffCompatibility`
   (`>=1.2.0 <1.3.0`).
3. Add a matrix row **here and in README** (keep both tables identical).
4. Tag the release commit `vMAJOR.MINOR.PATCH` (annotated) and push the tag.
5. If the change is only an MCP bugfix against the *same* EpicStaff minor, bump the
   **patch** only — don't touch `major.minor` or `epicstaffCompatibility`.

> Older EpicStaff minors are **frozen, not actively maintained** — they keep working via
> their pinned tag (e.g. `v1.0.0`). We move forward with EpicStaff rather than backporting.

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

> **Tool reconciliation (1.1.x server).** The `patch_*`, `init_flow_metadata`,
> `test_flow`, `validate_flow_paths`, `describe_flow`, `get_cdt_*`,
> `get_flow_connections`, `run_session_and_wait`, and session-debug tools are now
> registered in `combined_server.py`. Skills assume these tool names; an older
> server build will reject them.

## Reference Docs

| Domain | Doc |
|---|---|
| Flows & nodes | `docs/node-reference.md` |

> Sessions, agents/crews/tasks, tools, knowledge/RAG, and LLM-config reference material lives in the skills above (invoke `epicstaff` for tool signatures and operational rules), not in standalone docs.
