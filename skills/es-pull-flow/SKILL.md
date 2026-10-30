---
name: es-pull-flow
description: Import an existing EpicStaff flow into local flow-source files for iteration. Use to edit a flow that was built in the visual editor, or to resolve a push conflict.
---

# Pull a flow from EpicStaff

One responsibility: a faithful local flow-source copy of a remote flow, with its lockfile.

1. Find the graph: `list_graphs`, confirm with the user by name; `describe_graph` to
   preview its structure.
2. Call `pull_flow` with the graph id and a target directory (absolute path; must not
   already contain a flow).
3. It decompiles the graph + its referenced entities (agent-definitions, surfaces,
   llm-configs, tools, knowledge) into flow-source YAML and seeds `flow.lock.json`,
   so a subsequent unchanged push is a no-op. A python node's virtual environment comes
   back as `venv: "<name>"`. The result's `authorship` says who created and last edited the
   flow and each node (with its `#N` node_number) — read-only, so it is reported (and the
   flow-level authors written as a comment atop `flow.yaml`), never pushed. Mention it when
   the user asks who changed what.
   - Before editing a production flow, `create_graph_version` snapshots it; if an edit goes
     wrong, `restore_graph_version` rolls the remote flow back (then pull again).
4. Verify: run `diff_flow` — it should report everything as reuse / no changes.
   If it doesn't, report the drift to the user before editing anything.
5. Hand off to es-write-flow for edits, es-push-flow to sync back.

Done when: the flow exists locally and `diff_flow` confirms a clean no-op baseline.
