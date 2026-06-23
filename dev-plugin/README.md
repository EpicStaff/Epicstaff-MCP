# epicstaff-mcp-dev — live dev plugin

A **test/dev build** of the EpicStaff plugin that loads this repo's working tree
directly (no marketplace cache), so you can iterate from Claude Code and apply
changes with `/reload-plugins` instead of reinstalling.

It coexists with the released `epicstaff-mcp` plugin via distinct names:

| | Released | Dev (this) |
|---|---|---|
| Plugin name | `epicstaff-mcp` | `epicstaff-mcp-dev` |
| MCP server | `epicstaff` | `epicstaff-dev` |
| Tools prefix | `mcp__plugin_epicstaff-mcp_epicstaff__*` | `mcp__plugin_epicstaff-mcp-dev_epicstaff-dev__*` |
| Source | cached copy in `~/.claude/plugins/cache/` | **live working tree** |

## How it works
- `.mcp.json` runs `uv run --project ${CLAUDE_PLUGIN_ROOT}/.. epicstaff-mcp` —
  i.e. the repo's MCP server straight from source.
- `skills/` is a symlink to `../skills`, so the dev plugin serves the same
  (live) skills you edit in the repo.
- `EPICSTAFF_BASE_URL` is pinned to `http://localhost:8000`; the API key comes
  from the environment (see below).

## Use it

```bash
# 1. Backend must be running:  cd ../EpicStaff-main && make dev
# 2. Put the admin API key in .dev-secrets (gitignored):
cp .dev-secrets.example .dev-secrets   # then edit, or it's already filled locally
# 3. Launch Claude Code with the live dev plugin:
./run-dev.sh
```

`run-dev.sh` sources `.dev-secrets` and runs `claude --plugin-dir dev-plugin`.

## Update loop (the whole point)
1. Edit MCP server code under `epicstaff_mcp/` or any skill under `skills/`.
2. In Claude Code: **`/reload-plugins`** — restarts the MCP subprocess and
   reloads skills/metadata. No reinstall, no cache.
3. Test the change immediately.

> The released `epicstaff-mcp` plugin may still be active (its skills are
> namespaced separately). To avoid duplicate skills/tools while developing,
> disable it for the session: `/plugin disable epicstaff-mcp@epicstaff`.

## Notes
- The `EPICSTAFF_API_KEY` is an admin-owned key minted on the dev backend; it
  does **not** survive `make clean` (DB reset). Re-mint via `SuperadminBootstrap`
  and update `.dev-secrets`.
- This dev plugin is committed so teammates can use the same loop; the secret
  (`.dev-secrets`) is gitignored.
