"""Live tests for sessions, session-debug, and memory.

Builds a tiny python-only flow (no LLM cost), runs it for real against the
worker, then exercises the session read/debug surface.
Covers epicstaff_mcp/tools/sessions.py, session_debug.py, memory.py.
"""
from __future__ import annotations

import pytest

from epicstaff_mcp.tools import flows, memory, session_debug, sessions


def _rid(env: dict) -> int:
    return env["result"]["id"]


@pytest.fixture
async def runnable_flow():
    """A start -> python -> end flow that runs to completion without an LLM."""
    created = await flows.create_flow(name="Audit Session Flow")
    fid = created["id"]
    start = await flows.add_node(fid, "startnode", {"variables": {"name": "world"}}, node_name="start")
    py = await flows.add_node(
        fid, "pythonnode",
        {"python_code": {
            "code": "def main(variables):\n    return {'greeting': 'hello ' + str(variables.get('name',''))}\n",
            "entrypoint": "main", "libraries": []}},
        node_name="greet",
    )
    end = await flows.add_node(fid, "endnode", {"output_map": {"greeting": "variables.greeting"}}, node_name="done")
    await flows.add_edge(fid, _rid(start), _rid(py))
    await flows.add_edge(fid, _rid(py), _rid(end))
    await flows.init_flow_metadata(fid)
    yield fid
    try:
        await flows.delete_flow(fid)
    except Exception:
        pass


async def test_run_session_and_wait_and_debug(runnable_flow):
    fid = runnable_flow

    result = await sessions.run_session_and_wait(fid, timeout=120, poll_interval=3)
    assert result.get("status") in {"end", "error", "stop", "expired", "wait_for_user"}, result
    session_id = result.get("session_id") or result.get("id")
    assert session_id, f"no session id in {result}"

    # get_session must strip graph_schema by default
    sess = await sessions.get_session(session_id)
    assert "graph_schema" not in sess
    full = await sessions.get_session(session_id, include_graph_schema=True)
    assert isinstance(full, dict)

    # session lists / reads
    listed = await sessions.list_sessions(fid)
    assert any(s.get("id") == session_id for s in listed.get("results", []))
    await sessions.get_session_updates(session_id)
    await sessions.get_session_warnings(session_id)
    await sessions.list_session_messages(session_id)

    # debug family
    inspect = await session_debug.inspect_session(session_id)
    assert "nodes" in inspect
    timings = await session_debug.get_session_timings(session_id)
    assert "total_seconds" in timings
    trace = await session_debug.get_session_trace(session_id)
    assert "trace" in trace
    crew_input = await session_debug.get_session_crew_input(session_id)
    assert "crew_nodes" in crew_input
    pvars = await session_debug.get_flow_persistent_vars(fid)
    assert "persistent_variables" in pvars

    # cleanup
    deleted = await sessions.delete_session(session_id)
    assert isinstance(deleted, dict)


async def test_run_session_and_stop(runnable_flow):
    fid = runnable_flow
    started = await sessions.run_session(flow_id=fid)
    session_id = started.get("id") or started.get("session_id")
    assert session_id, started
    # stop is best-effort (the run may already have finished)
    stopped = await sessions.stop_session(session_id)
    assert isinstance(stopped, dict)
    await sessions.delete_session(session_id)


async def test_run_session_requires_flow():
    from epicstaff_mcp.exceptions import EpicStaffAPIError
    with pytest.raises(EpicStaffAPIError):
        await sessions.run_session()


async def test_list_memories():
    result = await memory.list_memories(limit=5)
    assert isinstance(result, dict)
