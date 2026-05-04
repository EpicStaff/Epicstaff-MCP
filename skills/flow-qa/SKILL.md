---
name: Flow-QA-Checklist
description: Use when an EpicStaff flow build is complete and needs pre-submit validation before being considered done.
---

# Flow QA Checklist

Static + dynamic validation of a built flow. Treat a flow as a program — reachable, well-typed, and side-effect-aware. This skill produces a pass/fail report with actionable findings.

All checks use MCP tools. Companion skills:
- `epicstaff` — every tool used here.
- `flow-node-types` — ports, allowed connections, per-type rules.
- `flow-ddd` — variable namespace shape and contracts.
- `flow-debugger` — next stop if QA surfaces runtime issues.

---

## When to Use

**Use this skill when:**
- A flow has just been built (`flow-build` completed, `test_flow` passed).
- Before declaring a flow "ready" for the user.
- After any structural change (add/delete node or edge), before handing back.
- The user asks "is it ready?", "lint this flow", "review the flow", "QA it".

**Do NOT use when:**
- The flow is mid-build — run QA once at the end, not after every partial change.
- The flow is actively broken with a known bug — use `flow-debugger` first, then QA.

---

## QA Output — Pass/Fail Report

Produce a report with these sections:

```
## QA Report — <Flow Name> (#<flow_id>)

### Result
PASS | FAIL

### Structural
[✓|✗] test_flow passes
[✓|✗] __start__ connects to downstream
[✓|✗] No dangling nodes (every non-end node has outgoing route)
[✓|✗] Trigger nodes have no input edges
[✓|✗] CDT route map resolves all targets
[✓|✗] Metadata is in sync (no "NOT FOUND" entries)

### Data Flow
[✓|✗] Every `input_map` path is declared in start variables or written upstream
[✓|✗] Every declared start variable is actually read by something (or marked intentionally seeded)
[✓|✗] No two nodes write to the same `output_variable_path`
[✓|✗] End node `output_map` references paths that get written

### Port Legality
[✓|✗] Every edge respects `allowedConnections` rules for both endpoints

### Per-Node Correctness
[✓|✗] python / webhook / code-agent nodes have non-empty `libraries` if code imports non-stdlib
[✓|✗] python / webhook nodes define `def main(...)`
[✓|✗] code-agent nodes have `llm_config_id` and `agent_mode` set
[✓|✗] CDT condition expressions return booleans (spot-check)
[✓|✗] `project` nodes reference live crews with intact agent `tool_ids`

### Runtime (if feasible)
[✓|✗] One synthetic session completes without error
[✓|✗] End node produces expected keys

### Findings
1. <finding 1 — severity, location, suggested fix>
2. ...

### Recommended next step
<build is clean | route to flow-debugger with specific symptom | fix specific patch>
```

Severity:
- **blocker** — flow will fail at runtime. Must fix.
- **warning** — not a guaranteed failure but likely a bug. Investigate.
- **nit** — code smell, naming, unused variable. Fix at leisure.

---

## The Checks — What and How

Run each check explicitly. Do not skip the ones that "look obviously fine" — the point is evidence, not intuition.

### 1. Structural reachability

Tools: `get_flow_nodes`, `get_flow_connections`, `test_flow`, `get_cdt_route_map`.

- `__start__` has at least one outgoing edge.
- Every non-trigger, non-end node is reachable from `__start__`. A node referenced by CDT / conditional edge counts as reachable too.
- Every execution path reaches the end node (or a CDT error branch that reaches end).
- Trigger nodes (webhook, telegram) have zero incoming edges.
- When a trigger exists, `__start__` is also wired into the first real node (dual entry).
- CDT routes: every `next_node`, `default_next_node`, `next_error_node` resolves to a real node name.

If any of these fail, the fix is almost always a missing edge or stale metadata. `init_flow_metadata(flow_id)` after structural fixes.

### 2. Data-flow continuity

