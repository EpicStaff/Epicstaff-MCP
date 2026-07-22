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
   Repushing updates in place — the lockfile (`flow.lock.json`) maps names to backend ids.
   Knowledge that is unchanged since the last push (same documents + RAG strategy → same content
   hash) is reported `reused` and is **not** re-indexed; a collection re-indexes only when its
   documents or RAG config actually changed. If the flow has knowledge, prefer calling
   `provision_knowledge` early (before the flow is fully authored) to start the slow indexing
   sooner — this push then reuses those collections instead of indexing from scratch.
5. Report: graph id, what was created vs updated, and the editor link from the response.
   Suggest opening the flow in the EpicStaff editor to see it.
6. Commit `flow.lock.json` together with the flow source — it is the identity map.

On validation errors from the backend: the response lists field/reason pairs — map them
back to the flow source, fix, and repush.

Done when: `push_flow` succeeds and the user knows the graph id / editor link.
