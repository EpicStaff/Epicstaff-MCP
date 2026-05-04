"""MCP tools for deep session debugging and inspection."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from epicstaff_mcp.client import get_client


async def inspect_session(session_id: int) -> dict[str, Any]:
    """Per-node input and output data for every node that executed in the session."""
    async with get_client() as client:
        response = await client.get(
            "/api/graph-session-messages/",
            params={"session_id": session_id, "ordering": "id"},
        )

    messages = response if isinstance(response, list) else response.get("results", [])

    nodes: dict[str, dict[str, Any]] = {}
    for msg in messages:
        name = msg.get("name", "")
        msg_data = msg.get("message_data") or {}
        msg_type = msg_data.get("message_type", "")

        if name not in nodes:
            nodes[name] = {"name": name, "input": {}, "output": {}, "error": ""}

        if msg_type == "start":
            nodes[name]["input"] = msg_data.get("input") or {}
        elif msg_type == "finish":
            nodes[name]["output"] = msg_data.get("output") or {}
            nodes[name]["error"] = msg_data.get("error") or ""

    return {"session_id": session_id, "nodes": list(nodes.values())}


async def get_session_timings(session_id: int) -> dict[str, Any]:
    """Per-node timing breakdown showing duration of each node execution."""
    async with get_client() as client:
        response = await client.get(
            "/api/graph-session-messages/",
            params={"session_id": session_id, "ordering": "id"},
        )

    messages = response if isinstance(response, list) else response.get("results", [])

    if not messages:
        return {"session_id": session_id, "total_seconds": 0.0, "nodes": []}

    def _parse_ts(ts: str) -> datetime:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))

    node_starts: dict[str, datetime] = {}
    node_durations: dict[str, float] = {}
    all_times: list[datetime] = []

    for msg in messages:
        name = msg.get("name", "")
        created_at = msg.get("created_at", "")
        if not created_at:
            continue
        ts = _parse_ts(created_at)
        all_times.append(ts)

        msg_data = msg.get("message_data") or {}
        msg_type = msg_data.get("message_type", "")

        if msg_type == "start":
            node_starts[name] = ts
        elif msg_type == "finish" and name in node_starts:
            duration = (ts - node_starts[name]).total_seconds()
            node_durations[name] = node_durations.get(name, 0.0) + duration

    total_seconds = (max(all_times) - min(all_times)).total_seconds() if all_times else 0.0

    nodes = [
        {
            "name": name,
            "duration_seconds": duration,
            "pct": round(duration / total_seconds * 100, 1) if total_seconds else 0.0,
        }
        for name, duration in sorted(node_durations.items(), key=lambda x: x[1], reverse=True)
    ]

    return {"session_id": session_id, "total_seconds": total_seconds, "nodes": nodes}


async def get_session_trace(session_id: int) -> dict[str, Any]:
    """Trace message_history variable through session execution showing how it evolves."""
    async with get_client() as client:
        response = await client.get(
            "/api/graph-session-messages/",
            params={"session_id": session_id, "ordering": "id"},
        )

    messages = response if isinstance(response, list) else response.get("results", [])

    trace = []
    for msg in messages:
        name = msg.get("name", "")
        msg_data = msg.get("message_data") or {}
        msg_type = msg_data.get("message_type", "")
        state = msg_data.get("state") or {}
        variables = state.get("variables") or {}
        message_history = variables.get("message_history") or {}

        size = len(message_history) if isinstance(message_history, (list, dict)) else 0
        chats: dict[str, int] = {}
        if isinstance(message_history, dict):
            for chat_id, msgs in message_history.items():
                chats[str(chat_id)] = len(msgs) if isinstance(msgs, list) else 0
        elif isinstance(message_history, list):
            chats = {"all": size}

        trace.append(
            {
                "node": name,
                "type": msg_type,
                "message_history_size": size,
                "chats": chats,
            }
        )

    return {"session_id": session_id, "trace": trace}


async def get_session_crew_input(session_id: int) -> dict[str, Any]:
    """Get inputs passed to crew/agent nodes during session execution."""
    async with get_client() as client:
        response = await client.get(
            "/api/graph-session-messages/",
            params={"session_id": session_id, "ordering": "id"},
        )

    messages = response if isinstance(response, list) else response.get("results", [])

    crew_nodes: dict[str, dict[str, Any]] = {}
    for msg in messages:
        name = msg.get("name", "")
        msg_data = msg.get("message_data") or {}
        msg_type = msg_data.get("message_type", "")
        inp = msg_data.get("input") or {}

        is_crew = (
            "crew" in name.lower()
            or "#" in name
            or "conversation_context" in inp
        )

        if msg_type == "start" and is_crew:
            if name not in crew_nodes:
                crew_nodes[name] = {"name": name, "input": {}, "agent_outputs": []}
            crew_nodes[name]["input"] = inp

        if msg_type == "agent_finish":
            if name not in crew_nodes:
                crew_nodes[name] = {"name": name, "input": {}, "agent_outputs": []}
            output = msg_data.get("output") or {}
            text = output.get("output") or str(output)
            crew_nodes[name]["agent_outputs"].append(text)

    return {"session_id": session_id, "crew_nodes": list(crew_nodes.values())}


async def get_flow_persistent_vars(graph_id: int) -> dict[str, Any]:
    """Get the persistent variables stored for a flow (graph organization state)."""
    async with get_client() as client:
        response = await client.get(
            "/api/graph-organizations/",
            params={"graph": graph_id},
        )

    items = response if isinstance(response, list) else response.get("results", [])

    for item in items:
        if item.get("graph") == graph_id:
            return {
                "graph_id": graph_id,
                "persistent_variables": item.get("persistent_variables") or {},
                "organization_id": item.get("id"),
            }

    return {"graph_id": graph_id, "persistent_variables": {}, "organization_id": None}
