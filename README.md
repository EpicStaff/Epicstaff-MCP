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
   (`POST /api/profile/api-keys/`), and persists it in `~/.es_mcp/` together with the login's
   refresh token. If that key is later revoked or expires, the replacement is minted with the
   stored session (refreshed through the refresh token) — a new login happens only when the
   session is gone too, and a key that is rejected right after minting is never re-minted in a
   loop. With `EPICSTAFF_API_TOKEN`, the token is used directly. Unset variables that reach the
   server as a literal `${VAR}` count as unset; with a missing or invalid configuration the server
   still starts and every backend tool returns the configuration error (local tools keep working).
4. Credentials a flow needs (LLM API keys, a Telegram bot token) come from environment variables
   named in the flow (`api_key_env`, `bot_token_env`). On push each is stored as an org **Secret**
   named `es-mcp:<ENV_NAME>` and referenced by id — values never enter flow source, the graph or the
   lockfile. The MCP server's own variables (`EPICSTAFF_*`, `ES_MCP_*`) cannot be named there.
   EpicStaff only lets a signed-in user manage secrets (not an API key), so pushing a
   flow with such credentials needs `EPICSTAFF_USERNAME` / `EPICSTAFF_PASSWORD`; the session is
   refreshed through the refresh token rather than by logging in again. Secrets are immutable: if
   an env value changes, delete the old `es-mcp:<ENV_NAME>` secret in EpicStaff and push again.

Organizations are resolved automatically (`GET /api/profile/`) before the first org-scoped call
of every server process. One org → auto-selected; several → pick with `set_active_organization`.

## Versioning & compatibility

The plugin version mirrors the EpicStaff **MAJOR.MINOR** it speaks to; the **PATCH** (and any
prerelease suffix) is the plugin's own. EpicStaff `1.2.x` pairs with plugin `1.2.y` — use the
latest plugin `1.2.*`, whatever EpicStaff patch you run. `main` of this repo tracks EpicStaff
`developer`, published as a prerelease of the *next* EpicStaff minor.

| EpicStaff | Plugin |
|---|---|
| 1.3 (`developer`, unreleased) | `1.3.0-dev.N` (`main`) |
| 1.2.x | `1.2.y` (`release/v1.2.x` line, coming) |

**How to pick:** check your EpicStaff version (release tag, or `developer`) and install the newest
plugin version with the same MAJOR.MINOR. The plugin cannot check this for you — EpicStaff has no
version endpoint yet, so a mismatch shows up only as failing or misbehaving API calls.

Each plugin release records the exact EpicStaff commit it was verified against in
`epicstaff-sync.json`:

| Field | Meaning |
|---|---|
| `repo` | EpicStaff repository the tree was synced against |
| `branch` | EpicStaff branch (`developer`, or a `release/vX.Y.x` branch) |
| `commit` | full sha of the EpicStaff commit the tree was analysed and tested against |
| `synced_at` | date of that sync (ISO-8601) |
| `release_line` | EpicStaff MAJOR.MINOR this version targets (equals the plugin's MAJOR.MINOR) |
| `status` | `dev` — tracks an unreleased branch; `release` — verified against a release tag |

**Upgrading from 3.x:** plugin versions `3.x` predate this scheme. `1.3.0-dev.1` is numerically
*lower* than `3.1.0`, so uninstall and reinstall instead of updating:
`claude plugin uninstall epicstaff-mcp@epicstaff` then `claude plugin install epicstaff-mcp@epicstaff`.

## Skills (the workflow)

| Skill | Responsibility |
|---|---|
| `es-deliver` | **Front door.** Classify the delivery shape (ES-only / ES + new app / ES + integration) and drive the pipeline + right wrapper to completion |
| `es-connect` | Auth + organization selection |
| `es-write-flow` | Author/edit flow source (reuse-first: discover existing entities before defining) |
| `es-build-flow` | Local compile + interpret diagnostics |
| `es-push-flow` | Diff, then materialize on EpicStaff |
| `es-test-flow` | Run, poll, read messages, iterate |
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
key / org / graph id (persisted in `localStorage`). The file carries **no API key** unless you pass
`embed_api_key: true` — then it contains the MCP user's long-lived key in plain text (the result
says so); keep such a file private and never host or commit it. It is one option `es-deliver` reaches for when
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
`classification-decision-table`, `audio-to-text`, `knowledge-retriever`, `key-value`.
`llm`, `code-agent` and `crew` node types are rejected with an error (removed from EpicStaff —
rewrite a `crew` node as an `agent` node or `task` nodes).

