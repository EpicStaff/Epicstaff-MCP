# EpicStaff MCP — Claude Code Plugin

EpicStaff MCP gives Claude Code tools to manage flows, agents, sessions, knowledge, and more via the EpicStaff REST API.

## Setup

Set these environment variables (once, in your shell profile):

```bash
export EPICSTAFF_MCP_PATH=/path/to/epicstaff-mcp   # path to this cloned repo
export EPICSTAFF_BASE_URL=http://localhost:8000      # EpicStaff backend URL
export EPICSTAFF_API_TOKEN=                          # optional Bearer token
```

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
| Sessions | `docs/sessions-reference.md` |
| Agents, crews, tasks | `docs/agents-crews-tasks-reference.md` |
| Tools (MCP/Python) | `docs/tools-reference.md` |
| Knowledge / RAG | `docs/knowledge-reference.md` |
| LLM & embedding configs | `docs/llm-configs-reference.md` |
