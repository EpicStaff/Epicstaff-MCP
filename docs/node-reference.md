# Node Reference

Reference for all node types supported by EpicStaff flows.

## Node Types

| node_type | API endpoint | list key in graph response | Description |
|---|---|---|---|
| `startnode` | `startnodes` | `start_node_list` | Entry point of a flow; defines input variables |
| `endnode` | `endnodes` | `end_node_list` | Terminal node; maps outputs back to the session |
| `crewnode` | `crewnodes` | `crew_node_list` | Runs a CrewAI crew (agents + tasks) |
| `pythonnode` | `pythonnodes` | `python_node_list` | Executes arbitrary Python code in the sandbox |
| `subgraphnode` | `subgraph-nodes` | `subgraph_node_list` | Embeds another flow as a nested sub-flow |
| `codeagentnode` | `code-agent-nodes` | `code_agent_node_list` | An LLM-backed agent with a system prompt and optional stream-handler code |
| `fileextractornode` | `file-extractor-nodes` | `file_extractor_node_list` | Extracts text/data from uploaded files |
| `audiotranscriptionnode` | `audio-transcription-nodes` | `audio_transcription_node_list` | Transcribes audio to text |
| `decisiontablenode` | `decision-table-node` | `decision_table_node_list` | Routes execution based on condition groups (Decision Table) |
| `telegramtriggernode` | `telegram-trigger-nodes` | `telegram_trigger_node_list` | Triggers a flow from an incoming Telegram message |
| `webhooktriggernode` | `webhook-trigger-nodes` | `webhook_trigger_node_list` | Triggers a flow from an incoming webhook call |

Additional node kinds returned in the graph response (read-only / internal):

| list key | Description |
|---|---|
| `classification_decision_table_node_list` | CDT (Classification Decision Table) nodes — classify input then route |
| `note_node_list` | Canvas sticky-note nodes (no execution logic) |
| `edge_list` | Regular (unconditional) edges |
| `conditional_edge_list` | Conditional edges with Python routing code |

---

## Node Config Fields

> **Node position/color** lives in each node's `metadata` field
> (`JSONField(default=dict)` on the base node model), so it *can* be set at
> create time. In practice, let `init_flow_metadata` auto-lay-out the graph after
> wiring, then adjust individual nodes with `patch_node_metadata` — that's simpler
> than computing coordinates by hand.

### `startnode`

```json
{
  "graph": 42,
  "node_name": "__start__",
  "variables": {
    "request": {"query": "", "user_id": 0}
  }
}
```

`variables` is the session input namespace — a nested domain dict. Nodes read it
via dotted `input_map` paths (e.g. `variables.request.query`).

> **CORRECTION — `variables` is a nested domain dict, not the list shown above.**
> Confirmed against the backend: `StartNode.variables` is a
> `JSONField(default=dict)`, and the runtime reads it as a `DotDict` via dotted
> `input_map` paths (`variables.request.city`). Use a dict like
> `{"request": {"city": null}}` (the shape `flow-ddd` teaches). The list example
> above is stale — that `[{name, type, default}]` shape belongs to
> `PythonCodeTool.variables`, a different model.

### `endnode`

```json
{
  "graph": 42,
  "node_name": "__end__",
  "output_map": {
    "result": "$.some_node.output"
  }
}
```

`output_map` maps session output keys to variable paths from the flow namespace.

### `crewnode`

```json
{
  "graph": 42,
  "node_name": "ResearchCrew",
  "crew_id": 7,
  "input_map": {
    "topic": "$.variables.query"
  }
}
```

`crew_id` references an existing crew. `input_map` binds flow variables to crew inputs.

### `pythonnode`

```json
{
  "graph": 42,
  "node_name": "ProcessData",
  "python_code": {
    "code": "def run(inputs):\n    return {\"result\": inputs[\"value\"] * 2}",
    "entrypoint": "run",
    "libraries": ["pandas"]
  },
  "input_map": {
    "value": "$.variables.count"
  }
}
```

`python_code.code` must define the entrypoint function. `libraries` lists pip packages to install.

