"""Tests for the flow compiler: spec -> local validation -> atomic bulk save."""

from __future__ import annotations

import json
from copy import deepcopy

import httpx
import respx
from pydantic import ValidationError

from epicstaff_mcp.flow_compiler import compile_flow_spec
from epicstaff_mcp.models.flow_spec import FlowSpec
from epicstaff_mcp.tools.flow_compiler import (
    EXAMPLE_FLOW_SPEC,
    _extract_format_placeholders,
    create_flow_from_spec,
    get_flow_spec_schema,
)
from epicstaff_mcp.tools.flows import _validate_graph
from tests.conftest import BASE_URL


def _error_codes(findings: list[dict]) -> set[str]:
    return {f["code"] for f in findings if f["severity"] == "error"}


def _compile(spec_dict: dict):
    return compile_flow_spec(FlowSpec.model_validate(spec_dict))


# ---------------------------------------------------------------------------
# Pure compilation — name resolution and temp_id wiring
# ---------------------------------------------------------------------------


def test_example_spec_compiles_with_zero_findings():
    compiled = _compile(EXAMPLE_FLOW_SPEC)
    assert compiled.ok
    assert compiled.findings == []
    assert compiled.validation_graph is not None
    assert compiled.save_lists is not None


def test_compile_synthesizes_start_and_end_nodes():
    compiled = _compile(EXAMPLE_FLOW_SPEC)
    lists = compiled.save_flow_lists(flow_id=42)

    (start,) = lists["start_node_list"]
    assert start["node_name"] == "__start__"
    assert start["variables"] == {"request": {"city": "Kyiv"}, "weather": {}}
    assert start["graph"] == 42
    assert start["id"] is None
    assert start["temp_id"] == compiled.node_temp_ids["__start__"]

    (end,) = lists["end_node_list"]
    assert end["node_name"] == "__end_node__"
    assert end["output_map"] == EXAMPLE_FLOW_SPEC["output_map"]
    assert end["temp_id"] == compiled.node_temp_ids["__end_node__"]


def test_compile_wires_edges_by_temp_id():
    compiled = _compile(EXAMPLE_FLOW_SPEC)
    lists = compiled.save_flow_lists(flow_id=42)
    temp = compiled.node_temp_ids

    edges = lists["edge_list"]
    assert {
        "graph": 42,
        "start_temp_id": temp["__start__"],
        "end_temp_id": temp["Fetch Weather"],
    } in edges
    assert {
        "graph": 42,
        "start_temp_id": temp["Hot Advisory"],
        "end_temp_id": temp["__end_node__"],
    } in edges
    # No integer-id keys leak into the wire format for new nodes.
    for edge in edges:
        assert "start_node_id" not in edge
        assert "end_node_id" not in edge


def test_compile_wires_cdt_routing_by_temp_id():
    compiled = _compile(EXAMPLE_FLOW_SPEC)
    lists = compiled.save_flow_lists(flow_id=42)
    temp = compiled.node_temp_ids

    (cdt,) = lists["classification_decision_table_node_list"]
    assert cdt["node_name"] == "Temperature Router"
    groups = {g["group_name"]: g for g in cdt["condition_groups"]}
    assert groups["hot"]["next_node_temp_id"] == temp["Hot Advisory"]
    assert groups["cold"]["next_node_temp_id"] == temp["Cold Advisory"]
    assert groups["hot"]["order"] == 0
    assert groups["cold"]["order"] == 1
    assert cdt["default_next_node_temp_id"] == temp["Cold Advisory"]
    # '__end__' alias resolves to the synthesized end node.
    assert cdt["next_error_node_temp_id"] == temp["__end_node__"]


def test_compile_is_deterministic():
    first = _compile(EXAMPLE_FLOW_SPEC)
    second = _compile(EXAMPLE_FLOW_SPEC)
    assert first.node_temp_ids == second.node_temp_ids
    assert first.save_lists == second.save_lists


def test_compile_assigns_metadata_positions_to_every_node():
    compiled = _compile(EXAMPLE_FLOW_SPEC)
    lists = compiled.save_flow_lists(flow_id=42)
    for key, entries in lists.items():
        if key.endswith("_node_list"):
            for node in entries:
                assert "position" in node["metadata"], f"{key} missing position"


