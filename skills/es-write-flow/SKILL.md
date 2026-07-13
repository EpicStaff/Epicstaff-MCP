---
name: es-write-flow
description: Author or edit an EpicStaff flow as local flow-source files from a natural-language description. Use when the user wants to create a new flow or change an existing local one.
---

# Write a flow (local source)

One responsibility: produce a clean, valid flow-source directory. No pushing here.

## Reuse first — always discover before defining

Before writing any entity definition, check what already exists:
`list_agents`, `list_surfaces`, `list_llm_configs`, `list_tools`, `list_source_collections`.
Reference remote entities with `{ existing: "<name>" }` instead of redefining them.
Define locally only what doesn't exist — and tell the user what will be created vs reused.

## Steps

1. If no flow directory exists yet, call `init_flow` with an absolute path (suggest
   `flows/<kebab-name>/` in the user's workspace).
2. Edit `flow.yaml` to express the user's intent. Structure:
   - `meta` — name, description.
   - `llm_configs` — model by name (e.g. `model: gpt-4o`); reuse `{ existing: ... }` when possible.
   - `tools` — `python_code_tools` / `mcp_tools` / `tool_configs` the agents need.
   - `knowledge` — collections with `documents:` (paths relative to the flow dir; put the
     files there) and a `rag:` strategy (`naive` or `graph`).
   - `surfaces` — what each agent may touch: tools, knowledge, instructions. One-off needs
     go as `inline_surface` on the node instead of polluting the catalog.
   - `agents` — AgentDefinitions: `instructions`, `llm_config`, `default_surfaces`.
   - `flow.nodes` / `flow.edges` — the graph. Never write coordinates; layout is computed.
     Conditional routing = edge with `condition:` (python code) instead of `to:`.
3. Never use node types `llm` (legacy) or `code-agent` (deprecated). Avoid `crew` unless
   the user explicitly wants the deprecated crew path.
4. Call `validate_flow` and fix every error (path-located). Repeat until clean.

Done when: `validate_flow` returns valid (warnings reviewed, not ignored silently).
Hand off to `es-push-flow` to materialize it.
