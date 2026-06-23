---
name: flow-pipeline
description: Use to build or substantially modify an EpicStaff flow end to end. The gated orchestrator that conducts the smaller skills — interview → domain design → build → QA → loop-back-to-intent — and blocks progress when a gate fails. Invoke THIS (not epicstaff-flow directly) for any "build a flow / create a flow / implement this flow" request that should run the full pipeline.
---

# Flow Pipeline — Gated Orchestrator

This skill **only conducts**. It holds the Pipeline State, runs each stage by
loading the skill that owns it, and records a pass/fail Gate Record before
advancing. It contains **no** tool signatures (see `epicstaff`), **no** DDD rules
(see `flow-ddd`), **no** QA checks (see `flow-qa`). Keep it that way — the value
is the gating, not another copy of the content.

Stages and the skills they delegate to:
- Stage 1 Interview → `epicstaff-flow` (Phase 1)
- Stage 2 Domain design → `flow-ddd`
- Stage 3 Build → `epicstaff-flow` (Phase 3) + `epicstaff`
- Stage 4 QA → `flow-qa`
- Stage 5 Loop-back-to-intent → `flow-intent-check`

---

## What "enforced" means here (be honest)

A skill is markdown instructions — there is no runtime that blocks a tool call.
Enforcement is therefore two real mechanisms, not magic:

1. **Required visible Gate Record.** Before invoking the next stage you MUST emit
   a Gate Record (a short checklist block) showing the current gate PASSED. If it
   shows FAIL, you return to the failing stage instead of proceeding. A skipped
   gate is self-evident because the record is missing from the conversation.
2. **Server-side teeth.** The gates that can be machine-checked are backed by real
   tool results: `test_flow(graph_id).ok` (G3), `save_flow`'s blocker envelope,
   `validate_flow_paths`, `flow-qa`'s PASS (G4). Correctness holds even if a
   future caller bypasses this skill, because the server refuses/flags bad writes.

Design rule: **every gate has either a machine-checkable signal OR an explicit
user confirmation — never "it felt fine".**

---

## Pipeline State (maintain and reprint at each stage)

```
Pipeline State
- flow_id: <id once created>
- interview_summary:
    does, trigger, inputs, outputs
    edge_cases: [ ... ]
    success_criteria: [ ... ]
- ddd_contract: { variables namespace, writers/readers + Covers table }
- gate_status: { G1: PENDING|PASS|FAIL, G2: ..., G3: ..., G4: ..., G5: ... }
- last_test_flow_result, qa_report_ref
```

`interview_summary.edge_cases` and `success_criteria` are the through-line — they
are set at G1, mapped at G2, and re-checked at G5. Carry them verbatim.

---

## The Gates

| Stage | Load | Gate to PASS | On FAIL |
|---|---|---|---|
| 1 Interview | `epicstaff-flow` Ph.1 | **G1:** structured Interview Summary with all six fields incl. `edge_cases[]` + `success_criteria[]`, and explicit user "yes". | Stay in Stage 1; ask one question for the missing field. |
| 2 Domain design | `flow-ddd` | **G2:** `variables` namespace + contract table where every `input_map` path is declared, exactly one writer per path, and every edge case + success criterion appears in the "Covers" column; user approves the plan. | Return to Stage 2 with the unmapped item named. |
| 3 Build | `epicstaff-flow` Ph.3 + `epicstaff` | **G3 (machine):** `test_flow(graph_id).ok == true` and `validate_flow_paths(graph_id)` has no blocker; `save_flow` gate not `blocked`. | Loop within build, fixing each reported issue, then re-check. |
| 4 QA | `flow-qa` | **G4:** report `Result: PASS` (no blockers, no unresolved `output_map`). | If a runtime bug, route to `flow-debugger`, then re-run G4. |
| 5 Loop-back | `flow-intent-check` | **G5:** reconciliation matrix has no gaps; user confirms the built flow matches intent. | Return to Stage 2 (design gap) or Stage 3 (wiring/output gap); re-run affected gates. |

---

## Refusal Protocol

On any FAILED gate:
1. Print: `GATE <Gn> FAILED — <reason>. Returning to Stage <k>.`
2. Actually return to that stage and resolve the cause.
3. Re-run the failed gate and every later gate that depends on it.

Never silently proceed past a failed gate. Never skip a stage. Never declare the
flow done before **G5 PASS**.

---

## Entry / Re-entry

- **New flow** → start at Stage 1.
- **Modifying an existing flow** → first run the Backup Rule in `epicstaff-flow`
  (`export_flow` → save JSON → tell the user the path), then enter at the earliest
  stage the change touches. All later gates must still pass before done — a small
  edit that changes wiring still requires G3–G5.

---

## Example Gate Record

```
Gate Record — G3 (Build)
[✓] test_flow(graph_id=55).ok == true
[✓] validate_flow_paths(graph_id=55) — no blockers
[✓] save_flow gate: passed
→ G3 PASS. Proceeding to Stage 4 (QA).
```