def test_agent_node_tasks_get_ordered_temp_id_wiring():
    spec = {
        "name": "Agent flow",
        "variables": {"request": {"topic": None}},
        "nodes": [
            {
                "type": "agent",
                "name": "Researcher",
                "agent_definition_id": 7,
                "input_map": {"topic": "variables.request.topic"},
                "output_variable_path": "variables.research.result",
                "tasks": [
                    {"name": "gather", "instructions": "Gather sources."},
                    {
                        "name": "summarize",
                        "instructions": "Summarize.",
                        "context_task_names": ["gather"],
                    },
                ],
            }
        ],
        "edges": [
            {"from": "__start__", "to": "Researcher"},
            {"from": "Researcher", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    assert compiled.ok
    (agent,) = compiled.save_flow_lists(1)["agent_node_list"]
    assert agent["agent_definition"] == 7
    gather, summarize = agent["tasks"]
    assert (gather["order"], summarize["order"]) == (0, 1)
    assert summarize["context_task_temp_ids"] == [gather["temp_id"]]


def test_every_supported_node_type_renders_into_its_save_list():
    spec = {
        "name": "Kitchen sink",
        "variables": {"request": {"text": None}, "results": {}},
        "output_map": {},
        "nodes": [
            {
                "type": "webhook_trigger",
                "name": "Inbound Hook",
                "code": "def main(trigger_payload=None):\n    return trigger_payload or {}\n",
            },
            {
                "type": "telegram_trigger",
                "name": "TG Entry",
                "fields": [
                    {
                        "parent": "message",
                        "field_name": "text",
                        "variable_path": "request.text",
                    }
                ],
            },
            {
                "type": "schedule_trigger",
                "name": "Nightly",
                "is_active": True,
                "schedule": {
                    "run_mode": "repeat",
                    "timezone": "UTC",
                    "interval": {"every": 1, "unit": "days"},
                    "end": {"type": "never"},
                },
            },
            {
                "type": "code_agent",
                "name": "Reasoner",
                "system_prompt": "You reason.",
                "llm_config_id": 5,
                "input_map": {"text": "variables.request.text"},
                "output_variable_path": "variables.results.reasoning",
            },
            {
                "type": "crew",
                "name": "Crew Step",
                "crew_id": 11,
                "input_map": {"text": "variables.request.text"},
                "output_variable_path": "variables.results.crew",
            },
            {
                "type": "subgraph",
                "name": "Sub Flow",
                "subgraph_id": 13,
                "output_variable_path": "variables.results.sub",
            },
            {
                "type": "task",
                "name": "Single Task",
                "agent_definition_id": 9,
                "instructions": "Do the thing.",
                "surface_ids": [3],
                "output_variable_path": "variables.results.task",
            },
            {
                "type": "file_extractor",
                "name": "Extract Doc",
                "output_variable_path": "variables.results.doc",
            },
            {
                "type": "audio_transcription",
                "name": "Transcribe",
                "output_variable_path": "variables.results.transcript",
            },
        ],
        "edges": [
            {"from": "__start__", "to": "Reasoner"},
            {"from": "Inbound Hook", "to": "Reasoner"},
            {"from": "TG Entry", "to": "Reasoner"},
            {"from": "Nightly", "to": "Reasoner"},
            {"from": "Reasoner", "to": "Crew Step"},
            {"from": "Crew Step", "to": "Sub Flow"},
            {"from": "Sub Flow", "to": "Single Task"},
            {"from": "Single Task", "to": "Extract Doc"},
            {"from": "Extract Doc", "to": "Transcribe"},
            {"from": "Transcribe", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    assert _error_codes(compiled.findings) == set()

    lists = compiled.save_flow_lists(7)
    (webhook,) = lists["webhook_trigger_node_list"]
    assert webhook["python_code"]["entrypoint"] == "main"
    (telegram,) = lists["telegram_trigger_node_list"]
    assert telegram["fields"][0]["field_name"] == "text"
    (schedule,) = lists["schedule_trigger_node_list"]
    assert schedule["is_active"] is True
    assert schedule["schedule"]["interval"] == {"every": 1, "unit": "days"}
    (code_agent,) = lists["code_agent_node_list"]
    assert code_agent["llm_config"] == 5
    (crew,) = lists["crew_node_list"]
    assert crew["crew_id"] == 11
    (subgraph,) = lists["subgraph_node_list"]
    assert subgraph["subgraph"] == 13
    (task,) = lists["task_node_list"]
    assert task["agent_definition"] == 9
    assert task["surface_list"] == [3]
    assert len(lists["file_extractor_node_list"]) == 1
    assert len(lists["audio_transcription_node_list"]) == 1
    assert len(lists["edge_list"]) == 10


# ---------------------------------------------------------------------------
# Compile-stage errors
# ---------------------------------------------------------------------------


def test_unknown_edge_reference_is_an_error():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["edges"].append({"from": "Fetch Weather", "to": "No Such Node"})
    compiled = _compile(spec)
    assert not compiled.ok
    assert "unknown_node_reference" in _error_codes(compiled.findings)
    assert compiled.validation_graph is None
    assert compiled.save_lists is None


def test_unknown_cdt_route_target_is_an_error():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][1]["routes"][0]["next_node"] = "Ghost"
    compiled = _compile(spec)
    assert not compiled.ok
    assert "unknown_node_reference" in _error_codes(compiled.findings)


def test_compile_emits_route_code_defaulting_to_group_name():
    # Regression: without a route_code the flow editor draws no branch connector
    # (the "invisible branch"). The compiler must emit one, defaulting to the
    # group_name, and honor an explicit route_code.
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][1]["routes"][0]["route_code"] = "custom_hot"
    compiled = _compile(spec)
    assert compiled.ok
    lists = compiled.save_flow_lists(flow_id=42)
    (cdt,) = lists["classification_decision_table_node_list"]
    groups = {g["group_name"]: g for g in cdt["condition_groups"]}
    assert groups["hot"]["route_code"] == "custom_hot"  # explicit honored
    assert groups["cold"]["route_code"] == "cold"  # defaulted to group_name
    # The validation graph carries it too, so the local route_code check passes.
    vgroups = compiled.validation_graph["classification_decision_table_node_list"][0][
        "condition_groups"
    ]
    assert all(g["route_code"] for g in vgroups)


def test_compile_rejects_subscript_cdt_expression():
    # Regression: `variables` is a SimpleNamespace at runtime — subscripting it
    # raises and dead-ends the branch. The compiler's local validate must reject
    # it instead of materializing a silently-broken flow.
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][1]["routes"][0]["expression"] = (
        "variables['weather']['raw']['temperature_c'] >= 20"
    )
    compiled = _compile(spec)
    assert not compiled.ok
    assert "cdt_expression_subscript" in _error_codes(compiled.findings)


def test_duplicate_route_group_name_rejected_at_parse():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][1]["routes"][1]["group_name"] = spec["nodes"][1]["routes"][0][
        "group_name"
    ]
    try:
        FlowSpec.model_validate(spec)
    except ValidationError as exc:
        assert "duplicate route group_name" in str(exc)
    else:
        raise AssertionError("expected ValidationError for duplicate group_name")


def test_duplicate_explicit_route_code_rejected_at_parse():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][1]["routes"][0]["route_code"] = "same"
    spec["nodes"][1]["routes"][1]["route_code"] = "same"
    try:
        FlowSpec.model_validate(spec)
    except ValidationError as exc:
        assert "route_code values must be unique" in str(exc)
    else:
        raise AssertionError("expected ValidationError for duplicate route_code")


def test_duplicate_node_name_is_an_error():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][2]["name"] = "Fetch Weather"
    compiled = _compile(spec)
    assert "duplicate_node_name" in _error_codes(compiled.findings)


def test_reserved_node_name_is_an_error():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][0]["name"] = "__start__"
    compiled = _compile(spec)
    assert "reserved_node_name" in _error_codes(compiled.findings)


