"""Tests for session debug tools."""

from __future__ import annotations

import httpx
import respx

from epicstaff_mcp.tools.session_debug import get_session_timings
from tests.conftest import BASE_URL


@respx.mock
async def test_get_session_timings_computes_per_node_durations():
    messages = [
        {
            "name": "Node A",
            "created_at": "2026-07-09T00:00:00+00:00",
            "message_data": {"message_type": "start"},
        },
        {
            "name": "Node A",
            "created_at": "2026-07-09T00:00:02+00:00",
            "message_data": {"message_type": "finish"},
        },
        {
            "name": "Node B",
            "created_at": "2026-07-09T00:00:02+00:00",
            "message_data": {"message_type": "start"},
        },
        {
            "name": "Node B",
            "created_at": "2026-07-09T00:00:12+00:00",
            "message_data": {"message_type": "finish"},
        },
    ]
    respx.get(f"{BASE_URL}api/graph-session-messages/").mock(
        return_value=httpx.Response(200, json={"results": messages})
    )

    result = await get_session_timings(session_id=1)

    assert result["total_seconds"] == 12.0
    # Sorted longest-first: Node B (10s) before Node A (2s)
    assert [n["name"] for n in result["nodes"]] == ["Node B", "Node A"]
    assert result["nodes"][0]["duration_seconds"] == 10.0
    assert result["nodes"][1]["duration_seconds"] == 2.0
    assert result["nodes"][0]["pct"] == round(10 / 12 * 100, 1)


@respx.mock
async def test_get_session_timings_empty_session():
    respx.get(f"{BASE_URL}api/graph-session-messages/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    result = await get_session_timings(session_id=1)
    assert result == {"session_id": 1, "total_seconds": 0.0, "nodes": []}
