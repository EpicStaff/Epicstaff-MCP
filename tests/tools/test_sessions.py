"""Tests for session tools."""
from __future__ import annotations

import httpx
import pytest
import respx

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools.sessions import (
    get_session_updates,
    list_sessions,
    run_session,
    send_message,
    stop_session,
)
from tests.conftest import BASE_URL

SESSION_PAYLOAD = {
    "id": 10,
    "graph_id": 1,
    "status": "run",
    "status_updated_at": "2026-04-08T10:00:00Z",
    "created_at": "2026-04-08T09:59:00Z",
    "finished_at": None,
    "status_data": {},
    "variables": {},
    "token_usage": {},
}


@respx.mock
async def test_list_sessions():
    respx.get(f"{BASE_URL}api/sessions/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [SESSION_PAYLOAD]})
    )
    result = await list_sessions(flow_id=1)
    assert result["count"] == 1


@respx.mock
async def test_run_session_with_flow_id():
    respx.post(f"{BASE_URL}api/run-session/").mock(
        return_value=httpx.Response(201, json=SESSION_PAYLOAD)
    )
    result = await run_session(flow_id=1)
    assert result["id"] == 10


async def test_run_session_without_id_raises():
    with pytest.raises(EpicStaffAPIError, match="flow_id or flow_uuid"):
        await run_session()


@respx.mock
async def test_get_session_updates():
    # Real endpoint (per backend urls.py): GET /api/sessions/<id>/get-updates/
    respx.get(f"{BASE_URL}api/sessions/10/get-updates/").mock(
        return_value=httpx.Response(200, json={"messages": [], "status": "run"})
    )
    result = await get_session_updates(session_id=10)
    assert result["status"] == "run"


@respx.mock
async def test_stop_session():
    # Real endpoint (per backend urls.py): POST /api/sessions/<id>/stop/
    respx.post(f"{BASE_URL}api/sessions/10/stop/").mock(
        return_value=httpx.Response(200, json={"status": "stopped"})
    )
    result = await stop_session(session_id=10)
    assert result["status"] == "stopped"


@respx.mock
async def test_send_message():
    respx.post(f"{BASE_URL}api/answer-to-llm/").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    result = await send_message(
        session_id=10, crew_id=1, execution_order=0, name="user", answer="yes"
    )
    assert result["status"] == "ok"