def test_context_task_must_be_an_earlier_task():
    spec = {
        "name": "Agent flow",
        "variables": {},
        "nodes": [
            {
                "type": "agent",
                "name": "Researcher",
                "agent_definition_id": 7,
                "tasks": [
                    {"name": "first", "context_task_names": ["second"]},
                    {"name": "second"},
                ],
            }
        ],
        "edges": [
            {"from": "__start__", "to": "Researcher"},
            {"from": "Researcher", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    assert "invalid_context_task" in _error_codes(compiled.findings)


def test_persistent_variable_rules_are_enforced():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["variables"]["context"] = {"history": []}
    spec["persistent_variables"] = {
        "user": ["context.history", "weather.raw", "context.missing"],
    }
    compiled = _compile(spec)
    codes = _error_codes(compiled.findings)
    assert "persistent_path_outside_context" in codes  # weather.raw
    assert "persistent_path_undeclared" in codes  # context.missing


def test_persistence_wraps_start_variables_in_wire_format_only():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["variables"]["context"] = {"history": []}
    spec["persistent_variables"] = {"user": ["context.history"]}
    compiled = _compile(spec)
    assert compiled.ok

    (wire_start,) = compiled.save_flow_lists(1)["start_node_list"]
    assert wire_start["variables"]["persistent_variables"] == {
        "organization": [],
        "user": ["context.history"],
    }
    assert wire_start["variables"]["variables"]["context"] == {"history": []}

    (validation_start,) = compiled.validation_graph["start_node_list"]
    assert validation_start["variables"]["context"] == {"history": []}


# ---------------------------------------------------------------------------
# Structural validation via the pure _validate_graph seam
# ---------------------------------------------------------------------------


def test_python_node_without_entrypoint_is_caught_locally():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][0]["code"] = "result = 1 + 1"
    compiled = _compile(spec)
    assert not compiled.ok
    assert "missing_entrypoint" in _error_codes(compiled.findings)


def test_unwritten_input_path_is_caught_locally():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"][0]["input_map"] = {"city": "variables.request.country"}
    compiled = _compile(spec)
    assert not compiled.ok
    assert "unwritten_input_path" in _error_codes(compiled.findings)


def test_disconnected_node_is_caught_locally():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["nodes"].append(
        {
            "type": "python",
            "name": "Orphan",
            "code": "def main():\n    return {}\n",
        }
    )
    compiled = _compile(spec)
    assert not compiled.ok
    assert "disconnected_node" in _error_codes(compiled.findings)


def test_round_trip_materialized_graph_validates_clean():
    """Simulate the server's temp_id -> real id resolution over the wire
    payload and confirm the materialized graph passes _validate_graph — i.e.
    the wire renderer and the validation renderer cannot drift apart."""
    compiled = _compile(EXAMPLE_FLOW_SPEC)
    lists = compiled.save_flow_lists(flow_id=99)
    temp_to_id = {
        temp: index
        for index, temp in enumerate(compiled.node_temp_ids.values(), start=1)
    }

    graph: dict = {"id": 99, "name": EXAMPLE_FLOW_SPEC["name"]}
    for key, entries in lists.items():
        materialized = []
        for entry in deepcopy(entries):
            temp_id = entry.pop("temp_id", None)
            if temp_id is not None:
                entry["id"] = temp_to_id[temp_id]
            if "start_temp_id" in entry:
                entry["start_node_id"] = temp_to_id[entry.pop("start_temp_id")]
            if "end_temp_id" in entry:
                entry["end_node_id"] = temp_to_id[entry.pop("end_temp_id")]
            for prefix in ("default_next_node", "next_error_node"):
                ref = entry.pop(f"{prefix}_temp_id", None)
                if ref is not None:
                    entry[f"{prefix}_id"] = temp_to_id[ref]
            for group in entry.get("condition_groups") or []:
                ref = group.pop("next_node_temp_id", None)
                if ref is not None:
                    group["next_node_id"] = temp_to_id[ref]
            materialized.append(entry)
        graph[key] = materialized

    findings = _validate_graph(graph)
    assert [f for f in findings if f["severity"] == "error"] == []


# ---------------------------------------------------------------------------
# create_flow_from_spec — the validate-gate and materialization
# ---------------------------------------------------------------------------


@respx.mock
async def test_invalid_spec_makes_no_network_calls():
    spec = deepcopy(EXAMPLE_FLOW_SPEC)
    spec["edges"].append({"from": "Fetch Weather", "to": "No Such Node"})

    result = await create_flow_from_spec(spec)

    assert result["ok"] is False
    assert "unknown_node_reference" in _error_codes(result["findings"])
    assert "No flow was created" in result["summary"]
    assert len(respx.calls) == 0


@respx.mock
async def test_unparseable_spec_makes_no_network_calls():
    result = await create_flow_from_spec(
        {"name": "Broken", "nodes": [{"type": "warpdrive", "name": "X"}]}
    )
    assert result["ok"] is False
    assert "spec_parse_error" in _error_codes(result["findings"])
    assert len(respx.calls) == 0


@respx.mock
async def test_valid_spec_materializes_via_shell_plus_one_bulk_save():
    compiled = _compile(EXAMPLE_FLOW_SPEC)
    temp_to_id = {
        temp: index
        for index, temp in enumerate(compiled.node_temp_ids.values(), start=1)
    }
    saved_graph = {
        "id": 42,
        "name": EXAMPLE_FLOW_SPEC["name"],
        "start_node_list": [
            {
                "id": temp_to_id[compiled.node_temp_ids["__start__"]],
                "node_name": "__start__",
            }
        ],
        "end_node_list": [
            {
                "id": temp_to_id[compiled.node_temp_ids["__end_node__"]],
                "node_name": "__end_node__",
            }
        ],
        "python_node_list": [
            {"id": temp_to_id[compiled.node_temp_ids[name]], "node_name": name}
            for name in ("Fetch Weather", "Hot Advisory", "Cold Advisory")
        ],
        "classification_decision_table_node_list": [
            {
                "id": temp_to_id[compiled.node_temp_ids["Temperature Router"]],
                "node_name": "Temperature Router",
            }
        ],
    }

    name_route = respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(
            201, json={"id": 42, "name": EXAMPLE_FLOW_SPEC["name"], "save_version": 1}
        )
    )
    save_route = respx.post(f"{BASE_URL}api/graphs/42/save/").mock(
        return_value=httpx.Response(200, json=saved_graph)
    )

    result = await create_flow_from_spec(EXAMPLE_FLOW_SPEC)

    assert result["ok"] is True
    assert result["flow_id"] == 42
    assert result["findings"] == []
    # One name-collision pre-flight read, then exactly two writes: the graph
    # shell and the single atomic bulk save.
    assert name_route.called
    assert shell_route.call_count == 1
    assert save_route.call_count == 1
    assert len(respx.calls) == 3

    shell_payload = json.loads(shell_route.calls[0].request.content)
    assert shell_payload["name"] == EXAMPLE_FLOW_SPEC["name"]

    save_payload = json.loads(save_route.calls[0].request.content)
    assert save_payload["save_version"] == 1
    assert len(save_payload["python_node_list"]) == 3
    assert len(save_payload["classification_decision_table_node_list"]) == 1
    assert len(save_payload["edge_list"]) == 4
    for node in save_payload["python_node_list"]:
        assert node["graph"] == 42
        assert node["temp_id"] == compiled.node_temp_ids[node["node_name"]]
    for edge in save_payload["edge_list"]:
        assert edge["graph"] == 42
        assert "start_temp_id" in edge and "end_temp_id" in edge

    # Node name -> created DB id mapping surfaces in the result.
    assert (
        result["nodes"]["Fetch Weather"]
        == temp_to_id[compiled.node_temp_ids["Fetch Weather"]]
    )
    assert (
        result["nodes"]["Temperature Router"]
        == temp_to_id[compiled.node_temp_ids["Temperature Router"]]
    )


@respx.mock
async def test_rejected_bulk_save_deletes_the_shell():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 42, "save_version": 1})
    )
    respx.post(f"{BASE_URL}api/graphs/42/save/").mock(
        return_value=httpx.Response(400, json={"errors": {"boom": ["bad"]}})
    )
    delete_route = respx.delete(f"{BASE_URL}api/graphs/42/").mock(
        return_value=httpx.Response(204)
    )

    result = await create_flow_from_spec(EXAMPLE_FLOW_SPEC)

    assert result["ok"] is False
    assert "materialization_rejected" in _error_codes(result["findings"])
    assert delete_route.called


