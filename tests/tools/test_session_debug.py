"""Tests for session debug tools."""

from __future__ import annotations

import httpx
import respx

from epicstaff_mcp.tools.session_debug import (
    get_flow_persistent_vars,
    get_session_timings,
)
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


@respx.mock
async def test_get_flow_persistent_vars_reads_flow_declaration():
    # A persistence-enabled flow stores its declaration on its OWN graph: the
    # graph-level bool plus the start node's wrapped `variables`.
    graph = {
        "id": 42,
        "persistent_variables": True,
        "start_node_list": [
            {
                "node_name": "__start__",
                "variables": {
                    "variables": {"context": {"history": [], "prefs": None}},
                    "persistent_variables": {
                        "organization": ["context.prefs"],
                        "user": ["context.history"],
                    },
                },
            }
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/42/").mock(
        return_value=httpx.Response(200, json=graph)
    )
    result = await get_flow_persistent_vars(graph_id=42)
    assert result == {
        "graph_id": 42,
        "enabled": True,
        "persistent_variables": {
            "organization": ["context.prefs"],
            "user": ["context.history"],
        },
    }


@respx.mock
async def test_get_flow_persistent_vars_non_persistent_flow():
    # A flow without persistence has a flat start-node namespace and the bool off.
    graph = {
        "id": 7,
        "persistent_variables": False,
        "start_node_list": [
            {"node_name": "__start__", "variables": {"query": None}}
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/7/").mock(
        return_value=httpx.Response(200, json=graph)
    )
    result = await get_flow_persistent_vars(graph_id=7)
    assert result == {
        "graph_id": 7,
        "enabled": False,
        "persistent_variables": {},
    }
