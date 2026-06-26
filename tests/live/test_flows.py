"""Live tests for flow tooling (epicstaff_mcp/tools/flows.py) + graph tags/notes/files."""
from __future__ import annotations

import base64

import pytest

from epicstaff_mcp.tools import agents, crews, flows


def _rid(env: dict) -> int:
    """Extract the created object's id from an fv.envelope() return."""
    return env["result"]["id"]


@pytest.fixture
async def flow():
    created = await flows.create_flow(name="Audit Probe Flow", description="probe")
    fid = created["id"]
    yield fid
    try:
        await flows.delete_flow(fid)
    except Exception:
        pass


# ----------------------------------------------------------- build lifecycle

async def test_flow_build_lifecycle(flow):
    fid = flow

    start = await flows.add_node(fid, "startnode", {"variables": {"topic": "AI"}}, node_name="start")
    start_id = _rid(start)
    py = await flows.add_node(
        fid, "pythonnode",
        {"python_code": {"code": "def main(variables):\n    return {'topic': variables['topic']}\n",
                         "entrypoint": "main", "libraries": []}},
        node_name="process",
    )
    py_id = _rid(py)
    end = await flows.add_node(fid, "endnode", {"output_map": {}}, node_name="finish")
    end_id = _rid(end)

    e1 = await flows.add_edge(fid, start_id, py_id)
    e2 = await flows.add_edge(fid, py_id, end_id)

    # reads
    full = await flows.get_flow(fid)
    assert full["id"] == fid
    nodes = await flows.get_flow_nodes(fid, compact=True)
    assert "name_to_id" in nodes
    edges = await flows.list_edges(fid)
    assert len(edges["edges"]) == 2

    conns = await flows.get_flow_connections(fid)
    assert isinstance(conns, dict)
    desc = await flows.describe_flow(fid)
    assert isinstance(desc, dict)
    node = await flows.get_node(fid, py_id)
    assert isinstance(node, dict)

    # patches
    patched = await flows.patch_python_node(
        fid, py_id, code="def main(variables):\n    return {'ok': True}\n", libraries=[]
    )
    assert patched["result"]
    await flows.patch_node_libraries(fid, py_id, libraries=["requests"])
    await flows.patch_node_metadata(fid, py_id, position={"x": 100, "y": 200}, color="#abcdef")
    await flows.patch_start_variables(fid, variables={"topic": "robotics"})

    # validation
    structure = await flows.test_flow(fid)
    assert "ok" in structure
    paths = await flows.validate_flow_paths(fid)
    assert "status" in paths

    # ui init + metadata update + node update
    await flows.init_flow_metadata(fid)
    meta = await flows.update_flow_metadata(fid, description="probe v2")
    assert meta["description"] == "probe v2"
    await flows.update_node(fid, end_id, "endnode", {"output_map": {"result": "variables.topic"}})

    # export / copy / import
    exported = await flows.export_flow(fid)
    assert isinstance(exported, dict)
    bulk = await flows.bulk_export_flows([fid])
    assert isinstance(bulk, dict)

    copy = await flows.copy_flow(fid, name="Audit Probe Flow Copy")
    copy_id = copy.get("id")
    if copy_id:
        await flows.delete_flow(copy_id)

    imported = await flows.import_flow(exported)
    imp_id = imported.get("result", {}).get("id") if "result" in imported else imported.get("id")
    if imp_id:
        await flows.delete_flow(imp_id)

    # teardown of structure
    await flows.delete_edge(fid, _rid(e2))
    await flows.delete_node(fid, end_id, "endnode")


async def test_crew_node_and_get_crew_node(flow, llm_config_id):
    fid = flow
    agent = await agents.create_agent(role="Flow Agent", goal="g", backstory="b", llm_config=llm_config_id)
    crew = await crews.create_crew(name="Flow Probe Crew", agents=[agent["id"]])
    try:
        cn = await flows.add_node(fid, "crewnode", {"crew_id": crew["id"]}, node_name="crewstep")
        cn_id = _rid(cn)
        got = await flows.get_crew_node(fid, cn_id)
        assert isinstance(got, dict)
    finally:
        await crews.delete_crew(crew["id"])
        await agents.delete_agent(agent["id"])