async def test_get_flow_spec_schema_returns_schema_and_example():
    result = await get_flow_spec_schema()
    assert "FlowSpec" in json.dumps(result["schema"]) or result["schema"].get("title")
    assert result["example"] == EXAMPLE_FLOW_SPEC
    assert result["notes"]
    # The published example must itself compile clean — it is the contract.
    assert _compile(result["example"]).ok


# ---------------------------------------------------------------------------
# Silent-misroute trap: a dict-returning python writer compared to a scalar
# ---------------------------------------------------------------------------

_BROKEN_SHAPE_SPEC: dict = {
    "name": "MCPTEST-broken-shape",
    "variables": {"input": {"text": ""}, "route": "", "result": ""},
    "output_map": {"result": "variables.result"},
    "nodes": [
        {
            "type": "python",
            "name": "Classify",
            # BUG: returns a dict into variables.route, so the CDT expression
            # variables.route == 'urgent' compares a dict to a string forever.
            "code": (
                "def main(text):\n"
                "    return {'route': 'urgent' if 'urgent' in text else 'normal'}\n"
            ),
            "input_map": {"text": "variables.input.text"},
            "output_variable_path": "variables.route",
        },
        {
            "type": "cdt",
            "name": "Router",
            "routes": [
                {
                    "group_name": "urgent",
                    "expression": "variables.route == 'urgent'",
                    "next_node": "__end__",
                }
            ],
            "default_next_node": "__end__",
            "error_next_node": "__end__",
        },
    ],
    "edges": [
        {"from": "__start__", "to": "Classify"},
        {"from": "Classify", "to": "Router"},
    ],
}


def test_broken_shape_spec_flags_output_shape_mismatch():
    compiled = _compile(_BROKEN_SHAPE_SPEC)
    assert not compiled.ok
    assert "output_shape_mismatch" in _error_codes(compiled.findings)


@respx.mock
async def test_broken_shape_spec_is_rejected_offline_creating_nothing():
    result = await create_flow_from_spec(_BROKEN_SHAPE_SPEC)
    assert result["ok"] is False
    assert "output_shape_mismatch" in _error_codes(result["findings"])
    assert "No flow was created" in result["summary"]
    assert len(respx.calls) == 0


def test_fixing_the_writer_shape_makes_the_spec_compile_clean():
    fixed = deepcopy(_BROKEN_SHAPE_SPEC)
    fixed["nodes"][0]["code"] = (
        "def main(text):\n    return 'urgent' if 'urgent' in text else 'normal'\n"
    )
    compiled = _compile(fixed)
    assert compiled.ok


# ---------------------------------------------------------------------------
# Entity-reference pre-flight: a node pointing at a non-existent
# AgentDefinition / Crew / subgraph / LLMConfig / Surface is caught offline as
# a node-attributed finding, before the graph shell is ever created.
# ---------------------------------------------------------------------------

_AGENT_REF_SPEC: dict = {
    "name": "MCPTEST-agent-ref",
    "variables": {"user_input": "", "out": None},
    "output_map": {"out": "variables.out.message"},
    "nodes": [
        {
            "type": "agent",
            "name": "Worker",
            "agent_definition_id": 5,
            "input_map": {"user_input": "variables.user_input"},
            "output_variable_path": "variables.out",
            "tasks": [{"name": "t", "instructions": "do {user_input}"}],
        }
    ],
    "edges": [
        {"from": "__start__", "to": "Worker"},
        {"from": "Worker", "to": "__end__"},
    ],
}

_CREW_REF_SPEC: dict = {
    "name": "MCPTEST-crew-ref",
    "variables": {"x": "", "c": None},
    "output_map": {"o": "variables.c.message"},
    "nodes": [
        {
            "type": "crew",
            "name": "Crew Runner",
            "crew_id": 8,
            "input_map": {"user_input": "variables.x"},
            "output_variable_path": "variables.c",
        }
    ],
    "edges": [
        {"from": "__start__", "to": "Crew Runner"},
        {"from": "Crew Runner", "to": "__end__"},
    ],
}

_SUB_REF_SPEC: dict = {
    "name": "MCPTEST-sub-ref",
    "variables": {"q": "", "live": None},
    "output_map": {"o": "variables.live"},
    "nodes": [
        {
            "type": "subgraph",
            "name": "Child",
            "subgraph_id": 8,
            "input_map": {"query": "variables.q"},
            "output_variable_path": "variables.live",
        }
    ],
    "edges": [
        {"from": "__start__", "to": "Child"},
        {"from": "Child", "to": "__end__"},
    ],
}


def test_reference_specs_compile_clean_offline():
    # The pre-flight is the ONLY thing that can reject these — the pure compiler
    # has no way to know an id is bad, so all three must compile clean.
    for spec in (_AGENT_REF_SPEC, _CREW_REF_SPEC, _SUB_REF_SPEC):
        assert _compile(spec).ok, spec["name"]


def test_collect_entity_references_maps_every_kind():
    from epicstaff_mcp.tools.flow_compiler import _collect_entity_references

    spec = FlowSpec.model_validate(
        {
            "name": "refs",
            "variables": {"x": "", "a": None, "t": None, "c": None, "s": None},
            "output_map": {},
            "nodes": [
                {
                    "type": "agent",
                    "name": "A",
                    "agent_definition_id": 5,
                    "surface_ids": [11, 12],
                    "output_variable_path": "variables.a",
                    "tasks": [{"name": "t", "instructions": "x"}],
                },
                {
                    "type": "task",
                    "name": "T",
                    "agent_definition_id": 6,
                    "surface_ids": [13],
                    "output_variable_path": "variables.t",
                },
                {
                    "type": "crew",
                    "name": "C",
                    "crew_id": 8,
                    "output_variable_path": "variables.c",
                },
                {
                    "type": "subgraph",
                    "name": "S",
                    "subgraph_id": 9,
                    "output_variable_path": "variables.s",
                },
                {
                    "type": "code_agent",
                    "name": "CA",
                    "system_prompt": "hi",
                    "llm_config_id": 3,
                    "output_variable_path": "variables.x",
                },
            ],
            "edges": [],
        }
    )
    refs = {(r.kind, r.entity_id) for r in _collect_entity_references(spec)}
    assert refs == {
        ("agent_definition", 5),
        ("agent_definition", 6),
        ("surface", 11),
        ("surface", 12),
        ("surface", 13),
        ("crew", 8),
        ("subgraph", 9),
        ("llm_config", 3),
    }


