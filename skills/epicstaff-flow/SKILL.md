---
name: epicstaff-flow
description: Use when a user wants to design, plan, or build an EpicStaff flow from scratch or modify an existing one. Covers the full pipeline: business requirements interview, optional DDD contract plan review, and flow materialization via MCP tools. Trigger phrases include "build a flow", "design a flow", "create a flow", "implement flow", "new flow", "add flow", "flow for".
---

# EpicStaff Flow — Full Pipeline

Full pipeline for building EpicStaff flows: idea → interview → optional plan review → build.

Companion skills (load when you hit the topic they cover):
- `epicstaff` — every MCP tool this workflow calls, node type reference
- `flow-ddd` — DDD variable design principles (`variables` namespace, `input_map`, `output_variable_path`)
- `flow-qa` — pre-submit validation after build

> This skill is normally driven by `flow-pipeline`, the gated orchestrator that
> runs interview → DDD → build → QA → intent-check and blocks progress when a
> gate fails. When invoked standalone, still honor those gates (especially the
> structured Interview Summary below and the intent-check in Done Criteria).

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

**End of interview:** Produce a structured **Interview Summary** — not free prose — so the build and the final intent-check can be measured against it:

```
Interview Summary
- Does: <one line>
- Trigger: <manual | webhook | telegram | schedule | ...>
- Inputs: <what data comes in>
- Outputs: <what the flow produces>
- Edge cases:
  - <each edge case as its own bullet>
- Success criteria:
  - <each measurable "done right" criterion as its own bullet>
```

Edge cases and success criteria MUST be explicit, named bullet lists — they are
carried forward into node/branch design (Phase 2) and re-checked against the
built flow at the end. Then ask: *"Does this capture everything correctly?
Anything to add or change?"* Wait for explicit confirmation before proceeding.
This is **gate G1**: do not enter Phase 2 until all six fields are filled and the
user confirms.

---

## Phase 2 — Two-Path Branch

After the interview is confirmed, ask the user ONE question:

> "Do you want to review a plan before I build, or should I build it now?"

### Plan path (technical users)

Generate a DDD contract table for review. The **Covers** column ties each node
back to the interview's edge cases / success criteria — every edge case and
criterion must appear at least once, or the plan isn't complete (gate G2):

| Node | Type | Reads from variables | Writes to variables | Covers (intent items) | Code sketch |
|---|---|---|---|---|---|
| ... | pythonnode / codeagentnode / ... | `variables.domain.key` | `variables.domain.result` | "rejects empty city" / "friendly summary" | `def main(key): return {...}` |

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
For each node, call `add_node` with code and libraries included at creation — never create then patch. Node-specific fields are nested under `config`:

```
add_node(flow_id, node_type="<type>", node_name="<name>", config={
    "python_code": {"code": <str>, "entrypoint": "main", "libraries": <list[str]>},
    "input_map": <dict>,
    "output_variable_path": "variables.<domain>[.<sub>]",
})
```

MCP `node_type` values and required `config` fields:

| node_type | Required `config` fields |
|---|---|
| `pythonnode` | `python_code.{code,entrypoint,libraries}`, `input_map`, `output_variable_path` |
| `webhooktriggernode` | `python_code.{code,libraries}`, `webhook_path` (no `input_map`/`output_variable_path` — runtime forces `__all__`/`variables`) |
| `codeagentnode` | `system_prompt`, `stream_handler_code`, `libraries`, `llm_config_id`, `agent_mode` (defaults to `"build"`), `input_map`, `output_variable_path`, optionally `output_schema` |
| `crewnode` | `crew_id`, `input_map`, `output_variable_path` (crew must exist — create via `create_crew`/`create_agent`/`create_task` first) |
| `subgraphnode` | `subgraph_id`, `input_map`, `output_variable_path` |
| `decisiontablenode` | `condition_groups`, `default_next_node`, `next_error_node` (each group needs `"conditions": []` — missing key causes silent rollback) |
| `fileextractornode` | `input_map`, `output_variable_path` |
| `audiotranscriptionnode` | `input_map`, `output_variable_path` |
| `endnode` | `output_map` mapping response keys to `variables.<path>` |
| `telegramtriggernode` | `telegram_bot_api_key`, `fields[]` |

Don't hand-set X/Y at creation — `init_flow_metadata` (Step 7) auto-lays out
every node. Adjust individual positions afterward with `patch_node_metadata` if
needed.

### Step 5 — Wire edges
Edges use **integer node IDs**, not names. Resolve them first, then wire:

```
nodes = get_flow_nodes(flow_id)          # map node_name -> id
add_edge(flow_id, nodes["__start__"], nodes["Process Request"])
```

- Always connect `__start__` to at least one downstream node — without it, `run_session` fails.
- For trigger nodes (webhook/telegram), wire BOTH `__start__` and the trigger into the same first real node (resolve all three ids, then two `add_edge` calls into the same target id).
- NEVER use `add_edge` from a CDT node's outputs — CDT routing is metadata only (Step 6).

### Step 6 — Wire CDT routing (if CDT nodes exist)
For each `decisiontablenode`, call:
```
patch_dt_node(graph_id, name_or_id="<cdt name>",
              condition_groups=[
                {"group_name": "...", "group_type": "simple" | "complex",
                 "expression": <str or null>, "conditions": [],
                 "manipulation": <str or null>, "next_node": "<target node name>"},
                ...
              ],
              default_next_node="<name>", next_error_node="<name>")
```
Every group object MUST include `"conditions": []` — the viewset calls `pop("conditions")` and silently rolls back if missing.

### Step 7 — `init_flow_metadata` (mandatory)
```
init_flow_metadata(graph_id)
```
One call after all structural changes. Without it:
- New nodes render as black dots in the UI
- CDT routing breaks silently
- Edge positions are missing

### Step 8 — Set start variables
```
patch_start_variables(graph_id, variables=<full DDD dict from Step 1>)
```
Every path any downstream `input_map` reads must be present, even as `null`.
`variables` is a nested domain **dict** (confirmed against the backend).

### Step 9 — Structural check
```
test_flow(graph_id)            # gate G3: proceed only if .ok is true
validate_flow_paths(graph_id)  # confirm no input_map path resolves nowhere
describe_flow(graph_id)        # read back the assembled flow; confirm no orphans/dangling
```
Fix any issues before declaring done. Then hand off to `flow-qa` for the final
validation pass, and to `flow-intent-check` for the loop-back to original intent.

---

## Red Flags — Stop and Correct

If you catch yourself doing any of the following, stop immediately:

- Creating a `pythonnode`, `webhooktriggernode`, or `codeagentnode` without `libraries` — they get wiped on later patches
- Wiring a trigger node's input — triggers have no input port
- Using `add_edge` for CDT outputs — CDT routing is metadata only, use `patch_dt_node`
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
- **Never *persist* numeric node IDs** — IDs change on every UI save. Patch/inspect tools accept `name_or_id`; but `add_edge`/`delete_node`/`delete_edge` need numeric ids, so resolve names → ids via `get_flow_nodes` immediately before each such call.
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
1. `test_flow(graph_id)` passes (`.ok` is true)
2. Every node exists with code + libraries + `input_map` + `output_variable_path` set
3. Every edge from the plan exists
4. CDT routing targets all resolve
5. Start variables contain every path referenced by any `input_map` (`validate_flow_paths` clean)
6. `init_flow_metadata` has been run after the last structural change
7. **Intent-check passed** — `flow-intent-check` reconciled the built flow against the Interview Summary's edge cases + success criteria, and the user confirmed it matches

Then hand off to `flow-qa` for the final validation pass.
