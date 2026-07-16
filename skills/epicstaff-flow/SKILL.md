---
name: epicstaff-flow
description: Use when a user wants to design, plan, or build an EpicStaff flow from scratch or modify an existing one. Covers the full pipeline: business requirements interview, optional DDD contract plan review, and flow materialization via MCP tools. Trigger phrases include "build a flow", "design a flow", "create a flow", "implement flow", "new flow", "add flow", "flow for".
---

# EpicStaff Flow — Full Pipeline

Full pipeline for building EpicStaff flows: idea → interview → optional plan review → build.

Companion skills (load when you hit the topic they cover):
- `epicstaff-solution` — the **front door**. Classifies the request *before* you build (see Phase 0).
- `epicstaff` — every MCP tool this workflow calls, node type reference
- `epicstaff-cdt` — the preferred brancher; how to wire routing by `next_node_id` (see Step 6)
- `flow-ddd` — DDD variable design principles (`variables` namespace, `input_map`, `output_variable_path`)
- `flow-qa` — pre-submit validation after build
- `epicstaff-app` — the custom UI shell, for **app-shaped** requests (see Phase 0)

---

## Phase 0 — Classify before you build (do NOT skip)

**EpicStaff is a component, not always the whole deliverable.** The classic failure is tunnel
vision — building a flow and stopping when the user actually wanted a working product with a UI.
If you arrived here directly from a "build a flow / build a bot / build an app" request, run the
`epicstaff-solution` front door first:

- **ES-only** (no end-user UI: "a team of agents that does X", "a flow that processes Y",
  "modify this node") → continue this pipeline. Done when the runnable gate (Step 9) passes.
