"""Tests for flow tools including node and edge management."""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools.flows import (
    add_edge,
    add_node,
    create_flow,
    delete_edge,
    delete_node,
    describe_flow,
    get_cdt_route_map,
    get_flow,
    get_flow_connections,
    get_flow_nodes,
    list_edges,
    list_flows,
    save_flow,
    update_flow_metadata,
    update_node,
    validate_flow_paths,
)
from tests.conftest import BASE_URL

FLOW_LIGHT = {
    "id": 1,
    "name": "My Flow",
    "description": None,
    "tags": [],
    "epicchat_enabled": False,
    "created_at": "2026-04-08T10:00:00Z",
    "updated_at": "2026-04-08T10:00:00Z",
}

FULL_FLOW = {
    **FLOW_LIGHT,
    "uuid": "abc-123",
    "metadata": {},
    "time_to_live": 3600,
    "persistent_variables": False,
    "crew_node_list": [],
    "python_node_list": [],
    "start_node_list": [],
    "end_node_list": [],
    "subgraph_node_list": [],
    "code_agent_node_list": [],
    "file_extractor_node_list": [],
    "audio_transcription_node_list": [],
    "decision_table_node_list": [],
    "telegram_trigger_node_list": [],
    "webhook_trigger_node_list": [],
    "edge_list": [],
    "conditional_edge_list": [],
    "graph_note_list": [],
}

CREW_NODE = {
    "id": 10,
    "graph": 1,
    "node_name": "crewnode_1",
    "crew_id": 2,
    "input_map": {},
    "metadata": {},
    "stream_config": {},
    "output_variable_path": None,
}

EDGE = {"id": 20, "graph": 1, "start_node_id": 10, "end_node_id": 11}


@respx.mock
async def test_list_flows():
    respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [FLOW_LIGHT]})
    )
    result = await list_flows()
    assert result["count"] == 1
    assert result["results"][0]["name"] == "My Flow"


@respx.mock
async def test_get_flow_returns_full_flow():
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=FULL_FLOW)
    )
    result = await get_flow(flow_id=1)
    assert result["id"] == 1
    assert "crew_node_list" in result


@respx.mock
async def test_create_flow():
    respx.post(f"{BASE_URL}api/graphs/").mock(
        return_value=httpx.Response(201, json=FLOW_LIGHT)
    )
    result = await create_flow(name="My Flow")
    assert result["name"] == "My Flow"


@respx.mock
async def test_update_flow_metadata():
    updated = {**FLOW_LIGHT, "name": "Renamed Flow"}
    # update_flow_metadata first GETs the graph to read save_version (required
    # for the optimistic-concurrency PATCH), then PATCHes.
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json={**FLOW_LIGHT, "save_version": 3})
    )
    respx.patch(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=updated)
    )
    result = await update_flow_metadata(flow_id=1, name="Renamed Flow")
    assert result["name"] == "Renamed Flow"


@respx.mock
async def test_get_flow_nodes_returns_node_lists():
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=FULL_FLOW)
    )
    result = await get_flow_nodes(flow_id=1)
    assert "crew_node_list" in result
    assert "edge_list" in result
    # Should not include non-node metadata fields
    assert "name" not in result
    assert "id" not in result


@respx.mock
async def test_add_node_crewnode():
    respx.post(f"{BASE_URL}api/crewnodes/").mock(
        return_value=httpx.Response(201, json=CREW_NODE)
    )
    result = await add_node(flow_id=1, node_type="crewnode", config={"crew_id": 2})
    # Write tools now return a semantic envelope; raw API echo lives under "result".
    assert result["result"]["id"] == 10
    assert result["status"] in ("ok", "warning")
    assert result["suggested_next"]


@respx.mock
async def test_add_node_sends_graph_id():
    route = respx.post(f"{BASE_URL}api/crewnodes/").mock(
        return_value=httpx.Response(201, json=CREW_NODE)
    )
    await add_node(flow_id=1, node_type="crewnode", config={"crew_id": 2})
    body = json.loads(route.calls.last.request.content)
    assert body["graph"] == 1
    assert body["crew_id"] == 2