```yaml
    lookup:                               # search one RAG of a collection; results → output path
      type: knowledge-retriever
      collection: docs                    # or { existing: "Handbook" } (then set rag: naive|graph)
      query: "{question}"                 # {name} filled from input_map
      input_map: { question: variables.question }
      output_variable_path: variables.handbook
    remember:                             # org Key-Value table (created on push if missing)
      type: key-value
      table: User Profiles
      mode: read                          # read | write | delete
      entries:
        - { key: "profile_{variables.user_id}", value: variables.profile }   # read → writes variables.profile
```

Webhook and Telegram trigger nodes are pushed without a webhook trigger (path / provider); attach
one in the EpicStaff editor — a repush keeps it.

## The data layer — `variables:` and dataflow checks

Data moves between nodes through a shared **`variables`** state, not along edges: a node
**reads** with `input_map` (`{ arg: variables.some.path }`) and **writes** with
`output_variable_path` (`variables.some.path`). Edges are control flow; `variables` is data flow.

The `variables:` section declares state variables — names + initial values (the runtime state is
untyped, so declarations carry no types). Declaring is **optional**: any node's
`output_variable_path` also counts as producing a variable, and so does the `value` of a
`key-value` read entry (a `key-value` write entry's `value` and every `{variables.…}` key
placeholder are reads).

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
hashes). Repush **updates in place** — never duplicates; a push with nothing to change skips the
graph save entirely (`changed: false`, `save_version` unchanged). Commit it with the source.
Remote edits are detected via `save_version`; resolve with `pull_flow` or `force`. A lockfile whose
graph no longer exists (deleted in the editor, or copied from another instance) makes push recreate
the graph and re-verify every locked entity id, with a warning in the result: a stale entity id is
dropped and the entity created anew — push never takes over a same-named entity it has no lock entry
for (names are org-wide, so it may serve other flows); that is reported as an error telling you to
reference it with `{ existing: … }`, pull its flow, or rename. Knowledge collections follow the same
rule: a flow never uploads into (or attaches a RAG to) a same-named collection it did not create.
Ownership of the locked graph is proven only by its name matching `meta.name` — not by the lockfile —
so a copied flow directory with a new `meta.name` is refused, even with `force`. To rename a flow on
purpose, push with `rename: true`: the remote graph is renamed and the lockfile updated (only for a
lockfile that recorded a completed push — `save_version` > 0 — unless `force` is also set).
Node ids are matched to the bulk-save response by node name (the backend lists nodes in no
guaranteed order); a lockfile whose node ids got swapped by an older version is repaired by name on
the next push. If the remote graph holds two nodes with one name, push keeps the copy the lockfile
points at, deletes the others and says so in `warnings`. Concurrent pushes of one flow directory in
one server process run one after the other.

## Development

```bash
npm install
npm run dev        # run the server from source (tsx)
npm test           # vitest — layout/bulk-save fidelity + language + auth suites
npm run typecheck
npm run build      # emit dist/ (committed — the plugin launches dist/index.js)
npm run gen:types  # regenerate src/models/generated/openapi.d.ts from openapi/schema.json
```

### Live tests (need a running EpicStaff)

Configured only through the environment — `EPICSTAFF_BASE_URL`, `EPICSTAFF_USERNAME`,
`EPICSTAFF_PASSWORD`, plus `STRESS_OPENAI_KEY` for the LLM steps. EpicStaff allows **5 active API
keys per user**: point `ES_MCP_STATE_DIR` at one directory and reuse it for every run, so the stored
key is reused instead of minting a new one into a fresh state dir. The regression suite revokes the
keys it minted itself when it finishes (never one it did not mint) and puts the pre-existing key back;
`REG_KEEP=1` skips that cleanup.

```bash
npm run build                              # the regression suite tests the BUILT plugin
npx tsx _stress/regression/run.mts         # every tool over MCP stdio → PASS/FAIL/SKIP table, exit 1 on FAIL
npx tsx _stress/provision-llm.mts          # once per instance: the "stress-4o-mini" config the stress flows use
npx tsx _stress/run-all.mts                # compile → push → run → verify the _stress/flows set
```

The regression suite gives every graph/agent/collection it creates a per-run name and deletes them
at the end (`REG_KEEP=1` keeps them); `REG_LLM_MODEL` / `REG_LLM_PROVIDER` override the default
`gpt-4o-mini` / `openai`. `attach_rag` and `provision_knowledge` are skipped (they need an embedding
model). Scratch output and lockfiles written by these runs are gitignored local state.

The server is a headless port of the EpicStaff Angular frontend's API layer: same
endpoints, same request models, same auth/org headers, and a verbatim port of the
editor's auto-arrange layout. When frontend DTOs change, re-sync `src/models/` and
`openapi/schema.json`. `epicstaff-sync.json` records the EpicStaff commit this tree is verified
against.
