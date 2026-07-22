---
name: es-catalog
description: Manage the reusable org catalog — agents, surfaces, knowledge collections — standalone, without authoring a flow. Use to create/update/delete catalog entities that flows then reference via existing:, or to seed shared building blocks before writing flows.
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

Create tools are **org-unique by name**: a name clash returns a message telling you to use
the matching `update_*` (or pick a new name) — it is never silently swallowed.

## Deletes are irreversible and NOT flow-aware

`delete_surface`, `delete_agent`, and `delete_collection` remove the entity immediately:

- Any flow referencing the deleted entity via `{ existing: "<name>" }` will **fail its next
  `push_flow`**. Verify no flow depends on it first.
- `delete_agent` **cascade-deletes** surfaces owned by that agent.
- `delete_collection` drops the documents, attached RAG strategies, and the **pgvector index**
  permanently; retrieval stops at once.

The tool responses restate these warnings — read the `next` field before moving on.
