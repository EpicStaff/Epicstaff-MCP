# epicstaff-flow-dev — EpicStaff Flow Development Plugin

Develop EpicStaff flows from Claude Code **like a programming language**: write a flow as
local YAML source, build it (validate + deterministic auto-layout, pure local), push it to
EpicStaff (create/update the whole dependency tree + the graph), then run and debug it —
all through a bundled MCP server and skills.

```
write (flow.yaml) → build (validate + layout) → push (entities + graph) → test (run + read + debug)
```

## Install

The plugin bundles the MCP server as built JS — no npm install needed at use time.

1. Add this repo as a Claude Code plugin (marketplace manifest included):
   `claude plugin marketplace add <path-or-git-url>` then install `epicstaff-flow-dev`.
2. Configure the environment for the MCP server (e.g. in your shell or the plugin's env):
   - `ES_URL` — EpicStaff base URL (e.g. `http://127.0.0.1`)
   - `ES_EMAIL` / `ES_PASSWORD` — your EpicStaff login
3. First tool call logs in, mints a dedicated API key (`POST /api/auth/api-key/`), and
   persists it in `~/.es_mcp/` — credentials are only used for that bootstrap.

Organizations are resolved automatically (`GET /api/profile/`). One org → auto-selected;
several → pick with `set_active_organization`.

## Skills (the workflow)

| Skill | Responsibility |
|---|---|
| `es-connect` | Auth + organization selection |
| `es-write-flow` | Author/edit flow source (reuse-first: discover existing entities before defining) |
| `es-build-flow` | Local compile + interpret diagnostics |
| `es-push-flow` | Diff, then materialize on EpicStaff |
| `es-test-flow` | Run, poll, read messages, answer human input, iterate |
| `es-pull-flow` | Import an existing remote flow into local source |

## Flow-source schema (by example)

A flow is a directory with `flow.yaml` (splittable into `*.flow.yaml` parts) plus any
knowledge documents. Entities are keyed by symbolic name and reference each other by name;
`{ existing: "<name>" }` reuses a remote entity instead of defining one. No coordinates —
layout is computed at build time with the same algorithm as the EpicStaff editor.

```yaml
meta:
  name: research-and-write
  description: Research a topic, then write a summary.

variables:                                # declared flow-state variables (names + defaults)
  topic: "AI agents"                      # bare value = default
  summary: { default: "", description: "Final summary." }

llm_configs:
  default: { model: gpt-4o, temperature: 0.2 }

tools:
  python_code_tools:
    fetch_page:
      description: Fetch a web page.
      code: |
        def main(url: str) -> str:
            ...

knowledge:
  docs:
    documents: [docs/handbook.md]        # paths relative to the flow dir, uploaded on push
    rag: { strategy: naive, chunk_size: 800 }

surfaces:                                 # what an agent may touch
  web_research:
    instructions: Prefer primary sources.
    python_tools: [fetch_page]            # shorthand for {tool, mode: allow}
    knowledge: [{ collection: docs }]

agents:                                   # AgentDefinitions (the new model)
  researcher:
    instructions: You are a meticulous researcher.
    llm_config: default
    fcm_llm_config: { existing: "org-default-fcm" }
    default_surfaces: [{ surface: web_research, place: all }]

flow:
  nodes:
    start:    { type: start, initial_state: { topic: "..." } }
    research: { type: agent, agent: researcher, surfaces: [web_research] }
    write:    { type: task, agent: researcher, task: "Summarize...", expected_output: "..." }
    finish:   { type: end }
  edges:
    - { from: start, to: research }
    - { from: research, to: write }
    - { from: write, to: finish }        # conditional: { from: X, condition: { code: ... } }
```

Node types: `start`, `agent`, `task`, `python`, `end`, `note`, `file-extractor`, `subgraph`,
`webhook-trigger`, `telegram-trigger`, `schedule-trigger`, `decision-table`,
`classification-decision-table`, `audio-to-text` (+ `crew`, deprecated).
`llm` and `code-agent` node types are rejected (legacy/deprecated in EpicStaff).

## The data layer — `variables:` and dataflow checks

Data moves between nodes through a shared **`variables`** state, not along edges: a node
**reads** with `input_map` (`{ arg: variables.some.path }`) and **writes** with
`output_variable_path` (`variables.some.path`). Edges are control flow; `variables` is data flow.

The `variables:` section declares state variables — names + initial values (the runtime state is
untyped, so declarations carry no types). Declaring is **optional**: any node's
`output_variable_path` also counts as producing a variable.

`build_flow` validates the wiring (**may-reach** policy):

| Situation | Result |
|---|---|
| read root isn't `variables`, or malformed path | **error** (the runtime rejects it) |
| read produced by no node anywhere and not declared (a typo) | **error** |
| read produced somewhere, but not on a path that reaches the reader | **warning** |
| read produced on ≥1 reaching path, or declared in `variables:` | ok |
| `variables.shared[…]`, a `\|default` suffix, or `input_map: "__all__"` | ok, unchecked |

To silence a read that's only set on *some* branches, declare it with a default
(`variables: { escalation_id: { default: "" } }`) — it's then seeded everywhere.

## Identity & sync — `flow.lock.json`

Push writes a lockfile mapping symbolic names → backend ids (+ `save_version`, content
hashes). Repush **updates in place** — never duplicates. Commit it with the source.
Remote edits are detected via `save_version`; resolve with `pull_flow` or `force`.

## Development

```bash
npm install
npm run dev        # run the server from source (tsx)
npm test           # vitest — layout/bulk-save fidelity + language + auth suites
npm run typecheck
npm run build      # emit dist/ (committed — the plugin launches dist/index.js)
npm run gen:types  # regenerate src/models/generated/openapi.d.ts from openapi/schema.json
```

The server is a headless port of the EpicStaff Angular frontend's API layer: same
endpoints, same request models, same auth/org headers, and a verbatim port of the
editor's auto-arrange layout. When frontend DTOs change, re-sync `src/models/` and
`openapi/schema.json`.
