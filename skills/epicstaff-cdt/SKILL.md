---
name: epicstaff-cdt
description: Use when adding or wiring a Classification Decision Table (CDT) node — the preferred deterministic brancher in an EpicStaff flow. Covers the build recipe, metadata-not-edges routing, dot-notation expressions, the route_code rendering rule, the exact group fields to send (and the ones that crash), and verification.
---

# EpicStaff CDT — Branching Done Right

A **Classification Decision Table (CDT)** routes a flow to one of N downstream nodes. Prefer it over the plain Decision Table (DT): a CDT is a deterministic superset that routes on a group **`expression`** evaluated against `variables`, with **no LLM call** unless a group sets `prompt_id`. It is the single most gotcha-heavy node type — this skill is the checklist that keeps it working.

`node_type` for `add_node`: **`classificationdecisiontablenode`**. Endpoint: `/api/classification-decision-table-node/`.

---

## Core model — routing is METADATA, not edges

A CDT does **not** store its outgoing links in the flow's `edge_list`. It stores them on the node:

| Field | Meaning |
|---|---|
| `condition_groups[]` | ordered branches; each has `group_name`, `order`, `expression`, `next_node_id`, `route_code` |
| `default_next_node_id` | fallback when no group matches |
| `next_error_node_id` | branch taken if evaluation raises |

Groups are evaluated in `order`; **first match wins**; no match → default; exception → error. `add_edge` onto a CDT output **does nothing** — wire every branch through `patch_cdt_node` (or `add_node` config), never `add_edge`.

---

## Build recipe (via MCP)

```
1. add_node(flow, "classificationdecisiontablenode", "Router", config={})
2. patch_cdt_node(flow, "Router",
     condition_groups=[
       {"group_name": "is_command", "order": 0,
        "expression": "variables.session.is_command == True",
        "next_node_id": 103, "route_code": "is_command"},
       {"group_name": "is_order", "order": 1,
        "expression": "variables.routing.intent == 'order'",
        "next_node_id": 108, "route_code": "is_order"},
     ],
     default_next_node_id=101,      # no group matched
     next_error_node_id=101)        # evaluation error
3. init_flow_metadata(flow); test_flow(flow)
4. get_cdt_route_map(flow)          # verify the wiring
```

### The group shape — send exactly these
- `group_name` — label.
- `order` — evaluation order (0-based, unique).
- `expression` — a Python-ish boolean over `variables` (see below).
- `next_node_id` — **integer node id** of the target (NOT a name — see gotchas).
- `route_code` — **required, non-null, unique per group** (see rendering).
- `dock_visible` — omit, or truthy. `false` suppresses the branch's port.

**Never send `conditions` or `group_type` on a CDT group** — both crash the viewset (500). `conditions` belongs to plain DT, not CDT.

---

## Expressions — dot-notation only

`variables` is exposed to the expression as an attribute object (`SimpleNamespace`), **not** a dict:

- ✅ `variables.routing.intent == 'order'`
- ✅ `variables.session.is_command == True`
- ✅ `variables.routing.category in ['hr', 'it']`
- ❌ `variables['routing']['intent'] == 'order'` → runtime `'types.SimpleNamespace' object is not subscriptable`

Keep expressions pure (comparisons, `in`, `and`/`or`). For anything heavier, compute a scalar in an upstream Python node and branch on that.

---

## `route_code` — the invisible-branch rule

The flow editor **synthesizes CDT branch connectors from routing metadata on load** (never from `edge_list`), and it builds each branch's output **port id from `route_code`**. The connection mapper **skips any group whose `route_code` is null**:

> `classification-decision-table-connections.mapper.ts` → `if (!group.route_code) continue;`

So a group with `route_code: null` routes correctly **at runtime but draws no connector in the UI** — the branch looks unwired. Always set a **unique, non-null `route_code`** per group; defaulting it to the `group_name` is the safe convention (the editor slugifies it identically on the port and connection sides). The **default** and **error** connectors are drawn from `default_next_node_id` / `next_error_node_id` and need no `route_code`.

> If the MCP build tool doesn't auto-fill `route_code`, set it yourself in `patch_cdt_node`. Symptom of forgetting: routing works, `get_cdt_route_map` is correct, but the branch line is missing on the canvas.

---

## LLM classification (optional)

Pure-expression routing needs no LLM. To classify with an LLM, add a `prompt_configs` entry and set the group's `prompt_id`; leave `prompt_id` unset for deterministic routing. A CDT can also run `pre_python_code` / `post_python_code` (with their own `input_map` / `output_variable_path`) to shape `variables` before/after routing.

---

## Verification

- **`get_cdt_route_map(flow)`** — the fastest check: shows `{group: target_id}`, `default`, `error` for every CDT/DT. Use it after every patch.
- **`get_cdt_node(flow, name_or_id)`** — full raw node (groups, expressions, route_codes, pre/post code). Note: this finds **CDT only**, not plain DT.
- `test_flow(flow)` — structural pass (does not deeply validate expressions).

---

## Gotchas

| Symptom | Cause / fix |
|---|---|
| Branch has no connector line in the UI (but routing is correct) | Group `route_code` is null — set a unique non-null `route_code` (default to `group_name`). |
| `add_edge` to a CDT target did nothing | CDT routing is metadata; wire via `patch_cdt_node` `next_node_id`, not edges. |
| 500 `unexpected keyword arguments: 'conditions'` | Sent a DT-style `conditions` key on a CDT group — remove it. |
| 500 / crash on save | Sent `group_type` (or another stray field) — send only the fields listed above. |
| 500 / server disconnect when wiring | Routed by `next_node` **name** — route by integer `next_node_id`. |
| `'SimpleNamespace' object is not subscriptable` | Expression used `variables['x']` subscript — use dot-notation `variables.x`. |
| Routing silently reverts after a UI save | Known platform bug: UI save/reload can drop group `next_node_id`. Re-verify with `get_cdt_route_map` and re-patch. |
| A branch never fires | Earlier group with `order` lower matched first, or the expression is false — check `order` and test the expression against a sample `variables`. |
| `get_cdt_node` can't find a node | It resolves CDT nodes only; a plain DT won't appear (use the DT tools). |

Related: `epicstaff` (tool catalog + the CDT-vs-DT rule), `flow-ddd` (designing the `variables` the expressions read), `flow-debugger` (when routing misbehaves at run time).