- **App-shaped** (a named audience *interacts* with it: "customers", "users", "a bot they talk
  to") → build the EpicStaff backend with this pipeline, **then** hand to `epicstaff-app` for the
  UI shell. A flow with no UI is an *unfinished* app-shaped request.

**Deterministic-first (applies to every build):** math, pricing, parsing, formatting, lookups,
and **every number** go in a `pythonnode` — never an LLM/agent. Agents decide and converse;
Python computes. If deterministic output is worse under EpicStaff, that's a defect to fix inside
the flow, not a reason to move logic out. (See `flow-ddd` and the Platform Capabilities section
of the `epicstaff` skill.)

---

## Pipeline Overview

| Phase | What happens | Output |
|---|---|---|
| 1. Interview | Gather business requirements via Q&A | Confirmed spec summary |
| 2. Plan (optional) | DDD contract table + `variables` namespace for review | User-approved plan |
| 3. Build | Materialize flow via MCP tools (Steps 0–9) | Live flow in DB |

---

## Backup Rule (CRITICAL — always apply before modifying existing flows)

If modifying an **existing** flow (not creating new):
1. Call `export_flow(flow_id)` via MCP.
2. Save the returned JSON to `.epicstaff/backups/<flow_name>_<YYYY-MM-DD_HH-MM>.json`.
3. Tell the user the backup path **before** making any changes.

---

## Phase 1 — Interview

Conduct a business requirements interview. Goal: understand what the flow does, what triggers it, and what it produces.

**Rules:**
- Ask ONE question at a time in plain business language — never technical
- Start with exactly: *"What do you want to build?"* — nothing else, wait for the answer
- Follow up based on answers; if vague, ask for a specific example
- Do NOT ask about tech stack, APIs, databases, or architecture
- Cover: what it does, who/what triggers it, what data comes in, what comes out, edge cases, success criteria

**End of interview:** Summarize what you've captured and ask: *"Does this capture everything correctly? Anything to add or change?"* Wait for confirmation before proceeding.

---

## Phase 2 — Two-Path Branch

After the interview is confirmed, ask the user ONE question:

> "Do you want to review a plan before I build, or should I build it now?"

### Plan path (technical users)

Generate a DDD contract table for review:

| Node | Type | Reads from variables | Writes to variables | Code sketch |
|---|---|---|---|---|
| ... | pythonnode / codeagentnode / ... | `variables.domain.key` | `variables.domain.result` | `def main(key): return {...}` |

Also output the full `variables` namespace dict (what goes in the start node):
```python
variables = {
    "domain_a": {"key": None, "result": None},
    "domain_b": {"input": None, "output": None},
}
```

Ask: *"Does this plan look right? Any changes before I build?"* Wait for approval, then proceed to Phase 3.

### Direct path (non-technical users)

Build immediately via MCP tools (Phase 3 below). User reviews the result live in the EpicStaff UI.

---

## Phase 3 — Build (Steps 0–9)

**Build strategy — prefer build-locally, push-once over incremental.** Design the whole
flow in your head/plan first, then materialize it in as few round-trips as possible:
- **New flow:** author a single `FlowSpec` and call `create_flow_from_spec` (validates
  offline + materializes atomically, then rolls back the shell on any error). See
  `get_flow_spec_schema`. Steps 3–8 below are the incremental fallback for node types the
  spec does not cover (conditional edges, plain DT, note/realtime nodes).
- **Editing an existing flow:** `get_flow` (read full state) → mutate the node lists locally
  → `save_flow` once. `save_flow` is an atomic bulk **upsert** — nodes keep their `id`
  (identity preserved), new nodes use `temp_id`, removals go in `deleted`, guarded by
  `save_version` (409 → re-read and retry). Reserve per-node `add_node`/`patch_*` calls for a
  genuinely trivial one-field tweak.

Either way, Step 9 (the runnable gate) is mandatory before declaring done.

### Step 0 — Read / verify intent
- If plan path: confirm the approved DDD contract table is complete and has no open questions.
- If direct path: confirm the interview summary is complete and all ambiguities are resolved.
- List every node, every edge, every variable path mentally before touching MCP.

### Step 1 — Design the `variables` namespace (DDD)
Apply `flow-ddd` principles:
- Shape `variables` as bounded-context domain dicts — NEVER a flat bag of keys
- Every downstream `input_map` path must be declared here, even as `null`
- Exactly one writer per path
- Every reader explicitly names what it needs via `input_map` keys

Draft the full `variables` dict. Do NOT write to DB yet — that happens in Step 8.

### Step 2 — Draft code for every code-bearing node
For each `pythonnode`, `webhooktriggernode`, `codeagentnode`, and conditional-edge node, draft the full code string AND libraries list **before** creating the node. Creating without code and patching later wipes libraries.

Per-type requirements:

| Node type | Entrypoint | Returns | Libraries |
|---|---|---|---|
| `pythonnode` | `def main(<kwargs matching input_map keys>):` | dict | every non-stdlib import |
| `webhooktriggernode` | `def main(trigger_payload=None):` | dict (on bad input: `{"error": "...", "status": 400}`) | every non-stdlib import |
| `codeagentnode` | `system_prompt` field; optional `stream_handler_code` with `on_stream_start`, `on_chunk`, `on_complete`; optional `output_schema` (JSON Schema dict) | — | every non-stdlib import |
| conditional edge | `def main(<kwargs>):` | **string** (next node name) | as needed |

### Step 3 — Create the flow shell
```
create_flow(name="<name>", description="<description>")
```
Record the returned `flow_id`. Use it for every subsequent call.

### Step 4 — Create every node (code + libraries at creation time)
For each node, call `add_node` with code and libraries included at creation — never create then patch.

```
add_node(flow_id, node_type="<type>", node_name="<name>",
         code=<str>, libraries=<list[str]>,
         input_map=<dict>, output_variable_path="variables.<domain>[.<sub>]",
         x=<int>, y=<int>, ...)
```

MCP `node_type` values and required fields:

| node_type | Required fields |
|---|---|
| `pythonnode` | `code`, `libraries`, `input_map`, `output_variable_path` |
| `webhooktriggernode` | `code`, `libraries`, and the path on **`webhook_trigger.path`** (nested — a flat `webhook_path` is *silently dropped*). No `input_map`/`output_variable_path` — runtime forces `__all__`/`variables`. In a `FlowSpec`, set the node's `path` field and the compiler nests it. |
| `agentnode` | `agent_definition`, `tasks[]` (ordered), `input_map`, `output_variable_path`, optional `surface_list`/`inline_surface`. **Preferred agent node.** Never send `ports`. |
| `tasknode` | `agent_definition`, `instructions`, `input_map`, `output_variable_path`, optional `output_schema`/`surface_list`. Single-task variant. |
| `subgraphnode` | `subgraph_id`, `input_map`, `output_variable_path` |
| `classificationdecisiontablenode` (CDT) | `condition_groups[]` (each `expression` + integer `next_node_id` + non-null `route_code`), `default_next_node_id`, `next_error_node_id`; optional `prompts`. **Preferred brancher** — wire via `patch_cdt_node` (Step 6), not `add_edge`. |
| `fileextractornode` | `input_map`, `output_variable_path` |
| `audiotranscriptionnode` | `input_map`, `output_variable_path` |
| `endnode` | `output_map` mapping response keys to `variables.<path>` |
| `telegramtriggernode` | `telegram_bot_api_key`, `fields[]` |

> **Deprecated — do not reach for these on a new build:** `codeagentnode` (Code Agent) and
> `crewnode` (Project/Crew) still run but are slated for removal — prefer `agentnode`/`tasknode`.
> Plain `decisiontablenode` (DT) is superseded by CDT — prefer `classificationdecisiontablenode`.
> Both DT and CDT route by integer `next_node_id`, never a node **name** (see Step 6).

Node placement: X increases left to right (~400–500px per step), Y increases top to bottom (~60px between stacked nodes). Trigger nodes go far left, offset in Y to avoid overlap with `__start__`.

### Step 5 — Wire edges
Call `add_edge(flow_id, start_node_name, end_node_name)` for every non-CDT edge.

- Always connect `__start__` to at least one downstream node — without it, `run_session` fails.
- For trigger nodes (webhook/telegram), wire BOTH `__start__` and the trigger into the same first real node:
  ```
  add_edge(flow_id, "__start__", "Process Request")
  add_edge(flow_id, "My Trigger", "Process Request")
  ```
- NEVER use `add_edge` from a CDT node's outputs — CDT routing is metadata only (Step 6).

### Step 6 — Wire brancher routing (if CDT/DT nodes exist)
Prefer a **CDT** (`classificationdecisiontablenode`) — a deterministic superset of the plain DT.
Routing is **metadata, not edges** — `add_edge` on a CDT output does nothing. Wire each branch
by its target's **integer `next_node_id`** (look ids up with `get_flow_nodes` /
`get_flow_connections`). Full recipe and gotchas are in the `epicstaff-cdt` skill.

