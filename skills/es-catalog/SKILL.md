---
name: es-catalog
description: Manage the reusable org catalog and configuration — agents, surfaces, knowledge collections, python/MCP tools, venvs, LLM/embedding configs and defaults, secrets, key-value tables, labels — standalone, without authoring a flow; plus the recycle bin, flow versions, copy, delete and import/export. Use to create/update/delete org entities that flows then reference, or to seed shared building blocks before writing flows.
---

# Manage the catalog (standalone entities)

One responsibility: create, update, and delete the org-scoped catalog — **agents**,
**surfaces**, **knowledge collections** — **without** authoring a flow. Flows reference
these later by name via `{ existing: "<name>" }`. No graph is built here.

Connect first: run `es-connect` (auth + active organization) before any catalog tool.
Every catalog entity lives in exactly one organization and names are org-unique.

## When to build standalone vs inline in a flow

Build it **standalone with these tools** when the entity is **reusable** — shared across
several flows, or a durable org asset you want to manage on its own lifecycle:

- An **agent** used by more than one flow, or maintained as a first-class team asset.
- A **surface** shared by multiple agents/flows (a common tool/knowledge bundle).
- A **knowledge collection** that several flows retrieve from, or a corpus you grow over
  time independent of any single flow.

Keep it **inline in the flow source** (via `es-write-flow`) when it is **one-off** and
scoped to a single flow: a node's `inline_surface`, an agent only that flow uses, a
collection built from documents that live with the flow. Inline entities are simpler and
travel with the flow; standalone entities are the right call the moment a second flow needs
the same thing.

Rule of thumb: **reuse first.** Before creating anything, discover what already exists with
`list_agents`, `list_surfaces`, `list_source_collections`, `list_llm_configs`, `list_tools`.
Create standalone only what is genuinely shared and missing.

## Always reference the catalog from flows via `existing:`

A flow must never redefine a catalog entity it should reuse. In flow source, point at a
catalog entity by name:

```yaml
agents:
  researcher: { existing: "Researcher" }      # the standalone AgentDefinition
surfaces:
  shared_docs: { existing: "ResearchDocs" }    # the standalone surface
```

`push_flow` resolves each `existing:` to the remote entity by name and never modifies it.
This is why **renaming or deleting a catalog entity breaks every flow that references it** —
the next push of those flows fails because the name no longer resolves.

## Reference resolution — id or name

Every reference input accepts **either a backend id (number) or the exact existing name
(string)**, resolved case-insensitively:

- `create_agent` / `update_agent`: `llm_config`, `fcm_llm_config`, `default_surfaces[].surface`
- `create_surface` / `update_surface`: `owner_agent`, `python_tools[].tool`, `mcp_tools[].tool`,
  `knowledge[].collection`
- `create_collection` / `attach_rag`: `embedder`, `llm_config`

When a name doesn't resolve, the tool returns a clear error listing what is available. Prefer
names for authored intent; use ids when you already have them from a `list_*` call.

## The surface ↔ agent connect recipe

A surface and its owning agent reference each other, so build them in this order to avoid a
chicken-and-egg problem:

1. `create_surface` — create the surface first, **without** `owner_agent` (shared for now).
2. `create_agent` — create the agent with `default_surfaces: [<surface id or name>]` so it
   attaches the surface.
3. `update_surface` — set `owner_agent: <agent id or name>` to make the surface
   **agent-specific** (only that agent may attach it). Skip this step to leave it shared.

If you instead created the agent first, you can create the surface with `owner_agent` set
directly and then `update_agent(default_surfaces:[...])` — same two links, either order works
as long as both ends get wired.

## Knowledge collections must finish indexing before a flow can retrieve

Both tools take optional indexing knobs (omit for backend defaults): `chunk_size` /
`chunk_overlap` on either strategy; graph RAG also takes `entity_types` and `max_gleanings`.
For a domain corpus (product docs, API refs, contracts), set `entity_types` to match it — the
backend default `[organization, person, geo, event]` misses domain concepts, and an
unextracted concept is invisible to graph search. Each `max_gleanings` increment adds roughly
one extraction pass of LLM cost. Search-time settings (result limit, thresholds, community
level) live on the surface knowledge entry, not on the RAG config.

`create_collection` (or `attach_rag`) only **starts** async indexing. A flow that references
the collection will not retrieve anything until indexing **completes**:

1. `create_collection({ name, documents?, rag? })` — creates the collection, uploads any
   documents, attaches the RAG strategy, and starts indexing. Returns `collectionId` and,
   when a strategy was attached, `ragId` / `ragType`.
2. Poll `wait_for_collections({ collection_ids: [<collectionId>] })` until it reports complete.
3. Only then push/run a flow whose surface exposes the collection.

