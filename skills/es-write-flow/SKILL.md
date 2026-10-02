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

## The Domain (flow state)

Every flow has ONE state object — the **Domain**. Understand it before wiring anything; most
authoring mistakes come from getting this wrong.

**Shape.** Minimal valid form is `{ "variables": {} }`. The full native envelope is:

```json
{ "variables": {}, "persistent_variables": { "user": [], "organization": [] } }
```

- `variables` is the single **root object** — all flow data lives under it. It may be empty.
- **No inner key is mandatory** — `context` is *not* required; it's optional native-editor decoration
  the compiler mirrors for parity, nothing depends on it.
- `persistent_variables.{user,organization}` are **name lists** (not value bags): the names of
  variables carried across sessions. Exactly two scopes — `user` and `organization` — nothing else.

**Edges carry control; the Domain carries data.** This is the one that trips agents up. An edge only
decides *what runs next* (a plain edge = sequence; a `condition:` edge = branch). **No data rides on
an edge.** A node reads its inputs from `variables` via `input_map` and writes its outputs back via
`output_variable_path`. A downstream node sees a value because it *reads a path an earlier node
wrote* — not because an edge connects them. Connecting `A → B` does **not** hand A's output to B; the
`input_map`/`output_variable_path` wiring does. If you connect nodes and forget the variable wiring,
the flow runs but every node sees empty inputs.

**The start node's `variables` is the authoritative Domain.** The backend rejects any run/config
`persistent_variables` key not present in it. You don't need to pre-declare produced variables:
`build_flow` auto-completes the Domain from every node's `output_variable_path`.

**Persisting a variable.** In the `variables:` section, use the object form with `persist:`:

```yaml
variables:
  topic: "AI agents"                                  # session-scoped default
  org_config: { default: {}, persist: organization }  # persists per organization
  user_prefs: { default: {}, persist: user }          # persists per organization-user
```

The compiler routes each `persist`ed name into `persistent_variables.{user,organization}`.

**Model the Domain like an object graph — a design discipline, not a runtime type system.** Structure
it the way you'd design a class model: one root object, compose by **nesting** related data into
sub-objects (not scattering many parallel top-level keys), each sub-object with one clear purpose.
This keeps the Domain legible. But know the boundary: at runtime the Domain is an **untyped dict** —
there are no real classes, no type checking, and no inheritance on the wire; it serializes to plain
nested JSON. The object model is for *your* structuring discipline; the backend enforces none of it.

## Steps

1. If no flow directory exists yet, call `init_flow` with an absolute path (suggest
   `flows/<kebab-name>/` in the user's workspace).
2. Edit `flow.yaml` to express the user's intent. Structure:
   - `meta` — name, description.
   - `variables` — declare flow-state variables here; see **The Domain** above for the model. A
     declaration is a bare default, or the object form `{ default, description?, persist? }`.
     `build_flow` checks every read resolves: a read of a variable no node produces and that isn't
     declared is an **error** (a typo); a read only set on some branches is a **warning**. Make a
     maybe-unset read OK by declaring it with a default or adding a `|default` suffix to the read.
     You need not pre-declare produced variables — the Domain auto-completes from every
     `output_variable_path`. Declare a variable to give it an initial default, a description, an
     early-read anchor, or a `persist:` scope.
   - `llm_configs` — model by name (e.g. `model: gpt-4o`); reuse `{ existing: ... }` when possible.
     Numeric bounds follow the backend: `temperature` 0–2, `max_tokens` ≥ 500, `context_window`
     (in `params`) ≥ 1000 — `build_flow` reports violations.
     A provider key goes in `api_key_env: <ENV_NAME>` (never the value): push stores it as the org
     secret `es-mcp:<ENV_NAME>`. Same for a telegram trigger's `bot_token_env`. Never name
     `EPICSTAFF_*` / `ES_MCP_*` variables there — they are the MCP server's own credentials and
     are rejected.
   - `tools` — `python_code_tools` / `mcp_tools` / `tool_configs` the agents need.
   - `knowledge` — collections with `documents:` (paths relative to the flow dir; put the
     files there) and a `rag:` strategy (`naive` or `graph`). **Author the knowledge section
     first** — before the rest of the flow — so it can be provisioned (indexing started) early
     while you finish authoring. **Freeze the knowledge inputs (documents + RAG strategy) before
     provisioning:** RAG indexing keys off the content hash of those inputs, so changing them
     after `provision_knowledge` forces the later push to re-index from scratch, wasting the
     head start.
     - Indexing knobs (all optional; omit for backend defaults): `chunk_size` / `chunk_overlap`
       on both strategies; graph RAG also takes `embedder`, `entity_types`, and `max_gleanings`.
     - For graph RAG over a domain corpus (product docs, API refs, contracts), set
       `entity_types` to match the corpus — the backend default
       `[organization, person, geo, event]` misses domain concepts, and an unextracted concept
       is invisible to graph search. Cost note: richer `entity_types` grow the graph;
       each `max_gleanings` increment adds roughly one extraction pass of LLM cost.
     - Search-time settings (result limit, similarity threshold, community level) do NOT go
       on `rag:` — they belong to the surface knowledge entry that attaches the collection
       (`naive_config` / `graph_local_search_config`).
   - `surfaces` — what each agent may touch: tools, knowledge, instructions. One-off needs
     go as `inline_surface` on the node instead of polluting the catalog.
   - `agents` — AgentDefinitions: `instructions`, `llm_config`, `default_surfaces`.
   - `flow.nodes` / `flow.edges` — the graph. Never write coordinates; layout is computed.
     Conditional routing = edge with `condition:` (python code) instead of `to:`.
     - Explicit retrieval step → `knowledge-retriever` (`collection`, `query` template with
       `{name}` placeholders filled from `input_map`, results to `output_variable_path`). For an
       `{ existing: ... }` collection also set `rag: naive|graph`.
     - Values remembered across runs → `key-value` (`table` by name — created on push if missing —
       `mode: read|write|delete`, `entries: [{ key, value }]`). Read entries write each stored value
       to their own `value` path (that is the node's output; it has no `output_variable_path`).
     - Webhook / telegram triggers are pushed without a webhook trigger (path/provider); the user
       attaches one in the EpicStaff editor, and repushes keep it.
3. Call `describe_node_types` for the catalog of node types — each type's fields plus runtime
   caveats the compiler can't catch (e.g. classification-decision-table does not reliably classify;
   decision-table conditions use `variables['x']['y']` dict access). It's offline, so consult it
   whenever a node type is unfamiliar. Never use node types `llm`, `code-agent` or `crew` — EpicStaff
   removed them and the loader rejects them; model crew-style work as an `agent` node with ordered
   `tasks:` (or `task` nodes).
4. Call `validate_flow` and fix every error (path-located). Repeat until clean.

Done when: `validate_flow` returns valid (warnings reviewed, not ignored silently).
Hand off to `es-push-flow` to materialize it.