async def test_add_node_invalid_type_raises():
    with pytest.raises(EpicStaffAPIError, match="Unknown node_type"):
        await add_node(flow_id=1, node_type="invalidnode", config={})


@respx.mock
async def test_update_node():
    updated_node = {**CREW_NODE, "stream_config": {"enabled": True}}
    respx.patch(f"{BASE_URL}api/crewnodes/10/").mock(
        return_value=httpx.Response(200, json=updated_node)
    )
    result = await update_node(
        flow_id=1, node_id=10, node_type="crewnode", config={"stream_config": {"enabled": True}}
    )
    assert result["stream_config"]["enabled"] is True


@respx.mock
async def test_delete_node():
    # delete_node now lists edges first to cascade-remove any that reference the
    # node; mock both edge endpoints (empty) plus the node delete.
    respx.get(f"{BASE_URL}api/edges/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.get(f"{BASE_URL}api/conditionaledges/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    respx.delete(f"{BASE_URL}api/crewnodes/10/").mock(return_value=httpx.Response(204))
    result = await delete_node(flow_id=1, node_id=10, node_type="crewnode")
    assert "deleted" in result["message"]
    assert "10" in result["message"]
    assert result["removed_edges"] == []


@respx.mock
async def test_delete_node_cascades_referencing_edges():
    # Two edges touch node 10 (as start and as end) plus one unrelated edge;
    # delete_node must delete only the two and then the node.
    edges = [
        {"id": 100, "start_node_id": 10, "end_node_id": 20, "graph": 1},
        {"id": 101, "start_node_id": 5, "end_node_id": 10, "graph": 1},
        {"id": 102, "start_node_id": 5, "end_node_id": 20, "graph": 1},
    ]
    respx.get(f"{BASE_URL}api/edges/").mock(
        return_value=httpx.Response(200, json={"results": edges})
    )
    respx.get(f"{BASE_URL}api/conditionaledges/").mock(
        return_value=httpx.Response(
            200,
            json={"results": [{"id": 200, "source_node": 10, "graph": 1}]},
        )
    )
    del100 = respx.delete(f"{BASE_URL}api/edges/100/").mock(return_value=httpx.Response(204))
    del101 = respx.delete(f"{BASE_URL}api/edges/101/").mock(return_value=httpx.Response(204))
    del200 = respx.delete(f"{BASE_URL}api/conditionaledges/200/").mock(
        return_value=httpx.Response(204)
    )
    node_del = respx.delete(f"{BASE_URL}api/pythonnodes/10/").mock(
        return_value=httpx.Response(204)
    )
    result = await delete_node(flow_id=1, node_id=10, node_type="pythonnode")
    assert del100.called and del101.called and del200.called and node_del.called
    assert set(result["removed_edges"]) == {100, 101, 200}


@respx.mock
async def test_add_node_codeagent_maps_llm_config_id():
    route = respx.post(f"{BASE_URL}api/code-agent-nodes/").mock(
        return_value=httpx.Response(201, json={"id": 10, "node_name": "CA"})
    )
    await add_node(
        flow_id=1,
        node_type="codeagentnode",
        config={"llm_config_id": 8, "input_map": {"prompt": "variables.q"}},
    )
    body = json.loads(route.calls.last.request.content)
    assert body["llm_config"] == 8  # mapped from llm_config_id
    assert "llm_config_id" not in body


@respx.mock
async def test_add_node_webhook_injects_metadata():
    route = respx.post(f"{BASE_URL}api/webhook-trigger-nodes/").mock(
        return_value=httpx.Response(201, json={"id": 10, "node_name": "WH"})
    )
    await add_node(
        flow_id=1,
        node_type="webhooktriggernode",
        config={"webhook_trigger": {"path": "/x"},
                "python_code": {"code": "def main(b):\n    return {}", "entrypoint": "main", "libraries": []}},
    )
    body = json.loads(route.calls.last.request.content)
    assert body["metadata"] == {}  # injected default


@respx.mock
async def test_add_node_telegram_defaults_field_parent_and_metadata():
    route = respx.post(f"{BASE_URL}api/telegram-trigger-nodes/").mock(
        return_value=httpx.Response(201, json={"id": 33, "node_name": "TG"})
    )
    await add_node(
        flow_id=1,
        node_type="telegramtriggernode",
        config={
            "telegram_bot_api_key": "tok",
            "fields": [{"field_name": "text", "variable_path": "variables.request.q"}],
        },
    )
    body = json.loads(route.calls.last.request.content)
    # Fields stay inline; each gets a default `parent` (the Telegram update type).
    assert body["fields"][0]["parent"] == "message"
    assert body["fields"][0]["field_name"] == "text"
    assert body["metadata"] == {}  # injected default


@respx.mock
async def test_get_cdt_route_map_reads_node_id_and_resolves_names():
    graph = {
        "decision_table_node_list": [
            {
                "id": 419,
                "node_name": "Route",
                "default_next_node_id": 417,
                "next_error_node_id": None,
                "condition_groups": [
                    {"group_name": "positive", "next_node_id": 416},
                ],
            }
        ],
        "classification_decision_table_node_list": [],
        "python_node_list": [
            {"id": 416, "node_name": "Celebrate"},
            {"id": 417, "node_name": "Mitigate"},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/116/").mock(
        return_value=httpx.Response(200, json=graph)
    )
    result = await get_cdt_route_map(graph_id=116)
    dt = result["routing"][0]
    assert dt["routing"]["positive"] == {"node_id": 416, "node_name": "Celebrate"}
    assert dt["default"] == {"node_id": 417, "node_name": "Mitigate"}
    assert dt["error"] is None


@respx.mock
async def test_list_edges():
    respx.get(f"{BASE_URL}api/edges/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [EDGE]})
    )
    respx.get(f"{BASE_URL}api/conditionaledges/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    result = await list_edges(flow_id=1)
    assert len(result["edges"]) == 1
    assert result["edges"][0]["id"] == 20
    assert result["conditional_edges"] == []


@respx.mock
async def test_add_edge():
    respx.post(f"{BASE_URL}api/edges/").mock(return_value=httpx.Response(201, json=EDGE))
    result = await add_edge(flow_id=1, start_node_id=10, end_node_id=11)
    assert result["result"]["id"] == 20
    assert result["status"] == "ok"


@respx.mock
async def test_delete_edge():
    respx.delete(f"{BASE_URL}api/edges/20/").mock(return_value=httpx.Response(204))
    result = await delete_edge(flow_id=1, edge_id=20)
    assert "deleted" in result["message"]


@respx.mock
async def test_delete_conditional_edge():
    respx.delete(f"{BASE_URL}api/conditionaledges/5/").mock(return_value=httpx.Response(204))
    result = await delete_edge(flow_id=1, edge_id=5, conditional=True)
    assert "deleted" in result["message"]


# --- Fixtures for the new inspection / validation tools --------------------

WIRED_FLOW = {
    **FULL_FLOW,
    "start_node_list": [{"id": 1, "node_name": "__start__", "variables": [{"name": "city"}]}],
    "end_node_list": [{"id": 3, "node_name": "__end__", "output_map": {}}],
    "python_node_list": [
        {
            "id": 2,
            "node_name": "Fetch Weather",
            "python_code": {"code": "def main(city):\n    return {}", "libraries": []},
            "input_map": {"city": "variables.city"},
            "output_variable_path": "variables.weather",
        }
    ],
    "edge_list": [
        {"id": 20, "start_node_id": 1, "end_node_id": 2},
        {"id": 21, "start_node_id": 2, "end_node_id": 3},
    ],
}

ORPHAN_FLOW = {
    **FULL_FLOW,
    "start_node_list": [{"id": 1, "node_name": "__start__", "variables": []}],
    "end_node_list": [{"id": 3, "node_name": "__end__", "output_map": {}}],
    "python_node_list": [
        {"id": 2, "node_name": "Lonely Node", "python_code": {"code": "def main():\n    pass"}}
    ],
    "edge_list": [{"id": 20, "start_node_id": 1, "end_node_id": 3}],
}


@respx.mock
async def test_get_flow_connections_shape_unchanged():
    """Pin the public shape so the _index_graph refactor stays byte-compatible."""
    respx.get(f"{BASE_URL}api/graphs/1/").mock(return_value=httpx.Response(200, json=WIRED_FLOW))
    result = await get_flow_connections(graph_id=1)
    assert set(result) == {"edges", "conditional_edges", "cdt_routing", "dt_routing"}
    assert result["edges"][0] == {"id": 20, "from": "__start__", "to": "Fetch Weather"}


@respx.mock
async def test_describe_flow_text_and_orphans():
    respx.get(f"{BASE_URL}api/graphs/1/").mock(return_value=httpx.Response(200, json=ORPHAN_FLOW))
    result = await describe_flow(graph_id=1, fmt="both")
    assert result["summary"]["orphans"] == 1
    assert "Lonely Node" in result["orphans"]
    assert "Flow:" in result["text"]
    assert "flowchart TD" in result["mermaid"]


@respx.mock
async def test_describe_flow_wired_no_orphans():
    respx.get(f"{BASE_URL}api/graphs/1/").mock(return_value=httpx.Response(200, json=WIRED_FLOW))
    result = await describe_flow(graph_id=1)
    assert result["summary"]["orphans"] == 0
    assert result["summary"]["dangling"] == 0


@respx.mock
async def test_validate_flow_paths_undeclared_is_blocker():
    flow = {
        **FULL_FLOW,
        "start_node_list": [{"id": 1, "node_name": "__start__", "variables": [{"name": "other"}]}],
        "python_node_list": [
            {
                "id": 2,
                "node_name": "Reader",
                "python_code": {"code": "def main():\n    pass"},
                "input_map": {"c": "variables.request.city"},
            }
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(return_value=httpx.Response(200, json=flow))
    result = await validate_flow_paths(graph_id=1)
    assert result["status"] == "error"
    assert any(f["severity"] == "blocker" for f in result["findings"])


@respx.mock
async def test_validate_flow_paths_declared_ok():
    respx.get(f"{BASE_URL}api/graphs/1/").mock(return_value=httpx.Response(200, json=WIRED_FLOW))
    result = await validate_flow_paths(graph_id=1)
    assert result["status"] == "ok"


@respx.mock
async def test_save_flow_gate_blocks_incomplete():
    # No end node + disconnected => test_flow fails => gate blocks.
    incomplete = {**FULL_FLOW, "start_node_list": [], "end_node_list": []}
    respx.post(f"{BASE_URL}api/graphs/1/save/").mock(
        return_value=httpx.Response(200, json={"id": 1})
    )
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=incomplete)
    )
    blocked = await save_flow(flow_id=1)
    assert blocked["gate"] == "blocked"
    assert blocked["status"] == "error"

    override = await save_flow(flow_id=1, allow_incomplete=True)
    assert override["gate"] == "override"
    assert override["status"] == "warning"


@respx.mock
async def test_save_flow_gate_passes_when_valid():
    respx.post(f"{BASE_URL}api/graphs/1/save/").mock(
        return_value=httpx.Response(200, json={"id": 1})
    )
    respx.get(f"{BASE_URL}api/graphs/1/").mock(return_value=httpx.Response(200, json=WIRED_FLOW))
    result = await save_flow(flow_id=1)
    assert result["gate"] == "passed"
    assert result["status"] in ("ok", "warning")