@respx.mock
async def test_bad_agent_definition_reference_rejected_offline_creating_nothing():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    ref_route = respx.get(f"{BASE_URL}api/agent-definitions/5/").mock(
        return_value=httpx.Response(404, json={"detail": "not found"})
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 99, "save_version": 1})
    )

    result = await create_flow_from_spec(_AGENT_REF_SPEC)

    assert result["ok"] is False
    assert "unknown_entity_reference" in _error_codes(result["findings"])
    finding = next(
        f for f in result["findings"] if f["code"] == "unknown_entity_reference"
    )
    assert finding["node"] == "Worker"
    assert "AgentDefinition id 5" in finding["message"]
    assert ref_route.called
    # Nothing was materialized: no graph shell POST happened.
    assert not shell_route.called


@respx.mock
async def test_bad_crew_reference_rejected_offline_creating_nothing():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.get(f"{BASE_URL}api/crews/8/").mock(
        return_value=httpx.Response(404, json={"detail": "not found"})
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 99, "save_version": 1})
    )

    result = await create_flow_from_spec(_CREW_REF_SPEC)

    assert result["ok"] is False
    finding = next(
        f for f in result["findings"] if f["code"] == "unknown_entity_reference"
    )
    assert finding["node"] == "Crew Runner"
    assert "Crew id 8" in finding["message"]
    assert not shell_route.called


@respx.mock
async def test_bad_subgraph_reference_rejected_offline_creating_nothing():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.get(f"{BASE_URL}api/graphs/8/").mock(
        return_value=httpx.Response(404, json={"detail": "not found"})
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 99, "save_version": 1})
    )

    result = await create_flow_from_spec(_SUB_REF_SPEC)

    assert result["ok"] is False
    finding = next(
        f for f in result["findings"] if f["code"] == "unknown_entity_reference"
    )
    assert finding["node"] == "Child"
    assert "flow (subgraph) id 8" in finding["message"]
    assert not shell_route.called


@respx.mock
async def test_repeated_missing_id_is_fetched_once_but_flags_each_node():
    two_nodes = deepcopy(_AGENT_REF_SPEC)
    two_nodes["variables"]["out2"] = None
    two_nodes["nodes"].append(
        {
            "type": "agent",
            "name": "Worker 2",
            "agent_definition_id": 5,
            "output_variable_path": "variables.out2",
            "tasks": [{"name": "t", "instructions": "again"}],
        }
    )
    two_nodes["edges"].append({"from": "Worker", "to": "Worker 2"})
    two_nodes["edges"][-2] = {"from": "Worker 2", "to": "__end__"}

    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    ref_route = respx.get(f"{BASE_URL}api/agent-definitions/5/").mock(
        return_value=httpx.Response(404, json={"detail": "not found"})
    )

    result = await create_flow_from_spec(two_nodes)

    assert result["ok"] is False
    flagged = {
        f["node"] for f in result["findings"] if f["code"] == "unknown_entity_reference"
    }
    assert flagged == {"Worker", "Worker 2"}
    # The distinct id is fetched exactly once, not once per referencing node.
    assert ref_route.call_count == 1


@respx.mock
async def test_good_reference_passes_preflight_and_materializes():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    ref_route = respx.get(f"{BASE_URL}api/agent-definitions/5/").mock(
        return_value=httpx.Response(200, json={"id": 5, "name": "Worker def"})
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 50, "save_version": 1})
    )
    compiled = _compile(_AGENT_REF_SPEC)
    saved_graph = {
        "id": 50,
        "start_node_list": [{"id": 1, "node_name": "__start__"}],
        "end_node_list": [{"id": 2, "node_name": "__end_node__"}],
        "agent_node_list": [{"id": 3, "node_name": "Worker"}],
    }
    save_route = respx.post(f"{BASE_URL}api/graphs/50/save/").mock(
        return_value=httpx.Response(200, json=saved_graph)
    )

    result = await create_flow_from_spec(_AGENT_REF_SPEC)

    assert result["ok"] is True
    assert result["flow_id"] == 50
    assert result["nodes"]["Worker"] == 3
    assert ref_route.called
    assert shell_route.called
    assert save_route.called
    assert compiled.ok
    assert "output_shape_mismatch" not in _error_codes(compiled.findings)


# ---------------------------------------------------------------------------
# use_storage / webhook path / storage_paths — trigger + state compiler fixes
# ---------------------------------------------------------------------------


