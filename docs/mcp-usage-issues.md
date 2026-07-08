# MCP usage issues & backend bug report

Findings from building a full breadth-test flow through the MCP (2026-07-08). Each item is
either **fixed in the MCP** (this repo) or requires a **backend fix** in the EpicStaff repo
(`src/`), which the MCP cannot do. Backend items include exact file:line + proposed fix.

---

## Fixed in the MCP (this repo)

Commit `959ed70` — six tool-layer fixes:
1. `trigger_rag_indexing` resolves the collection's `rag_id` + `rag_type` before POSTing (endpoint 400'd on `collection_id` alone → RAG was unindexable).
2. `register_telegram_trigger` sends `telegram_trigger_node_id` (was `node_id`).
3. `run_session_and_wait` treats `end`/`ended` as terminal (was polling to timeout on successful sessions).
4. `test_flow` accepts `next_node_id` for DT/CDT routing (false-positive "no next_node").
5. `add_node` accepts `subgraph_id` as an alias for the `subgraph` FK (was silently creating unlinked subgraph nodes).
6. `add_conditional_edge` docstring corrected — the code must `return "<node_name> #<id>"`, not a node id.
   Plus a test-isolation fix in `conftest.py` (was hitting a real `/auth/login/`).

Commit `d1f9da9` — three more:
7. `create_agent`/`update_agent` now send the nested `rag` object → agents can be RAG-grounded via MCP (see #A below — this was a client gap, not a backend bug).
8. `add_node` supports `classificationdecisiontablenode` (CDT); `patch_cdt_node` exposes `default_next_node_id`/`next_error_node_id`.
9. `patch_dt_node` / `patch_cdt_node` strip the read-only `next_node` name from groups (mitigates the backend crash in #B).

---

## Backend bugs (require a fix in EpicStaff `src/` — MCP can only mitigate)

### A. Agent knowledge requires a `rag` companion object — *not a bug, documented here for clarity*
`crew_serializers.py:335` (`AgentWriteSerializer`) requires `rag = {"rag_type": "naive"|"graph", "rag_id": <int>}`
(`RagInputSerializer`, `knowledge_serializers.py:316`) whenever `knowledge_collection` is set; `rag_id`
is the NaiveRag's `naive_rag_id`, validated to belong to the same collection
(`services/rag_assignment_service.py`). This is a legitimate two-part contract — the MCP now sends it
(fix #7 above). No backend change needed. (Optional DX: auto-select `rag` when a collection has exactly
one config.)

### B. `DecisionTableNode` PATCH crashes (500 / dropped connection) on a stray group field — CRITICAL (robustness)
- **File:** `src/django_app/tables/views/model_view_sets.py:1416`, `DecisionTableNodeModelViewSet._create_condition_groups`.
- **Root cause:** condition-group dicts are popped from **raw request data** (before serializer validation) and splatted as model kwargs: `ConditionGroup.objects.create(decision_table_node=node, **copy_group_data)`. `ConditionGroup` has no `next_node` field (only `next_node_id`), so a group containing `next_node: "<name>"` raises a plain `TypeError`, which escapes `custom_exception_handler` → unhandled 500 / connection drop.
- **Why it's easy to hit:** the CDT/DT read tools emit a `next_node` *name* for readability; a read-modify-write round-trips it straight back.
- **Proposed fix:** whitelist real model fields before construct, and resolve a `next_node` name → `next_node_id` (or raise a clean `serializers.ValidationError` → 400). The classification viewset (`:1474`) already filters keys via a comprehension — mirror it. Never let a stray key reach the model constructor.
- **Note:** mooted for MCP callers by standardizing on CDT (its viewset filters `id`), but the endpoint should still never 500 on extra input.

### C. Subgraph `input_map` does not nest into the child — CRITICAL (silent wrong data)
- **File:** `src/crew/services/graph/subgraphs/subgraph_node.py:173` (`_create_subgraph_state`), using `src/crew/utils/map_variables.py` (`map_variables_to_input`).
- **Root cause:** `variables = self.subgraph_data.initial_state | subgraph_input`, and `map_variables_to_input` writes `output_dict[output_key] = value` using the map **key verbatim**. So a dotted input_map key like `input.category` lands as a flat literal key `variables["input.category"]` instead of nesting into `variables["input"]["category"]`. The child then reads the still-null nested value and runs on defaults — **no error, wrong data** (e.g. a subflow ignores everything the parent passes).
- **Proposed fix:** in `_create_subgraph_state`, set each mapped key with the existing nested-path setter `set_output_variables` (`src/crew/utils/set_output_variables.py`, already imported) instead of the flat dict-union, so `variables.input.category` nests correctly.
- **MCP workaround (in use):** design child subflows with **flat** top-level variables so input_map keys have no dots.

### D. Subgraph output is destructive / double-nests & drops the child `End` projection — CRITICAL (silent data loss)
- **File:** `src/crew/services/graph/subgraphs/subgraph_node.py` `_process_subgraph_result` (~:226-238), `_build_with_session_graph_builder` (~:56-61).
- **Root cause (two defects):** (1) the subgraph returns the child's **entire** variable namespace — the child `End` node's `output_map` projection is computed but lives on the *discarded* child `SessionGraphBuilder`'s `end_node_result`, so it's thrown away. (2) Writing to `output_variable_path="variables"` does a **wholesale replace** (`temp_state["variables"] = DotDict(subgraph_output)`), wiping sibling parent domains; a scoped path nests the full namespace (double-nest, e.g. `live.live.result`).
- **Proposed fix:** retain the child builder, return its `end_node_result` (fall back to full dump if no end node), and always deep-merge via `set_output_variables` (its empty-key branch merges without wiping siblings).
- **MCP workaround (in use):** never use `output_variable_path="variables"` for a subgraph node — always a scoped path (e.g. `variables.live`) — and keep child vars flat so the result reads cleanly at `variables.<scope>.<var>`.

---

### E. Agent RAG search-config not auto-created on UPDATE → crew crash — backend asymmetry
- **File:** `src/django_app/tables/serializers/model_serializers/crew_serializers.py` — `create()` (lines 352-360) auto-creates a default search config when `rag` is set without `search_configs`; **`update()` (lines 406-408) does NOT** (no `elif rag_data:` branch).
- **Symptom:** attaching RAG to an existing agent via `update_agent` leaves `rag_search_config = null`; at run time the crew raises `src.shared.models.knowledge.NaiveRagSearchConfig() argument after ** must be a mapping, not NoneType` and the session errors before any LLM call.
- **Proposed fix:** mirror the `create()` default-config branch in `update()` (create default naive/graph search config when `rag_data` is set and no `search_configs` provided).
- **MCP workaround (in use):** create agents with RAG via `create_agent` (default config is auto-created), not `update_agent`. Verified: crew then retrieves and answers from the docs.

### F. CDT condition-group PATCH crashes on a stray field (`group_type`) — same class as B
- **File:** `src/django_app/tables/views/model_view_sets.py:~1474` (`ClassificationDecisionTableNodeModelViewSet`). It filters only `id`/`classification_decision_table_node` (blacklist), then `ClassificationConditionGroup(**gd)`. `ClassificationConditionGroup` has **no `group_type` field** (unlike DT's `ConditionGroup`), so a group dict containing `group_type` → `TypeError` → unhandled 500 / disconnect.
- **Proposed fix:** whitelist real `ClassificationConditionGroup` fields before construct (same fix shape as B).
- **MCP note:** `patch_cdt_node` now strips `id`/`classification_decision_table_node`/`next_node`; callers must NOT send `group_type` for CDT groups.

### G. Usage note (not a bug): CDT vs DT expression syntax differs
CDT expressions evaluate `variables` as an attribute namespace → use **`variables.routing.category`** (dot access). Plain DT accepts subscript (`variables['routing']['category']`). A subscript expression in a CDT raises `'types.SimpleNamespace' object is not subscriptable`, and the CDT routes to its `next_error_node`.

## Suggested backend priority
E first (blocks RAG-grounded agents on the natural update path), then D and C (silent subgraph data
corruption), then B and F (a public endpoint should never 500 on extra input). Add tests:
`src/crew/tests/graph/subgraphs/test_subgraph_node.py` (input nesting, non-destructive output, no
double-nest); a `DecisionTableNodeModelViewSet` + `ClassificationDecisionTableNodeModelViewSet` PATCH
API test (stray field → 400, not 500); and an agent-update RAG test asserting the default search config
is created.
