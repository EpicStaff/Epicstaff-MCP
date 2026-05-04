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
    get_flow,
    get_flow_nodes,
    list_edges,
    list_flows,
    update_flow_metadata,
    update_node,
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
    assert result["id"] == 10


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
    respx.delete(f"{BASE_URL}api/crewnodes/10/").mock(return_value=httpx.Response(204))
    result = await delete_node(flow_id=1, node_id=10, node_type="crewnode")
    assert "deleted" in result["message"]
    assert "10" in result["message"]


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
    assert result["id"] == 20


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