def test_python_node_emits_use_storage_flag():
    spec = {
        "name": "storage flag",
        "variables": {"memory": {}},
        "nodes": [
            {
                "type": "python",
                "name": "Loader",
                "code": "def main():\n    return {}\n",
                "output_variable_path": "variables.memory",
                "use_storage": True,
            },
            {
                "type": "python",
                "name": "Plain",
                "code": "def main():\n    return {}\n",
                "output_variable_path": "variables.other",
            },
        ],
        "edges": [
            {"from": "__start__", "to": "Loader"},
            {"from": "Loader", "to": "Plain"},
            {"from": "Plain", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    assert compiled.ok
    by_name = {
        n["node_name"]: n for n in compiled.save_flow_lists(1)["python_node_list"]
    }
    assert by_name["Loader"]["use_storage"] is True
    # Defaults to False so a non-storage node never accidentally grabs a handle.
    assert by_name["Plain"]["use_storage"] is False


def test_webhook_trigger_path_lands_on_nested_webhook_trigger_object():
    spec = {
        "name": "hook path",
        "variables": {"intake": {"q": ""}},
        "nodes": [
            {
                "type": "webhook_trigger",
                "name": "Hook",
                "code": "def main(trigger_payload=None):\n    return {'intake': {'q': ''}}\n",
                "path": "my-hook",
            },
            {
                "type": "python",
                "name": "Process",
                "code": "def main(q=None):\n    return {'ok': True}\n",
                "input_map": {"q": "variables.intake.q"},
                "output_variable_path": "variables.out",
            },
        ],
        "edges": [
            {"from": "__start__", "to": "Process"},
            {"from": "Hook", "to": "Process"},
            {"from": "Process", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    assert compiled.ok
    (hook,) = compiled.save_flow_lists(1)["webhook_trigger_node_list"]
    # The path must live on the nested object, NOT a flat webhook_path key.
    assert hook["webhook_trigger"] == {"path": "my-hook"}
    assert "webhook_path" not in hook


def test_webhook_trigger_without_path_omits_webhook_trigger_key():
    spec = {
        "name": "hook no path",
        "variables": {},
        "nodes": [
            {
                "type": "webhook_trigger",
                "name": "Hook",
                "code": "def main(trigger_payload=None):\n    return {}\n",
            },
        ],
        "edges": [
            {"from": "Hook", "to": "__end__"},
            {"from": "__start__", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    (hook,) = compiled.save_flow_lists(1)["webhook_trigger_node_list"]
    assert "webhook_trigger" not in hook


def test_trigger_flow_missing_start_leg_is_caught_offline_as_disconnected():
    # A trigger flow wired ONLY from the trigger (no __start__ leg) leaves the
    # start node with no edge — the compiler must flag it, mirroring the backend
    # "No node connected to start node" runtime error.
    spec = {
        "name": "trigger no start leg",
        "variables": {"intake": {"q": ""}},
        "nodes": [
            {
                "type": "webhook_trigger",
                "name": "Hook",
                "code": "def main(trigger_payload=None):\n    return {'intake': {'q': ''}}\n",
            },
            {
                "type": "python",
                "name": "Process",
                "code": "def main(q=None):\n    return {'ok': True}\n",
                "input_map": {"q": "variables.intake.q"},
                "output_variable_path": "variables.out",
            },
        ],
        "edges": [
            {"from": "Hook", "to": "Process"},
            {"from": "Process", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    assert not compiled.ok
    assert "disconnected_node" in _error_codes(compiled.findings)


def test_dual_wired_trigger_flow_compiles_clean():
    spec = {
        "name": "trigger dual wired",
        "variables": {"intake": {"q": ""}, "out": {}},
        "output_map": {"answer": "variables.out.answer"},
        "nodes": [
            {
                "type": "webhook_trigger",
                "name": "Hook",
                "code": "def main(trigger_payload=None):\n    return {'intake': {'q': ''}}\n",
                "path": "dual",
            },
            {
                "type": "python",
                "name": "Process",
                "code": "def main(q=None):\n    return {'answer': str(q)}\n",
                "input_map": {"q": "variables.intake.q"},
                "output_variable_path": "variables.out",
            },
        ],
        "edges": [
            {"from": "__start__", "to": "Process"},
            {"from": "Hook", "to": "Process"},
            {"from": "Process", "to": "__end__"},
        ],
    }
    compiled = _compile(spec)
    assert compiled.ok, _error_codes(compiled.findings)
    edges = compiled.save_flow_lists(1)["edge_list"]
    temp = compiled.node_temp_ids
    ends = {(e["start_temp_id"], e["end_temp_id"]) for e in edges}
    # Both the __start__ leg and the trigger leg must reach Process.
    assert (temp["__start__"], temp["Process"]) in ends
    assert (temp["Hook"], temp["Process"]) in ends


# ---------------------------------------------------------------------------
# Flow-name collision pre-flight + auto_suffix
# ---------------------------------------------------------------------------


def _graph_light(names):
    return {"results": [{"id": i, "name": n} for i, n in enumerate(names, start=1)]}


@respx.mock
async def test_name_conflict_returns_finding_and_creates_nothing():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json=_graph_light([EXAMPLE_FLOW_SPEC["name"]]))
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 1, "save_version": 1})
    )

    result = await create_flow_from_spec(EXAMPLE_FLOW_SPEC)

    assert result["ok"] is False
    assert "flow_name_conflict" in _error_codes(result["findings"])
    assert "No flow was created" in result["summary"]
    # The colliding name never reached a shell POST.
    assert not shell_route.called


@respx.mock
async def test_free_name_passes_preflight_and_materializes():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json=_graph_light(["Some Other Flow"]))
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(
            201, json={"id": 7, "name": EXAMPLE_FLOW_SPEC["name"], "save_version": 1}
        )
    )
    respx.post(f"{BASE_URL}api/graphs/7/save/").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 7,
                "start_node_list": [{"id": 1, "node_name": "__start__"}],
                "end_node_list": [{"id": 2, "node_name": "__end_node__"}],
            },
        )
    )

    result = await create_flow_from_spec(EXAMPLE_FLOW_SPEC)

    assert result["ok"] is True
    assert result["flow_id"] == 7
    assert result["name"] == EXAMPLE_FLOW_SPEC["name"]
    shell_payload = json.loads(shell_route.calls[0].request.content)
    assert shell_payload["name"] == EXAMPLE_FLOW_SPEC["name"]


@respx.mock
async def test_auto_suffix_disambiguates_a_colliding_name():
    # Both the base name and " (2)" are taken -> resolves to " (3)".
    base = EXAMPLE_FLOW_SPEC["name"]
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json=_graph_light([base, f"{base} (2)"]))
    )
    shell_route = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 9, "save_version": 1})
    )
    respx.post(f"{BASE_URL}api/graphs/9/save/").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 9,
                "start_node_list": [{"id": 1, "node_name": "__start__"}],
                "end_node_list": [{"id": 2, "node_name": "__end_node__"}],
            },
        )
    )

    result = await create_flow_from_spec(EXAMPLE_FLOW_SPEC, auto_suffix=True)

    assert result["ok"] is True
    assert result["name"] == f"{base} (3)"
    shell_payload = json.loads(shell_route.calls[0].request.content)
    assert shell_payload["name"] == f"{base} (3)"
    assert "renamed from" in result["summary"]


@respx.mock
async def test_storage_paths_are_created_and_attached_after_save():
    spec = {
        "name": "MCPTEST-storage-attach",
        "variables": {"memory": {}},
        "storage_paths": ["mcptest_mem/"],
        "nodes": [
            {
                "type": "python",
                "name": "Loader",
                "code": "def main():\n    return {}\n",
                "output_variable_path": "variables.memory",
                "use_storage": True,
            }
        ],
        "edges": [
            {"from": "__start__", "to": "Loader"},
            {"from": "Loader", "to": "__end__"},
        ],
    }
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 21, "save_version": 1})
    )
    respx.post(f"{BASE_URL}api/graphs/21/save/").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 21,
                "start_node_list": [{"id": 1, "node_name": "__start__"}],
                "end_node_list": [{"id": 2, "node_name": "__end_node__"}],
                "python_node_list": [{"id": 3, "node_name": "Loader"}],
            },
        )
    )
    mkdir_route = respx.post(f"{BASE_URL}api/storage/mkdir/").mock(
        return_value=httpx.Response(200, json={"path": "mcptest_mem/"})
    )
    attach_route = respx.post(f"{BASE_URL}api/storage/add-to-graph/").mock(
        return_value=httpx.Response(200, json={"attached": ["mcptest_mem/"]})
    )

    result = await create_flow_from_spec(spec)

    assert result["ok"] is True
    assert mkdir_route.called
    assert attach_route.called
    attach_payload = json.loads(attach_route.calls[0].request.content)
    assert attach_payload["paths"] == ["mcptest_mem/"]
    assert attach_payload["graph_ids"] == [21]
    assert result["storage"] == {
        "attached": ["mcptest_mem/"],
        "created": ["mcptest_mem/"],
    }