> **Confirmed:** the executor honors `python_code.entrypoint`
> (`run_python_code_service` invokes it), and it **defaults to `"main"`**. So
> `def main(...)` works without setting `entrypoint`; set `entrypoint` only if you
> name the function differently. (`libraries` is stored as a space-separated
> string on the model but the API serializer accepts/returns a list.)

### `codeagentnode`

```json
{
  "graph": 42,
  "node_name": "SummaryAgent",
  "llm_config": 3,
  "system_prompt": "You are a summarisation assistant.",
  "agent_mode": "build",
  "python_code": {
    "code": "",
    "libraries": []
  },
  "input_map": {
    "content": "$.variables.text"
  }
}
```

`llm_config` is the ID of an LLM config record. `agent_mode` is typically `"completion"` or `"streaming"`.

> **CORRECTION — `agent_mode` defaults to `"build"`.** Confirmed against the
> backend: it's a free `CharField(max_length=10, default="build")` with no
> enforced choices, and `"build"` is the value the code-agent executor keys on.
> The `"completion"`/`"streaming"` values shown above are stale — not used by the
> executor.

### `subgraphnode`

```json
{
  "graph": 42,
  "node_name": "NestedFlow",
  "subgraph_id": 15,
  "input_map": {
    "query": "$.variables.query"
  }
}
```

### `decisiontablenode`

```json
{
  "graph": 42,
  "node_name": "RouteByScore",
  "condition_groups": [
    {
      "group_name": "high",
      "conditions": [],
      "next_node": "HighScoreCrew"
    },
    {
      "group_name": "low",
      "conditions": [],
      "next_node": "LowScoreCrew"
    }
  ],
  "default_next_node": "DefaultCrew",
  "next_error_node": null
}
```

Each `condition_groups` item **must** include `"conditions": []`. The DT node is not wired via regular edges — routing is embedded in the node itself.

### `webhooktriggernode`

```json
{
  "graph": 42,
  "node_name": "WebhookEntry",
  "python_code": {
    "code": "def handle(payload):\n    return payload",
    "libraries": []
  }
}
```

### `telegramtriggernode`

```json
{
  "graph": 42,
  "node_name": "TelegramEntry"
}
```

---

## Edges

> Edges reference nodes by **integer node id** (`start_node_id`/`end_node_id`),
> not by name. The `add_edge` / `delete_node` / `delete_edge` MCP tools take
> numeric ids too — resolve names → ids via `get_flow_nodes` first.

### Regular edge

Connects two nodes unconditionally.

```json
{
  "graph": 42,
  "start_node_id": 10,
  "end_node_id": 20
}
```

When using `save_flow` with `temp_id` references before real IDs are assigned:

```json
{
  "graph": 42,
  "start_temp_id": "uuid-of-new-node",
  "end_node_id": 20
}
```

### Conditional edge

Routes execution based on a Python expression.

```json
{
  "graph": 42,
  "source_node": 10,
  "python_code": "lambda state: 'branch_a' if state['score'] > 0.5 else 'branch_b'",
  "input_map": {
    "score": "$.ProcessData.result"
  }
}
```

---

## Bulk Save Payload (`/api/graphs/{id}/save/`)

The `save_flow` tool posts all node lists and edges in a single atomic request. Any list omitted is treated as empty (no-op for that type).

```json
{
  "start_node_list": [...],
  "end_node_list": [...],
  "crew_node_list": [...],
  "python_node_list": [...],
  "subgraph_node_list": [...],
  "code_agent_node_list": [...],
  "file_extractor_node_list": [...],
  "audio_transcription_node_list": [...],
  "decision_table_node_list": [...],
  "telegram_trigger_node_list": [...],
  "webhook_trigger_node_list": [...],
  "edge_list": [...],
  "conditional_edge_list": [...],
  "deleted": {
    "crew_node_ids": [],
    "python_node_ids": [],
    "edge_ids": [],
    "conditional_edge_ids": []
  }
}
```

---

## Variable Paths

Flow variables are referenced with JSONPath-style expressions:

- `$.variables.<name>` — input variable from the start node
- `$.<node_name>.output` — named output from a specific node
- `$.<node_name>.<field>` — specific field from a node's output dict