Tools: `get_flow_nodes` (read each node's `input_map`, `output_variable_path`), start variables from the start node in `get_flow_nodes`, `get_cdt_node(flow_id, name_or_id)` for each CDT node's full group/condition detail.

Build two tables:

**Writers table.** For every `output_variable_path` across all nodes: which node writes it.
- A path with two writers is a blocker unless the design is explicitly override-last-wins (document the intent).
- A path with zero writers is a blocker if anyone reads it.

**Readers table.** For every `input_map` value across all nodes: which node reads it.
- Every path must appear either (a) in the start node's initial `variables` or (b) in the writers table with an execution order that precedes the reader.
- Paths read but never written are blockers.

For end node `output_map`: every value path must appear in the writers table or start variables. If a value is referenced only via `output_map`, the runtime silently resolves it to the string `"not found"` — warning-level, not blocker.

### 3. Port legality

Tools: `get_flow_connections`, `get_flow_nodes` (for types).

For each edge, look up the source node's output port `role` and the target node's input port `role`. Confirm source's role is in target's `allowedConnections`, and target's role is in source's `allowedConnections`. The canonical rules are in `flow-node-types`.

Common illegal wiring:
- Wiring anything INTO a trigger node.
- Wiring `tool-out-*` outside of a crew's internal graph (those are agent-tool ports, not flow-level).
- Wiring a second outgoing edge from a `multiple=false` output port (e.g. `python-out`) — the UI would normally prevent this, but MCP bypasses the UI.

### 4. Per-node correctness

For each node type, verify the per-type invariants.

- **start**: `variables` is a non-empty dict; every path any downstream `input_map` references is declared (even as `null`).
- **end**: `output_map` non-empty; every referenced path is written upstream (or acknowledged as default `"not found"`).
- **python**: code contains `def main(...)`; every import satisfies one of (a) stdlib, (b) appears in `libraries`; `input_map` keys map to kwargs of `main` or are explicit paths; `output_variable_path` set if output is used downstream.
- **webhook-trigger**: `python_code.code` contains `def main(trigger_payload=None)`; `libraries` present; `webhook_path` unique; bad-input branches return `{"error": ..., "status": 400}`.
- **code-agent**: `llm_config_id` set; `agent_mode` is `"build"` or `"plan"`; `system_prompt` not empty (unless intentionally); `libraries` present if `stream_handler_code` imports non-stdlib; `output_schema` either unset or a valid JSON Schema.
- **project** (crew): crew exists; crew has agents; every agent has `llm_config` and intact `tool_ids`; every task has an `agent_id` and is attached to the crew.
- **edge** (conditional edge): code returns a string (assert in code), and that string is always a live node's name.
- **table** (CDT): every group has `group_name` unique within the node; `group_type` is `simple` or `complex`; `simple` groups have `conditions[]` entries whose `condition` field is a boolean expression; `complex` groups have non-null `expression`; `next_node` set for every group; `default_next_node` set; `next_error_node` set; manipulation (if present) mutates `variables` via `kwargs["variables"]`.
- **subgraph**: referenced subgraph exists; circular references absent.
- **file-extractor**, **audio-to-text-node**: input is a path or file ref the runtime can consume; `output_variable_path` set.

### 5. Error handling coverage

- Every trigger node has a validation step shortly after it (webhook typically → python validator that returns `{"error", "status": 400}` on bad input, routed to end via CDT).
- Every CDT has a `next_error_node` set (blocker if unset — the runtime falls back to END silently).
- Every path that can raise (external HTTP calls, file parsing, LLM calls) either has an explicit try/except in the node code or sits upstream of a CDT that can route errors.

### 6. Side-effect placement

Side effects (external API writes, file writes, emails, messages) belong in clearly named nodes, not buried inside a routing `edge` or a CDT `manipulation`. A reader of the graph should be able to see where side effects happen just from node names and types.

Flag as a **warning** any:
- CDT `manipulation` that calls `requests` / sends messages / writes files.
- Conditional `edge` code with side effects (it should only compute a target string).
- `python` node that both transforms data AND sends outbound messages — split responsibilities.

### 7. Naming and domain hygiene

Tie back to `flow-ddd`:
- `variables` is shaped as domain dicts, not a flat key bag.
- Node names describe responsibilities in business language ("Fetch Weather", not "Node 1").
- CDT group names are short and distinctive — they become port roles (`decision-out-<group_name>`), so renaming them later breaks canvas wiring.

### 8. Runtime smoke test (if feasible)

If inputs can be synthesized:
```
run_session_and_wait(flow_id, variables=<minimal synthetic input>, timeout=60)
inspect_session(session_id)
```
Confirm:
- Session status is `finished`.
- Every expected node appears in the trace.
- End node produces the expected keys.

Skip this step only if the flow requires external triggers (Telegram, a real inbound webhook) that cannot be synthesized. Note that as a limitation in the report.

---

## Working the Checklist — Execution Order

Do the checks in order. Stop and write up findings if a blocker surfaces early; a downstream check may depend on an earlier check being clean.

1. `test_flow(flow_id)` — fast smoke.
2. `get_flow_nodes(flow_id)` — node inventory, types, code, libraries, maps.
3. `get_flow_connections(flow_id)` — edges and CDT routing.
4. `get_cdt_route_map(flow_id)` — only if any CDT nodes exist.
5. For each CDT node found in step 2: `get_cdt_node(flow_id, name_or_id)` — full group/condition detail for per-node correctness (step 7).
6. Cross-reference: build the writers / readers tables from the node inventory.
7. Port legality pass over each edge.
8. Per-node correctness pass (uses CDT detail from step 5).
9. Error handling and side-effect review.
10. (If feasible) Runtime smoke: `run_session_and_wait` + `inspect_session`.

Do NOT patch in the middle of QA. Collect findings, then either report or hand off to `flow-debugger` with a specific symptom.

---

## Sample Finding — Good Format

```
Finding 2 — blocker
Node: Fetch Weather (python)
Issue: input_map has "city": "variables.request.city", but start variables declare
       "variables.request.message" instead. No upstream writer for variables.request.city.
Evidence: get_flow_nodes -> start.variables = {"request": {"message": null, "units": "celsius"}}
Fix: Either rename start var to `city`, or update the webhook validator to write
     `variables.request.city`, or update Fetch Weather's input_map to read .message.
```

A bad finding:
> The flow looks a bit off around the webhook.

Be specific. Every finding must cite the node, the symptom, the evidence from MCP, and a concrete fix.

---

## EpicChat Output

When running in EpicChat mode, format the report as the `message` field (Markdown). Include:
- `tools: ["Build mode"]`.
- An `openFlow` button.
- An `openNode` button for the first blocker finding (if any), targeting that node.
- A `refreshCache` button so the user's browser picks up any earlier changes.
- Prompt chips: "Fix the blockers", "Run the debugger on <node>", "Trigger a test session".

Example:
```json
{
  "message": "## QA Report — Weather Report Demo (#55)\n\n**Result:** FAIL (1 blocker, 2 warnings)\n...",
  "tools": ["Build mode"],
  "action_message": [
    {"type": "button", "text": "Open flow", "action": "openFlow", "params": {"flowId": "55"}},
    {"type": "button", "text": "Open Fetch Weather", "action": "openNode", "params": {"flowId": "55", "nodeId": "<uuid>"}},
    {"type": "button", "text": "Refresh to see changes", "action": "refreshCache"},
    {"type": "prompt", "text": "Fix the blockers"},
    {"type": "prompt", "text": "Debug Fetch Weather"}
  ]
}
```

---

## Pass Criteria

A flow **passes** QA only when:
- Every blocker check is green.
- No unresolved `output_map` path that would silently resolve to `"not found"`.
- The runtime smoke test (if run) completed `finished`.
- No illegal edges (all port-role pairs in `allowedConnections`).

Anything less is a **FAIL** — report the blockers first, warnings next, nits last.

---

## Do Not

- Do not patch during QA. Report findings; let the user or `flow-build` / `flow-debugger` apply fixes.
- Do not skip checks that "obviously pass" — the point is evidence.
- Do not invent a pass result. If you couldn't run a check (e.g. can't synthesize trigger input), say so in the report.
- Do not run long-timeout smoke tests in a production flow without user permission.
