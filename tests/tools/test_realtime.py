"""Tests for realtime tools."""

from __future__ import annotations

import json

import httpx
import respx

from epicstaff_mcp.tools.realtime import init_realtime
from tests.conftest import BASE_URL


@respx.mock
async def test_init_realtime_sends_agent_id():
    route = respx.post(f"{BASE_URL}api/init-realtime/").mock(
        return_value=httpx.Response(200, json={"session": "abc"})
    )
    result = await init_realtime(agent_id=7)
    body = json.loads(route.calls.last.request.content)
    assert body == {"agent_id": 7}
    assert result["session"] == "abc"


@respx.mock
async def test_init_realtime_includes_config():
    route = respx.post(f"{BASE_URL}api/init-realtime/").mock(
        return_value=httpx.Response(200, json={"session": "abc"})
    )
    await init_realtime(agent_id=7, config={"voice": "alloy"})
    body = json.loads(route.calls.last.request.content)
    assert body == {"agent_id": 7, "config": {"voice": "alloy"}}
    assert "realtime_agent" not in body
    assert "session_id" not in body
