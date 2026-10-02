---
name: es-push-flow
description: Push a local flow source to EpicStaff — create/update the entity tree and the graph. Use after the flow builds clean, or to sync local edits to the server.
---

# Push a flow to EpicStaff

One responsibility: materialize the local flow on the server, safely.

1. Ensure connection (`check_connection`; run es-connect if it fails).
2. Call `diff_flow` first and show the user what would happen: entities to
   create/update/reuse, and whether the remote graph changed since the last push.
3. If the diff shows a REMOTE CHANGED conflict: stop. Ask the user — pull the remote
   changes (es-pull-flow) or overwrite (`push_flow` with `force: true`). Never force
   silently.
4. Call `push_flow`. It upserts entities in dependency order, uploads new/changed
   knowledge documents, attaches RAG, and bulk-saves the graph with the computed layout.
   Repushing updates in place — the lockfile (`flow.lock.json`) maps names to backend ids. A
   push with nothing to change reports `changed: false` / "no changes" and does not touch the
   graph (its `save_version` stays put). If the lockfile's graph no longer exists (deleted in the
   editor, or a lockfile from another instance), push recreates it, re-verifies the locked entity
   ids, and says so in `warnings` — relay that to the user. If push then reports that an entity
   "already exists in this organization, and flow.lock.json does not point at it", do not work
   around it: ask the user whether to reuse it (`{ existing: "<name>" }`), pull the flow that owns
   it, or rename it in the source (knowledge collections included — push never uploads into a
   same-named collection it did not create). A lockfile pointing at a graph whose name differs
   from `meta.name` is refused (even with `force`): the directory may be a copy of another flow.
   Ask the user. Only if they confirm they renamed THIS flow, repush with `rename: true` (renames
   the remote graph and updates the lockfile); if it is a new flow, delete its `flow.lock.json`.
   A `warnings` entry about "several nodes with the same name" means the remote graph had
   duplicate nodes (e.g. edited in the UI); push kept the locked copy and deleted the others —
   tell the user.
   Knowledge that is unchanged since the last push (same documents + RAG strategy → same content
   hash) is reported `reused` and is **not** re-indexed; a collection re-indexes only when its
   documents or RAG config actually changed. If the flow has knowledge, prefer calling
   `provision_knowledge` early (before the flow is fully authored) to start the slow indexing
   sooner — this push then reuses those collections instead of indexing from scratch.
   Credentials named by `api_key_env` / `bot_token_env` are read from the MCP server environment
   and stored as org secrets `es-mcp:<ENV_NAME>` (reused by name on repush). The server's own
   variables (`EPICSTAFF_*`, `ES_MCP_*`) are refused as credential sources. EpicStaff only lets a
   signed-in user manage secrets, so this needs `EPICSTAFF_USERNAME` / `EPICSTAFF_PASSWORD`. If push
   reports that a secret "holds a different value", the env value was rotated: secrets are
   immutable — ask the user to delete that secret in EpicStaff, then repush.
   Key-value tables named by `key-value` nodes are found by name and created if missing.
5. Report: graph id, what was created vs updated, and the editor link from the response.
   Suggest opening the flow in the EpicStaff editor to see it.
6. Commit `flow.lock.json` together with the flow source — it is the identity map.

On validation errors from the backend: the response lists field/reason pairs — map them
back to the flow source, fix, and repush.

Done when: `push_flow` succeeds and the user knows the graph id / editor link.
