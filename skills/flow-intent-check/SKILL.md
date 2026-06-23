---
name: flow-intent-check
description: Use as the final stage of building or modifying an EpicStaff flow — reconcile the built flow against the original interview intent before declaring it done. Confirms every edge case and success criterion is actually handled. Trigger after flow-qa passes, or when the user asks "does this do what I asked?".
---

# Flow Intent Check — Loop Back to Intent

The last gate before a flow is "done". `flow-qa` checks the flow is a **correct
program** (reachable, well-typed, no dangling). This skill asks the orthogonal
question: is it the **right program** — does it do what the user actually asked,
including every edge case and success criterion?

A QA-clean flow can still miss the point. This stage catches that.

Companion skills:
- `epicstaff` — the MCP tools used here (read-only inspection).
- `flow-pipeline` — the orchestrator that invokes this as gate G5.
- `flow-qa` — must pass before this stage (G4).

---

## Inputs

1. The **Interview Summary** recorded in Phase 1 (from `epicstaff-flow` /
   `flow-pipeline` state) — specifically its `Edge cases:` and
   `Success criteria:` bullet lists.
2. The **built flow**, read live via:
   ```
   describe_flow(graph_id, fmt="text")   # nodes, wiring, orphans, dangling
   get_flow_nodes(graph_id)              # input_map / output_variable_path per node
   get_cdt_route_map(graph_id)           # branch targets, if any CDT/DT nodes
   ```
   plus the end node's `output_map`.

If no structured Interview Summary exists (e.g. this skill was invoked
standalone), reconstruct one with the user first — you cannot check intent
against an intent you never captured.

---

## The Reconciliation Matrix

Build one row per interview item. Map each to where the built flow handles it.

| Interview item | Type | Handled by (node / edge / CDT group) | Surfaced in end `output_map`? | Verdict |
|---|---|---|---|---|
| "rejects empty city" | edge case | `Validate Request` → 400; CDT `error` → `__end__` | `error`, `status` | ✓ |
| "friendly summary" | success criterion | `Friendly Reporter` (code-agent) | `message` | ✓ |
| "handle API timeout" | edge case | (none found) | — | ✗ GAP |

Rules:
- **Every edge case** must map to a concrete node, conditional edge, or CDT/DT
  branch that handles it.
- **Every success criterion** must map to a node that produces it AND to an
  end-node `output_map` key that actually surfaces it (cross-check the path is
  written — `validate_flow_paths(graph_id)` confirms it isn't a "not found").
- Any `✗ GAP` row fails the gate.

---

## The Confirmation (required)

Even with a fully-green matrix, ask the user — one question, plain language:

> "Here's how the built flow maps to what you asked for: <matrix summary>.
> Does this match your intent, including the edge cases? Anything missing?"

A vague "looks good" is not confirmation if the matrix has a gap. Restate the
gap and resolve it. Explicit "yes, that matches" is required to pass.

---

## Gate G5 — Pass / Fail

**PASS** when both are true:
1. The matrix has no `✗ GAP` rows — every edge case and success criterion is
   demonstrably handled and (for criteria) surfaced in `output_map`.
2. The user explicitly confirmed the flow matches their intent.

**FAIL** otherwise. On failure, hand control back to the orchestrator with the
specific unmapped item(s):
- A **design gap** (the flow never accounts for the item) → return to Stage 2
  (`flow-ddd`) to add the node/branch.
- A **wiring/output gap** (the item is computed but not routed or not surfaced)
  → return to Stage 3 (build) to fix the edge or `output_map`.

Then re-run the affected gates (G3/G4) and this one. Do not declare the flow
done until G5 passes.

---

## Do Not

- Do not treat `flow-qa` PASS as intent confirmation — they answer different questions.
- Do not infer the user's intent to fill a gap; ask.
- Do not skip the matrix because "it obviously does what they want" — the matrix
  is the evidence that it does.