```
patch_cdt_node(flow_id, name_or_id="<cdt name>",
               condition_groups=[
                 {"group_name": "is_order", "order": 0,
                  "expression": "variables.routing.intent == 'order'",
                  "next_node_id": 108, "route_code": "is_order"},
                 ...
               ],
               default_next_node_id=101,   # no group matched
               next_error_node_id=101)      # evaluation raised
```

**Critical (verified against the MCP source):**
- Route by integer **`next_node_id`** / `default_next_node_id` / `next_error_node_id` — **never a
  node name.** `patch_cdt_node`/`patch_dt_node` **reject** a group that sets `next_node` (a name)
  without an integer `next_node_id` with a 400. (Sending a stray name used to crash the backend.)
- CDT `expression` uses **dot-notation** against `variables` (`variables.routing.intent == 'order'`),
  never subscript (`variables['routing']` raises `'SimpleNamespace' object is not subscriptable`).
- Every CDT group needs a **non-null, unique `route_code`** (default it to `group_name`) or the
  branch routes correctly at runtime but draws no connector in the UI.
- **Never send `group_type` or `conditions` on a CDT group** — those are DT-only and are rejected.
- Plain DT (`patch_dt_node`) is the legacy path: it auto-fills each group's `"conditions": []`, but
  still routes by `next_node_id`. Prefer CDT for anything new.

### Step 7 — `init_flow_metadata` (mandatory)
```
init_flow_metadata(flow_id)
```
One call after all structural changes. Without it:
- New nodes render as black dots in the UI
- CDT routing breaks silently
- Edge positions are missing

### Step 8 — Set start variables
```
patch_start_variables(flow_id, variables=<full DDD dict from Step 1>)
```
Every path any downstream `input_map` reads must be present, even as `null`.