@respx.mock
async def test_storage_folder_already_exists_is_tolerated():
    spec = {
        "name": "MCPTEST-storage-409",
        "variables": {"memory": {}},
        "storage_paths": ["mcptest_mem/"],
        "nodes": [
            {
                "type": "python",
                "name": "Loader",
                "code": "def main():\n    return {}\n",
                "output_variable_path": "variables.memory",
                "use_storage": True,
            }
        ],
        "edges": [
            {"from": "__start__", "to": "Loader"},
            {"from": "Loader", "to": "__end__"},
        ],
    }
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 22, "save_version": 1})
    )
    respx.post(f"{BASE_URL}api/graphs/22/save/").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 22,
                "start_node_list": [{"id": 1, "node_name": "__start__"}],
                "end_node_list": [{"id": 2, "node_name": "__end_node__"}],
            },
        )
    )
    respx.post(f"{BASE_URL}api/storage/mkdir/").mock(
        return_value=httpx.Response(409, json={"detail": "already exists"})
    )
    attach_route = respx.post(f"{BASE_URL}api/storage/add-to-graph/").mock(
        return_value=httpx.Response(200, json={"attached": ["mcptest_mem/"]})
    )

    result = await create_flow_from_spec(spec)

    assert result["ok"] is True
    assert attach_route.called
    # A pre-existing folder is not reported as freshly created.
    assert result["storage"]["created"] == []


# ---------------------------------------------------------------------------
# Task-placeholder pre-flight: a crew node whose input_map can't satisfy a
# REQUIRED task/agent template placeholder is a guaranteed runtime crash
# (CrewAI's str.format(**inputs) raises) — validate_flow can't see it because
# the placeholder lives inside the referenced crew, not the graph. This closes
# it offline. Agent/task nodes use a safe renderer, so their mismatches are
# warnings, never blocking errors.
# ---------------------------------------------------------------------------


def _warning_codes(findings: list[dict]) -> set[str]:
    return {f["code"] for f in findings if f["severity"] == "warning"}


# Mirrors the real crew 8 ("MYM Intent Classifier"): task instructions carry the
# {user_input} placeholder; expected_output is literal JSON braces (lenient).
_CREW8_TASK = {
    "id": 12,
    "name": "Classify",
    "instructions": "Analyze the message and classify it.\n\nMessage:\n{user_input}",
    "expected_output": 'Strict JSON: {"intent": "<one>", "language": "<lang>"}',
    "knowledge_query": None,
    "agent": 12,
    "crew": 8,
}
_CREW8_AGENT = {
    "id": 12,
    "role": "Customer Intent Classifier",
    "goal": "Classify each message into one supported intent.",
    "backstory": "You are the front door of the assistant.",
}


def _mock_crew8_templates(task: dict | None = None, agent: dict | None = None):
    """Register the crew-8 existence + template routes the placeholder pre-flight
    reads (crew detail, its task list, and the task's agent)."""
    respx.get(f"{BASE_URL}api/crews/8/").mock(
        return_value=httpx.Response(
            200, json={"id": 8, "name": "MYM Intent Classifier"}
        )
    )
    respx.get(f"{BASE_URL}api/tasks/").mock(
        return_value=httpx.Response(
            200, json={"count": 1, "results": [task or _CREW8_TASK]}
        )
    )
    respx.get(f"{BASE_URL}api/agents/12/").mock(
        return_value=httpx.Response(200, json=agent or _CREW8_AGENT)
    )


def _crew_ph_spec(input_map: dict, extra_variables: dict | None = None) -> dict:
    variables = {"inbox": {"message": ""}, "result": None}
    if extra_variables:
        variables.update(extra_variables)
    return {
        "name": "MCPTEST-crew-ph",
        "variables": variables,
        "output_map": {"o": "variables.result.message"},
        "nodes": [
            {
                "type": "crew",
                "name": "Classifier",
                "crew_id": 8,
                "input_map": input_map,
                "output_variable_path": "variables.result",
            }
        ],
        "edges": [
            {"from": "__start__", "to": "Classifier"},
            {"from": "Classifier", "to": "__end__"},
        ],
    }


def _mock_materialize(flow_id: int = 70):
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    shell = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": flow_id, "save_version": 1})
    )
    save = respx.post(f"{BASE_URL}api/graphs/{flow_id}/save/").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": flow_id,
                "start_node_list": [{"id": 1, "node_name": "__start__"}],
                "end_node_list": [{"id": 2, "node_name": "__end_node__"}],
                "crew_node_list": [{"id": 3, "node_name": "Classifier"}],
                "agent_node_list": [{"id": 3, "node_name": "Worker"}],
            },
        )
    )
    return shell, save


def test_extract_format_placeholders_mirrors_str_format():
    # Base identifier of each field; escapes/positional/non-identifier ignored.
    assert _extract_format_placeholders("hi {user_input}") == {"user_input"}
    assert _extract_format_placeholders("{a.b} {c[0]} {d}") == {"a", "c", "d"}
    assert _extract_format_placeholders("literal {{braces}} only") == set()
    assert _extract_format_placeholders('JSON {"intent": "x"}') == set()
    assert _extract_format_placeholders("positional {0} {}") == set()
    # A malformed template (single brace) yields nothing rather than a guess.
    assert _extract_format_placeholders("broken { thing") == set()


@respx.mock
async def test_crew_missing_placeholder_rejected_offline_creating_nothing():
    _mock_crew8_templates()
    shell, _ = _mock_materialize()

    # Wrong key: maps 'text' where the crew task requires '{user_input}'.
    result = await create_flow_from_spec(
        _crew_ph_spec({"text": "variables.inbox.message"})
    )

    assert result["ok"] is False
    assert "missing_task_placeholder" in _error_codes(result["findings"])
    finding = next(
        f for f in result["findings"] if f["code"] == "missing_task_placeholder"
    )
    assert finding["node"] == "Classifier"
    assert "user_input" in finding["message"]
    # Nothing materialized: no shell POST happened.
    assert not shell.called


