# epicstaff-mcp — Claude Code Setup

## Install the MCP server

Run this command once to register the server with Claude Code:

```bash
claude mcp add epicstaff \
  -e EPICSTAFF_BASE_URL=http://localhost:8000 \
  -e EPICSTAFF_API_TOKEN=your-token \
  -- uvx --from git+https://github.com/EpicStaff/epicstaff-mcp.git epicstaff-mcp
```

Replace `http://localhost:8000` with your EpicStaff instance URL and `your-token` with your API token.

After running this, restart Claude Code and the `epicstaff` MCP server will be available.

## Verify the install

```bash
claude mcp get epicstaff
```

## Auth options

**API token** (recommended):
```bash
-e EPICSTAFF_API_TOKEN=your-token
```

**Username / password**:
```bash
-e EPICSTAFF_USERNAME=admin -e EPICSTAFF_PASSWORD=secret
```

## Remove

```bash
claude mcp remove epicstaff
```

## Working in this repo

The `.mcp.json` in this repo configures the server for project-scoped use. Claude Code will prompt you to approve it when you open the project. Set `EPICSTAFF_BASE_URL` (and optionally `EPICSTAFF_API_TOKEN`) in your environment before opening Claude Code, or edit `.mcp.json` directly with your values.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `EPICSTAFF_BASE_URL` | yes | — | EpicStaff instance URL |
| `EPICSTAFF_API_TOKEN` | no | — | Bearer token |
| `EPICSTAFF_USERNAME` | no | — | Basic auth username |
| `EPICSTAFF_PASSWORD` | no | — | Basic auth password |
| `EPICSTAFF_TIMEOUT` | no | `30.0` | Request timeout (seconds) |
| `EPICSTAFF_MAX_RETRIES` | no | `3` | Retries on transient errors |
