# epicstaff-flow-dev — EpicStaff Flow Development Plugin

Develop EpicStaff flows from Claude Code **like a programming language**: write a flow as
local YAML source, build it (validate + deterministic auto-layout, pure local), push it to
EpicStaff (create/update the whole dependency tree + the graph), then run and debug it —
all through a bundled MCP server and skills.

```
write (flow.yaml) → build (validate + layout) → push (entities + graph) → test (run + read + debug) → ui (chat front-end)
```

## Install

The plugin bundles the MCP server as built JS — no npm install needed at use time.

1. Add this repo as a Claude Code plugin (marketplace manifest included):
   `claude plugin marketplace add EpicStaff/Epicstaff-MCP` then install `epicstaff-mcp`.
2. Configure the environment for the MCP server (e.g. in your shell or the plugin's env):
   - `EPICSTAFF_BASE_URL` — EpicStaff base URL (e.g. `http://127.0.0.1`)
   - `EPICSTAFF_API_TOKEN` — a pre-issued API key, **or**
   - `EPICSTAFF_USERNAME` / `EPICSTAFF_PASSWORD` — your EpicStaff login (a dedicated API key
     is minted on first use)
3. With login credentials, the first tool call logs in, mints a dedicated API key
   (`POST /api/auth/api-key/`), and persists it in `~/.es_mcp/` — credentials are only
   used for that bootstrap. With `EPICSTAFF_API_TOKEN`, the token is used directly.

Organizations are resolved automatically (`GET /api/profile/`). One org → auto-selected;
several → pick with `set_active_organization`.

## Skills (the workflow)

| Skill | Responsibility |
|---|---|
| `es-deliver` | **Front door.** Classify the delivery shape (ES-only / ES + new app / ES + integration) and drive the pipeline + right wrapper to completion |
| `es-connect` | Auth + organization selection |
| `es-write-flow` | Author/edit flow source (reuse-first: discover existing entities before defining) |
| `es-build-flow` | Local compile + interpret diagnostics |
| `es-push-flow` | Diff, then materialize on EpicStaff |
| `es-test-flow` | Run, poll, read messages, answer human input, iterate |
| `es-pull-flow` | Import an existing remote flow into local source |

Start with **es-deliver** for any build request: it decides whether the deliverable is the flow
alone, the flow plus a new app/UI, or the flow integrated into an existing app — then runs the
`es-connect → es-write-flow → es-build-flow → es-push-flow → es-test-flow` pipeline and the
matching delivery tail.

## Chat UI generation (one "ES + App" mechanism, for conversational flows)

`generate_chat_ui` turns a pushed chat flow into a usable front-end: a single self-contained HTML
file (inline CSS/JS, no external assets) that drives the graph through its run-session API. It
authenticates with `Authorization: ApiKey` + `X-Organization-Id` — both CORS-allowed by the
backend — so it works from `file://` or any static host with no backend change. Point it at a
`graph_id`, tell it the `input_path` the user message lands in and the `reply_path` the answer is
read from, and set `reset_variables` to clear downstream state each turn (so `persistent_variables`
graphs don't carry a stale answer forward). Open the emitted file; the gear icon edits API base /
key / org / graph id (persisted in `localStorage`). It is one option `es-deliver` reaches for when
a flow's interaction shape is conversational; non-chat apps are built to fit their own shape (form,
dashboard, batch runner, …) against the same run-session contract — which is also what
"ES + Integration" wires into an existing app.

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