# ----------------------------------------------------------- save_flow (bulk)

async def test_save_flow_bulk(flow):
    fid = flow
    result = await flows.save_flow(
        fid,
        start_node_list=[{"graph": fid, "node_name": "start", "variables": {"x": 1}}],
        end_node_list=[{"graph": fid, "node_name": "end", "output_map": {}}],
        allow_incomplete=True,
    )
    assert result["result"] is not None
    assert result.get("gate") in ("passed", "override", "blocked")


# ----------------------------------------------------------- tags/notes/files

async def test_decision_table_routing(flow):
    fid = flow
    start = await flows.add_node(fid, "startnode", {"variables": {"score": 5}}, node_name="start")
    # a graph allows only one end node — use a python node as the second target
    py = await flows.add_node(
        fid, "pythonnode",
        {"python_code": {"code": "def main(variables):\n    return {}\n",
                         "entrypoint": "main", "libraries": []}},
        node_name="high",
    )
    end_b = await flows.add_node(fid, "endnode", {"output_map": {}}, node_name="low")
    dt = await flows.add_node(fid, "decisiontablenode", {}, node_name="router")
    dt_id = _rid(dt)
    high_id, low_id = _rid(py), _rid(end_b)

    # route by node ID (start/end node_name is read-only/computed, so name
    # resolution isn't reliable for those types — ids always work)
    patched = await flows.patch_dt_node(
        fid,
        dt_id,
        condition_groups=[
            {"group_name": "high", "expression": "variables['score'] > 3", "next_node_id": high_id}
        ],
        default_next_node=low_id,
    )
    assert patched["result"] is not None

    route_map = await flows.get_cdt_route_map(fid)
    assert isinstance(route_map, dict)


async def test_conditional_edge(flow):
    fid = flow
    start = await flows.add_node(fid, "startnode", {"variables": {"x": 1}}, node_name="start")
    ce = await flows.add_conditional_edge(
        fid, _rid(start),
        python_code="def main(variables):\n    return 'end'\n",
    )
    assert ce["result"] is not None
    edges = await flows.list_edges(fid)
    assert len(edges["conditional_edges"]) >= 1


async def test_graph_tags():
    created = await flows.create_graph_tag(name="audit-graph-tag")
    tag_id = created["id"]
    try:
        listed = await flows.list_graph_tags()
        assert any(t["id"] == tag_id for t in listed["results"])
    finally:
        await flows.delete_graph_tag(tag_id)


async def test_graph_notes(flow):
    fid = flow
    note = await flows.create_graph_note(fid, content="audit note", position_x=10.0, position_y=20.0)
    note_id = note["id"]
    try:
        upd = await flows.update_graph_note(note_id, content="audit note v2")
        assert upd["content"] == "audit note v2"
        listed = await flows.list_graph_notes(flow_id=fid)
        assert any(n["id"] == note_id for n in listed.get("results", []))
    finally:
        msg = await flows.delete_graph_note(note_id)
        assert "deleted" in msg["message"]


async def test_graph_files(flow):
    fid = flow
    b64 = base64.b64encode(b"audit graph file content").decode()
    uploaded = await flows.upload_graph_file(fid, b64, "audit_probe_file.txt")
    paths = uploaded["paths"]
    assert paths, f"upload returned no storage paths: {uploaded}"
    path = paths[0]
    try:
        listed = await flows.list_graph_files(fid)
        # graph-files returns a list (wrapped under results by the client)
        items = listed.get("results", listed if isinstance(listed, list) else [])
        assert isinstance(items, list)
    finally:
        msg = await flows.delete_graph_file(fid, path)
        assert "Detached" in msg["message"]
