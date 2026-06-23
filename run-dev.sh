#!/usr/bin/env bash
# Launch Claude Code with the LIVE dev plugin (epicstaff-mcp-dev).
#
# Loads the working tree directly (no marketplace cache), so edits to the MCP
# server or skills apply after `/reload-plugins`. Points the MCP at the local
# EpicStaff backend on :8000.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

# EPICSTAFF_API_KEY (the admin-owned key from SuperadminBootstrap) is read from
# an untracked file so it never lands in git. See .dev-secrets.example.
if [ -f "$REPO/.dev-secrets" ]; then
  # shellcheck disable=SC1091
  . "$REPO/.dev-secrets"
fi

if [ -z "${EPICSTAFF_API_KEY:-}" ] && [ -z "${EPICSTAFF_API_TOKEN:-}" ]; then
  echo "WARNING: no EPICSTAFF_API_KEY/EPICSTAFF_API_TOKEN set — the backend requires auth." >&2
  echo "  Put 'export EPICSTAFF_API_KEY=<key>' in $REPO/.dev-secrets (see .dev-secrets.example)." >&2
fi

export EPICSTAFF_API_KEY EPICSTAFF_API_TOKEN
exec claude --plugin-dir "$REPO/dev-plugin" "$@"
