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
4. If `check_connection` fails: report the error hint verbatim. Auth failures mean wrong
   `ES_EMAIL`/`ES_PASSWORD` in the plugin's MCP environment — the user must fix the env,
   not the flow.

Done when: `check_connection` succeeds and `activeOrgId` is set.
