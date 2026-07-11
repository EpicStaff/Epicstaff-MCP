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

### `startnode`

```json
{
  "graph": 42,
  "node_name": "__start__",
  "variables": [
    {"name": "query", "type": "str", "default": ""},
    {"name": "user_id", "type": "int", "default": 0}
  ]
}
```

`variables` defines the schema for session inputs. Each entry must have `name` and `type`.

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

### `codeagentnode`

```json
{
  "graph": 42,
  "node_name": "SummaryAgent",
  "llm_config": 3,
  "system_prompt": "You are a summarisation assistant.",
  "agent_mode": "completion",
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

`save_version` is the flow's current version number (optimistic lock — a mismatch returns 409). `save_flow` fetches it automatically when not passed.

CDT/DT nodes may route to nodes created in the same request via `default_next_node_temp_id`, `next_error_node_temp_id`, and per-group `next_node_temp_id` — the same temp-UUID mechanism edges use.

```json
{
  "save_version": 1,
  "start_node_list": [...],
  "end_node_list": [...],
  "crew_node_list": [...],
  "python_node_list": [...],
  "subgraph_node_list": [...],
  "code_agent_node_list": [...],
  "file_extractor_node_list": [...],
  "audio_transcription_node_list": [...],
  "decision_table_node_list": [...],
  "classification_decision_table_node_list": [...],
  "telegram_trigger_node_list": [...],
  "webhook_trigger_node_list": [...],
  "schedule_trigger_node_list": [...],
  "agent_node_list": [...],
  "task_node_list": [...],
  "graph_note_list": [...],
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

### One-shot alternative: `create_flow_from_spec`

Instead of hand-assembling this payload, author a declarative spec (nodes, edges, and CDT routing by node NAME) and call `create_flow_from_spec`. The compiler resolves names to temp_ids, runs the full `validate_flow` check suite locally, and only materializes (one graph-shell POST + one bulk save) when there are zero error-severity findings. Call `get_flow_spec_schema` for the schema, authoring notes, and a complete example.

---

## Variable Paths

Flow variables are referenced with JSONPath-style expressions:

- `$.variables.<name>` — input variable from the start node
- `$.<node_name>.output` — named output from a specific node
- `$.<node_name>.<field>` — specific field from a node's output dict
