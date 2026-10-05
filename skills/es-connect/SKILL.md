---
name: es-connect
description: Connect to EpicStaff and select the working organization. Use at the start of any EpicStaff flow work, or when tools fail with auth/organization errors.
---

# Connect to EpicStaff

One responsibility: a working, org-scoped connection. Every other es-* skill assumes this ran.

1. Call `check_connection`. It validates (or mints) the API key and resolves organizations.
2. If the result lists exactly one organization, it is auto-selected — done.
3. If several: show the user the organizations by name and ask which to use, then call
   `set_active_organization` with the chosen id. Never pick silently — entities are created
   inside the active organization.
4. If `check_connection` fails: report the error hint verbatim. Auth failures mean a wrong
   `EPICSTAFF_API_TOKEN` or `EPICSTAFF_USERNAME`/`EPICSTAFF_PASSWORD` in the plugin's MCP
   environment — the user must fix the env, not the flow. "Invalid EpicStaff MCP configuration"
   means those variables are not set (or reached the server as an unexpanded `${VAR}`): the
   user exports them in the shell that launches Claude Code and restarts it. Local tools
   (`init_flow`, `validate_flow`, `build_flow`) work without a connection.

A new session does not strictly need step 1 to reach the right organization — the server
resolves the saved selection (or the single membership) before its first org-scoped call —
but run it anyway: it is the cheapest way to surface auth problems early.

Done when: `check_connection` succeeds and `activeOrgId` is set.
