"""Tests for flow tools including node and edge management."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools.flows import (
    add_conditional_edge,
    add_edge,
    add_node,
    create_flow,
    create_graph_from_version,
    delete_edge,
    delete_node,
    get_cdt_prompts,
    get_flow,
    get_flow_connections,
    get_flow_nodes,
    get_graph_run_status,
    get_graph_version,
    get_schedule_trigger_node,
    list_edges,
    list_flows,
    list_graph_versions,
    patch_cdt_node,
    patch_dt_node,
    restore_graph_version,
    save_graph_version,
    update_flow_metadata,
    update_graph_version,
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
        flow_id=1,
        node_id=10,
        node_type="crewnode",
        config={"stream_config": {"enabled": True}},
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
    respx.post(f"{BASE_URL}api/edges/").mock(
        return_value=httpx.Response(201, json=EDGE)
    )
    result = await add_edge(flow_id=1, start_node_id=10, end_node_id=11)
    assert result["id"] == 20


@respx.mock
async def test_delete_edge():
    respx.delete(f"{BASE_URL}api/edges/20/").mock(return_value=httpx.Response(204))
    result = await delete_edge(flow_id=1, edge_id=20)
    assert "deleted" in result["message"]


@respx.mock
async def test_delete_conditional_edge():
    respx.delete(f"{BASE_URL}api/conditionaledges/5/").mock(
        return_value=httpx.Response(204)
    )
    result = await delete_edge(flow_id=1, edge_id=5, conditional=True)
    assert "deleted" in result["message"]


@respx.mock
async def test_list_flows_with_filters():
    route = respx.get(f"{BASE_URL}api/graph-light/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    await list_flows(label_id=7, no_label=True, epicchat_enabled=True)
    params = route.calls.last.request.url.params
    assert params["label_id"] == "7"
    assert params["no_label"] == "true"
    assert params["epicchat_enabled"] == "true"


# ---------------------------------------------------------------------------
# add_conditional_edge — nested python_code object + source_node_id
# ---------------------------------------------------------------------------
@respx.mock
async def test_add_conditional_edge_payload():
    route = respx.post(f"{BASE_URL}api/conditionaledges/").mock(
        return_value=httpx.Response(201, json={"id": 30, "graph": 1})
    )
    await add_conditional_edge(
        flow_id=1,
        source_node_id=10,
        code="return 'a'",
        entrypoint="main",
        libraries=["requests"],
    )
    body = json.loads(route.calls.last.request.content)
    assert body["graph"] == 1
    assert body["source_node_id"] == 10
    assert "source_node" not in body
    assert body["python_code"] == {
        "code": "return 'a'",
        "entrypoint": "main",
        "libraries": ["requests"],
    }


# ---------------------------------------------------------------------------
# patch_cdt_node — pre/post_python_code objects + prompt_configs list
# ---------------------------------------------------------------------------
@respx.mock
async def test_patch_cdt_node_payload():
    cdt = {"id": 40, "graph": 1, "node_name": "cdt_1"}
    respx.get(f"{BASE_URL}api/classification-decision-table-node/40/").mock(
        return_value=httpx.Response(200, json=cdt)
    )
    route = respx.patch(f"{BASE_URL}api/classification-decision-table-node/40/").mock(
        return_value=httpx.Response(200, json=cdt)
    )
    await patch_cdt_node(
        graph_id=1,
        name_or_id=40,
        pre_python_code={"code": "x=1", "entrypoint": "main", "libraries": []},
        post_python_code={"code": "y=2", "entrypoint": "main", "libraries": []},
        prompt_configs=[{"prompt_key": "k", "prompt_text": "t"}],
    )
    body = json.loads(route.calls.last.request.content)
    assert body["pre_python_code"] == {
        "code": "x=1",
        "entrypoint": "main",
        "libraries": [],
    }
    assert body["post_python_code"] == {
        "code": "y=2",
        "entrypoint": "main",
        "libraries": [],
    }
    assert body["prompt_configs"] == [{"prompt_key": "k", "prompt_text": "t"}]
    assert "pre_computation_code" not in body
    assert "prompts" not in body


# ---------------------------------------------------------------------------
# patch_dt_node — default_next_node_id / next_error_node_id
# ---------------------------------------------------------------------------
@respx.mock
async def test_patch_dt_node_payload():
    dt_node = {"id": 50, "graph": 1, "node_name": "dt_1"}
    graph = {
        **FULL_FLOW,
        "decision_table_node_list": [dt_node],
        "classification_decision_table_node_list": [],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )
    route = respx.patch(f"{BASE_URL}api/decision-table-node/50/").mock(
        return_value=httpx.Response(200, json=dt_node)
    )
    await patch_dt_node(
        graph_id=1,
        name_or_id=50,
        condition_groups=[{"group_name": "g1"}],
        default_next_node_id=11,
        next_error_node_id=12,
    )
    body = json.loads(route.calls.last.request.content)
    assert body["default_next_node_id"] == 11
    assert body["next_error_node_id"] == 12
    assert "default_next_node" not in body
    assert "next_error_node" not in body
    # conditions key auto-added to groups
    assert body["condition_groups"][0]["conditions"] == []


# ---------------------------------------------------------------------------
# Read-side parsing — get_flow_connections
# ---------------------------------------------------------------------------
@respx.mock
async def test_get_flow_connections_parses_id_fields():
    graph = {
        **FULL_FLOW,
        "start_node_list": [{"id": 1, "node_name": "__start__"}],
        "end_node_list": [{"id": 2, "node_name": "__end__"}],
        "conditional_edge_list": [
            {"id": 60, "source_node_id": 1, "python_code": {"code": "return 'x'"}}
        ],
        "decision_table_node_list": [
            {
                "id": 3,
                "node_name": "dt_1",
                "condition_groups": [{"group_name": "g1", "next_node_id": 2}],
                "default_next_node_id": 2,
                "next_error_node_id": 1,
            }
        ],
        "classification_decision_table_node_list": [],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )
    result = await get_flow_connections(graph_id=1)
    cond = result["conditional_edges"][0]
    assert cond["from"] == "__start__"
    assert cond["python_code"] == {"code": "return 'x'"}
    assert "to" not in cond
    dt = result["dt_routing"][0]
    assert dt["default"] == "__end__"
    assert dt["error"] == "__start__"
    assert dt["groups"][0]["next_node"] == "__end__"


# ---------------------------------------------------------------------------
# Read-side parsing — get_cdt_prompts
# ---------------------------------------------------------------------------
@respx.mock
async def test_get_cdt_prompts_reads_prompt_configs():
    cdt = {
        "id": 40,
        "node_name": "cdt_1",
        "prompt_configs": [{"prompt_key": "k", "prompt_text": "t"}],
    }
    respx.get(f"{BASE_URL}api/classification-decision-table-node/40/").mock(
        return_value=httpx.Response(200, json=cdt)
    )
    result = await get_cdt_prompts(graph_id=1, name_or_id=40)
    assert result["prompt_configs"] == [{"prompt_key": "k", "prompt_text": "t"}]


# ---------------------------------------------------------------------------
# Graph versions
# ---------------------------------------------------------------------------
GRAPH_VERSION = {
    "id": 70,
    "graph_id": 1,
    "name": "v1",
    "description": "",
    "created_at": "2026-04-08T10:00:00Z",
}


@respx.mock
async def test_list_graph_versions():
    route = respx.get(f"{BASE_URL}api/graph-versions/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [GRAPH_VERSION]})
    )
    result = await list_graph_versions(flow_id=1)
    assert result["results"][0]["id"] == 70
    assert route.calls.last.request.url.params["graph_id"] == "1"


@respx.mock
async def test_get_graph_version():
    respx.get(f"{BASE_URL}api/graph-versions/70/").mock(
        return_value=httpx.Response(200, json=GRAPH_VERSION)
    )
    result = await get_graph_version(version_id=70)
    assert result["id"] == 70


@respx.mock
async def test_save_graph_version_payload():
    route = respx.post(f"{BASE_URL}api/graph-versions/").mock(
        return_value=httpx.Response(201, json=GRAPH_VERSION)
    )
    await save_graph_version(flow_id=1, name="v1", description="notes")
    body = json.loads(route.calls.last.request.content)
    assert body == {"graph_id": 1, "name": "v1", "description": "notes"}


@respx.mock
async def test_update_graph_version():
    route = respx.patch(f"{BASE_URL}api/graph-versions/70/").mock(
        return_value=httpx.Response(200, json={**GRAPH_VERSION, "name": "v2"})
    )
    result = await update_graph_version(version_id=70, name="v2")
    assert result["name"] == "v2"
    body = json.loads(route.calls.last.request.content)
    assert body == {"name": "v2"}


@respx.mock
async def test_restore_graph_version_payload_and_backup_param():
    route = respx.post(f"{BASE_URL}api/graph-versions/70/restore/").mock(
        return_value=httpx.Response(200, json={"restored": True})
    )
    await restore_graph_version(version_id=70, save_version=3, backup=True)
    request = route.calls.last.request
    assert json.loads(request.content) == {"save_version": 3}
    assert request.url.params["backup"] == "true"


@respx.mock
async def test_create_graph_from_version():
    route = respx.post(f"{BASE_URL}api/graph-versions/70/create-graph/").mock(
        return_value=httpx.Response(201, json={"id": 99})
    )
    result = await create_graph_from_version(version_id=70)
    assert result["id"] == 99
    assert json.loads(route.calls.last.request.content) == {}


# ---------------------------------------------------------------------------
# Graph run status & schedule trigger nodes
# ---------------------------------------------------------------------------
@respx.mock
async def test_get_graph_run_status():
    respx.get(f"{BASE_URL}api/graph_runs/run-abc/status/").mock(
        return_value=httpx.Response(200, json={"status": "running"})
    )
    result = await get_graph_run_status(run_id="run-abc")
    assert result["status"] == "running"


@respx.mock
async def test_get_schedule_trigger_node():
    respx.get(f"{BASE_URL}api/schedule-trigger-nodes/5/").mock(
        return_value=httpx.Response(200, json={"id": 5, "graph": 1})
    )
    result = await get_schedule_trigger_node(node_id=5)
    assert result["id"] == 5