@respx.mock
async def test_crew_correct_placeholder_passes_preflight_and_materializes():
    _mock_crew8_templates()
    shell, save = _mock_materialize()

    result = await create_flow_from_spec(
        _crew_ph_spec({"user_input": "variables.inbox.message"})
    )

    assert result["ok"] is True, result["findings"]
    assert "missing_task_placeholder" not in _error_codes(result["findings"])
    assert shell.called
    assert save.called


@respx.mock
async def test_crew_unused_input_map_key_is_a_warning_not_blocking():
    _mock_crew8_templates()
    shell, save = _mock_materialize()

    result = await create_flow_from_spec(
        _crew_ph_spec(
            {
                "user_input": "variables.inbox.message",
                "typo_key": "variables.inbox.message",
            }
        )
    )

    assert result["ok"] is True, result["findings"]
    assert "unused_input_map_key" in _warning_codes(result["findings"])
    warning = next(f for f in result["findings"] if f["code"] == "unused_input_map_key")
    assert "typo_key" in warning["message"]
    assert shell.called and save.called


@respx.mock
async def test_crew_placeholder_present_in_namespace_downgrades_to_warning():
    """False-positive guard: the datum is in scope (a start variable named
    'user_input') but not mapped — ambiguous intent, so warn, don't hard-error."""
    _mock_crew8_templates()
    shell, save = _mock_materialize()

    result = await create_flow_from_spec(
        _crew_ph_spec(
            {"text": "variables.inbox.message"},
            extra_variables={"user_input": ""},
        )
    )

    assert result["ok"] is True, result["findings"]
    assert "missing_task_placeholder" not in _error_codes(result["findings"])
    assert "unmapped_task_placeholder" in _warning_codes(result["findings"])
    assert shell.called and save.called


@respx.mock
async def test_crew_empty_input_map_never_errors():
    """CrewAI skips interpolation for an empty input dict, so it can't crash —
    surfaced as a warning, never a blocking error."""
    _mock_crew8_templates()
    shell, save = _mock_materialize()

    result = await create_flow_from_spec(_crew_ph_spec({}))

    assert result["ok"] is True, result["findings"]
    assert "missing_task_placeholder" not in _error_codes(result["findings"])
    assert "uninterpolated_task_placeholders" in _warning_codes(result["findings"])
    assert shell.called and save.called


@respx.mock
async def test_crew_undeterminable_templates_skipped_silently():
    """A 5xx while fetching templates is not a spec defect — skip the check,
    materialize as before (never hard-error on the unprovable)."""
    respx.get(f"{BASE_URL}api/crews/8/").mock(
        return_value=httpx.Response(200, json={"id": 8, "name": "crew"})
    )
    respx.get(f"{BASE_URL}api/tasks/").mock(
        return_value=httpx.Response(500, json={"detail": "boom"})
    )
    shell, save = _mock_materialize()

    result = await create_flow_from_spec(
        _crew_ph_spec({"text": "variables.inbox.message"})
    )

    assert result["ok"] is True, result["findings"]
    assert "missing_task_placeholder" not in _error_codes(result["findings"])
    assert shell.called and save.called


@respx.mock
async def test_missing_crew_skips_placeholder_check_no_template_fetch():
    """A missing crew is reported by the entity-ref pass; the placeholder pass
    must NOT then fetch its (non-existent) templates."""
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.get(f"{BASE_URL}api/crews/8/").mock(
        return_value=httpx.Response(404, json={"detail": "not found"})
    )
    tasks_route = respx.get(f"{BASE_URL}api/tasks/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    shell = respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json={"id": 1, "save_version": 1})
    )

    result = await create_flow_from_spec(
        _crew_ph_spec({"text": "variables.inbox.message"})
    )

    assert result["ok"] is False
    assert "unknown_entity_reference" in _error_codes(result["findings"])
    assert "missing_task_placeholder" not in _error_codes(result["findings"])
    assert not tasks_route.called
    assert not shell.called


# --- Agent/task nodes: safe renderer -> warnings only, never blocking. --------


def _agent_ph_spec(instructions: str, input_map: dict, extra_vars: dict | None = None):
    variables = {"inbox": {"message": ""}, "out": None}
    if extra_vars:
        variables.update(extra_vars)
    return {
        "name": "MCPTEST-agent-ph",
        "variables": variables,
        "output_map": {"o": "variables.out.message"},
        "nodes": [
            {
                "type": "agent",
                "name": "Worker",
                "agent_definition_id": 5,
                "input_map": input_map,
                "output_variable_path": "variables.out",
                "tasks": [{"name": "t", "instructions": instructions}],
            }
        ],
        "edges": [
            {"from": "__start__", "to": "Worker"},
            {"from": "Worker", "to": "__end__"},
        ],
    }


def _mock_agent_def_and_materialize(flow_id: int = 71):
    respx.get(f"{BASE_URL}api/agent-definitions/5/").mock(
        return_value=httpx.Response(200, json={"id": 5, "name": "Worker def"})
    )
    return _mock_materialize(flow_id)


@respx.mock
async def test_agent_node_unsatisfied_placeholder_is_warning_not_error():
    shell, save = _mock_agent_def_and_materialize()

    result = await create_flow_from_spec(
        _agent_ph_spec("Summarize {missing_thing}", input_map={})
    )

    assert result["ok"] is True, result["findings"]
    assert "unsatisfied_instruction_placeholder" in _warning_codes(result["findings"])
    assert result["findings"] and all(
        f["severity"] == "warning" for f in result["findings"]
    )
    assert shell.called and save.called


@respx.mock
async def test_agent_node_placeholder_satisfied_by_start_var_not_flagged():
    """False-positive guard for agent nodes: the placeholder name is a declared
    start variable, so it is NOT flagged even though input_map doesn't list it."""
    shell, save = _mock_agent_def_and_materialize()

    result = await create_flow_from_spec(
        _agent_ph_spec(
            "Summarize {user_input}",
            input_map={},
            extra_vars={"user_input": ""},
        )
    )

    assert result["ok"] is True, result["findings"]
    assert "unsatisfied_instruction_placeholder" not in _warning_codes(
        result["findings"]
    )
    assert shell.called and save.called


@respx.mock
async def test_agent_node_placeholder_satisfied_by_input_map_not_flagged():
    shell, save = _mock_agent_def_and_materialize()

    result = await create_flow_from_spec(
        _agent_ph_spec(
            "Summarize {user_input}",
            input_map={"user_input": "variables.inbox.message"},
        )
    )

    assert result["ok"] is True, result["findings"]
    assert result["findings"] == []
    assert shell.called and save.called