Graph RAG requires an `llm_config`; naive RAG needs only an `embedder` (org default when
omitted). To add documents to an existing collection later, use `upload_documents` (which
re-indexes), not a new collection.

## Tools

- **Surfaces:** `create_surface`, `update_surface`, `get_surface`, `delete_surface`
- **Agents:** `create_agent`, `update_agent`, `get_agent`, `delete_agent`
- **Knowledge:** `create_collection`, `attach_rag`, `delete_collection`
  (plus `list_source_collections`, `upload_documents`, `wait_for_collections` from the
  knowledge/run tools)
- **Tools:** `create_python_tool`, `update_python_tool`, `delete_python_tool`, `create_mcp_tool`,
  `update_mcp_tool`, `delete_mcp_tool` (list with `list_tools`). A python tool names its `venv`,
  the `secrets` its code may read, and its `execution_timeout`; an MCP tool is one tool of a
  remote http(s)/SSE server (stdio servers cannot be registered).
- **Venvs:** `list_venvs`, `create_venv`, `update_venv`, `delete_venv` — the virtual environments
  python code runs in (flow source `venv: "<name>"`). Libraries are requirement strings
  (`"requests>=2.31"`); a build runs asynchronously (status declared → processing → completed |
  failed). A venv still used by any code — binned code included — cannot be deleted.
- **Model configuration:** `create_llm_config`, `update_llm_config`, `delete_llm_config`,
  `list_embedding_configs`, `create_embedding_config`, `update_embedding_config`,
  `delete_embedding_config`, `get_settings` (org default models, python execution-timeout bounds,
  recycle-bin retention, quickstart status), `update_default_models`, `run_quickstart` (one provider
  key → ready LLM + embedding configs). LLM and embedding configs are deleted **for good**, and what
  used them loses the reference (agents, flows and collections; the org default slots) — run
  `dry_run: true` first to see that usage. Only a config used by something you cannot see is skipped.
- **Secrets:** `list_secrets`, `create_secret`, `delete_secret`. A secret value never travels
  through a tool call: `create_secret` (and `api_key_env` on the config tools) read it from an
  environment variable of the MCP server; nothing ever returns it. Secrets are immutable — to
  rotate, delete and create again. They need a signed-in session (`EPICSTAFF_USERNAME` /
  `EPICSTAFF_PASSWORD`), not `EPICSTAFF_API_TOKEN`.
- **Key-value tables:** `list_key_value_tables`, `create_key_value_table`, `update_key_value_table`,
  `delete_key_value_table`, `list_key_value_entries`, `write_key_value_entries` (hand-edit entries
  that key-value nodes read).
- **Labels:** `list_labels`, `create_label`, `update_label`, `delete_label` (scope `flow` or `tool`);
  tag a flow with `set_flow_labels`, a tool with the `labels` field of its create/update tool.
- **Flows:** `copy_flow`, `delete_flow`, `list_graph_versions`, `create_graph_version`,
  `restore_graph_version` (overwrite in place with a backup version, or `mode: new_flow`),
  `export_entities` / `import_entities` (EpicStaff export documents of flows, python tools or MCP
  tools — `inspect_only` first; export writes a new `.json` file and replaces an existing one only
  with `overwrite: true`), `get_flow_persistent_state` (read-only persistent variables).
- **Recycle bin:** `list_recycle_bin`, `restore_from_recycle_bin`, `purge_from_recycle_bin`.
- **Voice:** voice configs, an agent's voice settings, Twilio voice channels and voice chat history
  have their own skill — `es-voice`. `update_default_models` also sets the legacy
  `voice_llm_config` / `transcription_llm_config` slots (`list_voice_configs include_legacy`).

Create tools are **org-unique by name**: a name clash returns a message telling you to use
the matching `update_*` (or pick a new name) — it is never silently swallowed.

## Deletes go to the recycle bin and are NOT flow-aware

`delete_surface`, `delete_agent`, `delete_collection`, `delete_python_tool`, `delete_mcp_tool`,
`delete_secret`, `delete_key_value_table` and `delete_flow` move the item to the EpicStaff
**recycle bin** at once — `list_recycle_bin` shows it with the days left, and
`restore_from_recycle_bin(kind, ids)` brings it back (renamed when its name was taken meanwhile;
`all: true` instead of `ids` restores every item of that kind — only when the user asks for the whole bin).
`purge_from_recycle_bin` deletes for good: superadmin-only, needs `confirm: true` — use it only when
the user explicitly names the items; everything expires on its own after the retention period.

- While it is binned, any flow referencing it via `{ existing: "<name>" }` will **fail its next
  `push_flow`**. Verify no flow depends on it first.
- `delete_agent` takes the surfaces owned by that agent into the bin with it.
- `delete_collection` bins the documents and attached RAG strategies with it; retrieval stops at
  once, and purging the bin drops the index for good.

The tool responses restate these warnings — read the `next` field before moving on.