### Step 9 — Runnable gate (mandatory before declaring done)

Run the gate in TWO phases. **Every live run is expensive** — it executes the whole
graph (LLM crew nodes are slow) and leaves a session behind. The pain users report is
20–30 leftover test sessions and long build times, and it comes from doing a live run
after *every* edit. Keep live runs to a minimum: iterate statically, execute once.

**Phase 1 — static, zero-cost, repeat freely.** After each structural change, and for
any quick check, run the static-only pass — it starts NO session and costs NO tokens:
```
smoke_test_flow(flow_id, execute=False)
```
Fix every error-severity finding here FIRST. Never do a live run while a static error
remains — it will only fail the same way, slower, and burn a session doing it.

**Phase 2 — one live run, only when static is clean.** When Phase 1 reports no errors,
do a single live run to prove one happy path reaches the end node:
```
smoke_test_flow(flow_id, variables=<one representative input>)   # execute=True (default)
```
It re-runs the static checks AND executes once, confirming it reached the end node with
no node errors and no `"not found"` output holes. `test_flow(flow_id)` alone is static
only — it passes on flows that silently return `"not found"`; never treat it as proof of
runnability.

- Pass a representative `variables` input (e.g. a real chat message) to exercise the
  meaningful path; omit it to run with the start node's declared defaults.
- `runnable: true` → done, hand off. `runnable: false` → the `summary` + `holes`/
  `node_errors` name the failing node. Fix that specific defect, re-confirm with Phase 1
  (`execute=False`), and only then spend another live run. **Aim for one passing live
  run per build — not a live run per edit.**
- Record the passing `session_id` — `flow-qa` reuses it instead of executing again.

Then hand off to `flow-qa` for the final validation pass.

---

## Red Flags — Stop and Correct

If you catch yourself doing any of the following, stop immediately:

- Creating a `pythonnode`, `webhooktriggernode`, or `codeagentnode` without `libraries` — they get wiped on later patches
- Wiring a trigger node's input — triggers have no input port
- Using `add_edge` for CDT outputs — CDT routing is metadata only, use `patch_cdt_node`
- Routing a CDT/DT group by a node **name** (`next_node`) instead of an integer `next_node_id` — rejected with a 400
- Skipping `init_flow_metadata` after structural changes — nodes render as black dots
- Writing Python without `def main(...)` — the crew executor calls `main()`
- Flattening `variables` into a bag of keys — always use DDD domain dicts
- Asking more than one question at a time during the interview
- Asking technical questions during the interview (tech stack, APIs, databases)
- Modifying an existing flow without taking a backup first

---

## Key Operation Rules

- **One `init_flow_metadata` at the end** — it's idempotent; one call covers all prior structural changes.
- **Never write raw HTTP / CLI / curl** — only MCP tools via the `epicstaff` skill.
- **Never hardcode numeric node IDs** — IDs change on every UI save; always look up by `node_name`.
- **Every `patch_python_node` or `patch_webhook_node` must include `libraries`** — omit and libraries are wiped.
- **CDT `prompts` must be a dict, not a list** — runtime calls `.items()`.
- **Non-CDT `ports` field must be `null`, not `[]`** — empty array suppresses port auto-generation.

---

## File Locations

| Path | Purpose |
|---|---|
| `.epicstaff/specs/<topic_name>/spec.md` | Business spec saved after interview (optional) |
| `.epicstaff/backups/<flow_name>_<YYYY-MM-DD_HH-MM>.json` | Backup before modifying an existing flow |

---

## Done Criteria

The build is done when:
1. `smoke_test_flow(flow_id, variables=...)` returns `runnable: true` (this subsumes the
   static `test_flow` check AND proves one happy path actually runs end-to-end)
2. Every node exists with code + libraries + `input_map` + `output_variable_path` set
3. Every edge from the plan exists
4. CDT routing targets all resolve
5. Start variables contain every path referenced by any `input_map`
6. `init_flow_metadata` has been run after the last structural change

Never declare a flow done on a static check alone — run the runnable gate. Then hand off
to `flow-qa` for the final validation pass.
