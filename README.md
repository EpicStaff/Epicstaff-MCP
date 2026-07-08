# epicstaff-mcp

MCP server for [EpicStaff](https://github.com/EpicStaff/EpicStaff) — control your AI agents, flows, crews, and knowledge bases from Claude, Cursor, and any MCP-compatible tool.

## Requirements

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- A running EpicStaff instance
- GitHub access to this repository

## Installation

### With uv (recommended — no manual install)

`uvx` pulls and runs the package directly from the private repo:

```bash
uvx --from git+https://github.com/EpicStaff/epicstaff-mcp.git epicstaff-mcp
```

### With pip

```bash
pip install git+https://github.com/EpicStaff/epicstaff-mcp.git
```

> **Private repo access:** make sure your GitHub credentials or SSH key are configured so `git clone` works for this repo. On macOS, `gh auth login` is the easiest way.

## Claude Code

### As a plugin (recommended — tools **and** skills)

Installing as a plugin brings the MCP tools **and** the bundled skills (`/skills` →
flow building, DDD design, QA, debugging, EpicChat output) online together:

```
/plugin marketplace add EpicStaff/epicstaff-mcp
/plugin install epicstaff-mcp@epicstaff
```

Set `EPICSTAFF_BASE_URL` (and optionally `EPICSTAFF_API_TOKEN`) in your shell profile so
the bundled MCP server can reach your instance.

### As a bare MCP server (tools only — no skills)

If you only want the tools and not the skills:

```bash
claude mcp add epicstaff \
  -e EPICSTAFF_BASE_URL=http://localhost:8000 \
  -e EPICSTAFF_API_TOKEN=your-token \
  -- uvx --from git+https://github.com/EpicStaff/epicstaff-mcp.git epicstaff-mcp
```

> A bare MCP server never loads a `skills/` directory — that's why the plugin path above is
> recommended if you want the EpicStaff workflows.

See [CLAUDE.md](CLAUDE.md) for full Claude Code setup instructions.

## Claude Desktop

Add to `claude_desktop_config.json` (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "epicstaff": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/EpicStaff/epicstaff-mcp.git",
        "epicstaff-mcp"
      ],
      "env": {
        "EPICSTAFF_BASE_URL": "http://localhost:8000",
        "EPICSTAFF_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "epicstaff": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/EpicStaff/epicstaff-mcp.git",
        "epicstaff-mcp"
      ],
      "env": {
        "EPICSTAFF_BASE_URL": "http://localhost:8000",
        "EPICSTAFF_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Configuration

All settings are read from environment variables (prefix: `EPICSTAFF_`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `EPICSTAFF_BASE_URL` | yes | — | Base URL of your EpicStaff instance, e.g. `http://localhost:8000` |
| `EPICSTAFF_API_TOKEN` | no | — | JWT sent as `Authorization: Bearer <token>` (the backend rejects HTTP Basic) |
| `EPICSTAFF_USERNAME` | no | — | Login email — performs a JWT login + auto-refresh, exactly like the EpicStaff frontend (must be paired with `EPICSTAFF_PASSWORD`) |
| `EPICSTAFF_PASSWORD` | no | — | Login password (paired with `EPICSTAFF_USERNAME`) |
| `EPICSTAFF_TIMEOUT` | no | `30.0` | HTTP request timeout in seconds |
| `EPICSTAFF_MAX_RETRIES` | no | `3` | Number of retries on transient errors |

Set either `EPICSTAFF_API_TOKEN` **or** `EPICSTAFF_USERNAME`/`EPICSTAFF_PASSWORD` — not both.

The backend (`JwtOrApiKeyAuthentication`) accepts only `Authorization: Bearer <JWT>`, `X-Api-Key`, or `ApiKey` — it does **not** accept HTTP Basic. With `EPICSTAFF_USERNAME`/`EPICSTAFF_PASSWORD` the client logs in against `POST /api/auth/login/`, sends the returned access token as `Bearer`, and transparently refreshes it via `POST /api/auth/refresh/` (re-logging in if the refresh token has also expired) — the same JWT flow the frontend uses. With `EPICSTAFF_API_TOKEN`, pass a JWT; it is sent as `Bearer` verbatim with no login/refresh.

### Active organization (RBAC)

The EpicStaff backend is org-scoped: org-scoped endpoints resolve the active organization
from the `X-Organization-Id` request header. There is no env var to configure this — it's
resolved automatically, the same way the EpicStaff frontend bootstraps: on first org-scoped
call, the client reads `GET /api/profile/` and adopts the current user's first organization
membership as the default. Superadmins with no memberships get no default and must switch
explicitly.

| Tool | Description |
|---|---|
| `list_my_organizations` | List the organizations the current user belongs to, alongside the active org id |
| `set_active_organization` | Switch the active org used for the `X-Organization-Id` header on subsequent calls (validates membership; superadmins may switch to any org) |
| `get_active_organization` | Get the current active org id plus the caller's organization roster |
| `clear_active_organization` | Clear the runtime override, falling back to the auto-resolved default |

## Available Tools

### Agents
| Tool | Description |
|---|---|
| `list_agents` | List all agents (pagination + search) |
| `get_agent` | Get agent details by ID |
| `create_agent` | Create a new agent |
| `update_agent` | Update an existing agent |
| `delete_agent` | Delete an agent |

### Agent Definitions
The CrewAI-replacement first-class agent entity (`/api/agent-definitions/`), distinct from the legacy Crew agents above.

| Tool | Description |
|---|---|
| `list_agent_definitions` | List all agent definitions |
| `get_agent_definition` | Get an agent definition by ID |
| `create_agent_definition` | Create a new agent definition |
| `update_agent_definition` | Update an existing agent definition |
| `delete_agent_definition` | Delete an agent definition |

### Surfaces
Resource bundles (tools + storage files + knowledge collections with allow/deny) attached to agents/nodes (`/api/surfaces/`).

| Tool | Description |
|---|---|
| `list_surfaces` | List all surfaces |
| `get_surface` | Get a surface by ID |
| `create_surface` | Create a new surface |
| `update_surface` | Update an existing surface |
| `delete_surface` | Delete a surface |
| `combine_surfaces` | Merge multiple surfaces into a CombinedSurface |

### Crews
| Tool | Description |
|---|---|
| `list_crews` | List all crews |
| `get_crew` | Get crew details by ID |
| `create_crew` | Create a new crew and assign agents |
| `update_crew` | Update an existing crew |
| `delete_crew` | Delete a crew |

### Flows
| Tool | Description |
|---|---|
| `list_flows` | List all flows (lightweight, no node detail) |
| `get_flow` | Get full flow with all nodes and edges |
| `create_flow` | Create a new empty flow |
| `update_flow_metadata` | Update flow name / description / settings |
| `get_flow_nodes` | List all nodes in a flow by type |
| `add_node` | Add a node to a flow |
| `update_node` | Update a node's configuration |
| `delete_node` | Delete a node from a flow |
| `list_edges` | List edges and conditional edges for a flow |
| `add_edge` | Connect two nodes with an edge |
| `delete_edge` | Delete an edge |

### Sessions
| Tool | Description |
|---|---|
| `list_sessions` | List sessions for a flow |
| `run_session` | Start a new session for a flow |
| `get_session_updates` | Poll for session output and status |
| `stop_session` | Stop a running session |
| `send_message` | Send a message to a session waiting for human input |

### Tools
| Tool | Description |
|---|---|
| `list_tools` | List all MCP and Python code tools |
| `get_tool` | Get tool details by ID |
| `create_mcp_tool` | Add a new MCP tool connection |
| `create_python_tool` | Add a new Python code tool |
| `update_mcp_tool` | Update an existing MCP tool |
| `update_python_tool` | Update an existing Python code tool |
| `delete_tool` | Delete a tool |

### Knowledge (RAG)
| Tool | Description |
|---|---|
| `list_source_collections` | List all knowledge collections |
| `create_source_collection` | Create a new knowledge collection |
| `add_document` | Add a document to a collection |
| `trigger_rag_indexing` | Trigger embedding and vector indexing |

### LLM Configs
| Tool | Description |
|---|---|
| `list_llm_configs` | List all LLM configurations |
| `get_llm_config` | Get an LLM config by ID |
| `create_llm_config` | Create a new LLM configuration |
| `update_llm_config` | Update an existing LLM configuration |
| `delete_llm_config` | Delete an LLM configuration |
| `list_embedding_configs` | List all embedding configurations |
| `create_embedding_config` | Create a new embedding configuration |

### Health & Config
| Tool | Description |
|---|---|
| `ping` | Check if EpicStaff is reachable |
| `list_providers` | List available LLM providers |

## License

MIT
