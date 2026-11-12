---
name: es-admin
description: Administer an EpicStaff instance and workspace — the configured user's account and personal API keys, first-run setup of a fresh instance, users, organization memberships, roles, everyone's API keys, organizations, plugins (discovery, grants, suspend, uninstall) and the audit trail (search, saved presets). Use when the user asks who has access to what, to onboard/offboard people, change roles or permissions, issue/revoke API keys, manage plugins, look into what ran (audit), or set up a brand-new instance. Not for building flows.
---

# Administer EpicStaff

One responsibility: **who may do what, and what happened** — accounts, access, credentials, plugins,
audit. Nothing here touches flow source.

Connect first (`es-connect`) — except on a brand-new instance, where `check_connection` cannot log in
yet: then start at **First-run setup**.

## Ground rules (security)

- **Act only on an explicit request that names the change.** Every change below takes `confirm: true`;
  pass it only when the user asked for exactly that change (that person, that role, that key). Never
  "tidy up" access on your own initiative. Reads and `dry_run` need no confirm.
- **Preview before removing.** `admin_delete_role`, `admin_set_plugin_grant_state` (suspend) and
  `admin_uninstall_plugin` take `dry_run: true` — run it, show the user who/what is affected, then do
  the real change.
- **Credentials never enter the conversation.** A new API key (`create_my_api_key`) and a new account's
  initial password (`admin_create_user`) are written to a **new file** (mode 0600) at a path the user
  chooses; the result names the file, never the secret. Never `cat`/read such a file back into the chat
  — tell the user where it is. The audit token is minted and used internally; it never appears.
- **Changes need a signed-in session.** EpicStaff lets an API key only *read* the admin surface. With
  `EPICSTAFF_API_TOKEN` only, every change below is refused before anything is sent — the user sets
  `EPICSTAFF_USERNAME` / `EPICSTAFF_PASSWORD` or does it in the UI. Such a key is bound to one
  organization, and its reads see only that organization.
- **404 is not "missing" on the admin surface.** A record in an organization the user cannot administer
  answers 404, never 403 — say "not found or not yours to administer", don't guess. A 403 names the right
  that is missing (superadmin, or e.g. `memberships: create` in that organization).
- **The MCP's own key is protected.** `revoke_my_api_key` / `admin_revoke_api_key` refuse the key this
  server runs on (marked `in_use_by_mcp` in `list_my_api_keys`).

## Who can do what

| Area | Who | Tools |
|---|---|---|
| Own account | anyone | `get_my_account`, `update_my_profile`, `list_my_api_keys`, `create_my_api_key`, `revoke_my_api_key` |
| Members of an organization | `memberships` permission there (Org Admin) | `admin_list_memberships`, `admin_add_membership`, `admin_change_membership_role`, `admin_remove_membership` |
| Roles | `roles` permission there | `admin_list_roles` (`include_catalog` for resource types and actions), `admin_get_role`, `admin_create_role`, `admin_update_role`, `admin_delete_role` |
| Everyone's API keys | `api_keys` permission | `admin_list_api_keys`, `admin_revoke_api_key` |
| Accounts | superadmin | `admin_list_users`, `admin_create_user`, `admin_set_user_active`, `admin_set_user_superadmin` |
| Organizations | list / rename: `organizations` permission; create / (de)activate: superadmin | `admin_list_organizations`, `admin_create_organization`, `admin_rename_organization`, `admin_set_organization_active` |
| Plugins in the active organization | members; activity and service accounts need `audit: read` | `list_plugins`, `list_plugin_activity` |
| Plugin administration | superadmin | `admin_list_plugins`, `admin_grant_plugin`, `admin_set_plugin_grant_state`, `admin_uninstall_plugin`, `admin_reinstall_plugin`, `list_plugin_activity(all_organizations)` |
| Audit trail | `audit: read` in the active organization | `search_audit_log`, `list_audit_presets`, `create_audit_preset`, `update_audit_preset`, `delete_audit_preset` |
| First-run setup | the instance owner, once | `get_setup_status`, `complete_first_setup` |

`get_my_account` shows the user's effective permissions per organization — check it when unsure whether
a change will be allowed.

Admin tools are **cross-organization**: pass `organization` (id or name) explicitly; the active
organization (`set_active_organization`) is not used for them. Plugins-in-org, audit and presets *are*
scoped to the active organization.

## Common tasks

**Onboard a person.** Existing account → `admin_add_membership(user: email, organization, role)`.
No account yet (superadmin) → `admin_create_user(email, organization, role, password_file)`; hand the
file to the person, then they change the password. Built-in roles: Org Admin, Member, Viewer.

**Offboard.** One organization → `admin_remove_membership(user, organization)`. Whole instance
(superadmin) → `admin_set_user_active(user, active: false)` — sign-in, sessions and API keys stop;
nothing is deleted. Check `admin_list_api_keys(owner_id)` for keys an app might still depend on.

**Custom role.** `admin_list_roles(include_catalog: true)` → pick resource types and actions →
`admin_create_role(organization, name, permissions: { "flows": ["read", "use"], ... })`. A role cannot
grant more than you hold. `admin_update_role(permissions)` **replaces** the whole set for every holder.

**API key for an app** (e.g. a UI built on EpicStaff, see `es-deliver`): `create_my_api_key(name,
output_file: "<app>/.env.epicstaff", env_var_name: "EPICSTAFF_API_KEY")` — always a NEW file (an existing
one is refused); the app loads it and sends the key as `X-Api-Key`. It acts with all of the user's
permissions; prefer a dedicated user with a narrow role for production apps.

**Plugins.** `list_plugins` — what members can open. `admin_list_plugins(plugin)` — what a plugin's
package declares it may do in an organization (resource → actions, outbound hosts, public paths,
review warnings): read it before `admin_grant_plugin`. Suspend a grant to stop a plugin in one
organization; uninstall stops it everywhere (data kept until `data_kept_until`, then deleted for good —
`admin_reinstall_plugin` before that brings it back). Plugins add **no flow node types**: a flow has no
plugin node; a plugin backend drives EpicStaff through its API (it can run flows) within its declared
access.

**What happened?** `search_audit_log(query: 'status = "failed" and flow_name : "Quote"')` — rows are
sessions, node runs and events with inputs/outputs; add `match_scope: { ancestors: true }` to see the
owning session/node, or `{ full_session_history: true }` for whole runs. Page with `cursor`. Save a
useful search with `create_audit_preset` and reuse it via `search_audit_log(preset)`. Long values come
back cut at 2000 characters. If the auditor is unreachable, the deployment has the audit trail off or
`EPICSTAFF_BASE_URL` points past the web entry point.

## First-run setup

On a fresh instance `check_connection` fails to log in. `get_setup_status`:
- `needs_setup: true` → **only if the owner asks**, `complete_first_setup(confirm: true)` makes the
  account in `EPICSTAFF_USERNAME` / `EPICSTAFF_PASSWORD` the first **superadmin** (plus the default
  organization); then `check_connection`. The backend refuses it once any account exists.
- `needs_setup: false` with `setup_mode: cli_only` → the HTTP setup is closed (the safe default):
  the superadmin is created on the server with the `create_superadmin` management command.

## Deliberately not available here (use the EpicStaff UI)

Hard deletes of users and organizations, plugin/grant purges and backup restores (irreversible; the UI
makes a person type a verification phrase), plugin package upload/approval (installing third-party code
is a human review), plugin settings/limits/restart/development mode, password resets and changes,
reset-user, and retention settings.

Done when: the requested change is confirmed by the tool result (the new state is in it), and the
user knows where any written credential file is.
