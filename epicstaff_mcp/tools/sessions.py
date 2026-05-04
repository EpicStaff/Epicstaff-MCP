"""MCP tools for managing and running EpicStaff sessions."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.exceptions import EpicStaffAPIError


async def list_sessions(flow_id: int, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """List sessions for a specific flow."""
    async with get_client() as client:
        return await client.get(
            "/api/sessions/",
            params={"graph": flow_id, "limit": limit, "offset": offset},
        )


async def get_session(session_id: int) -> dict[str, Any]:
    """Get full details of a session by ID."""
    async with get_client() as client:
        return await client.get(f"/api/sessions/{session_id}/")


async def run_session(
    flow_id: int | None = None,
    flow_uuid: str | None = None,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start a new session for a flow. Provide either flow_id or flow_uuid.

    variables: optional dict of input variables for the flow
    """
    if not flow_id and not flow_uuid:
        raise EpicStaffAPIError(
            status_code=400, detail="Either flow_id or flow_uuid must be provided"
        )
    payload: dict[str, Any] = {}
    if flow_id is not None:
        payload["graph_id"] = flow_id
    if flow_uuid is not None:
        payload["graph_uuid"] = flow_uuid
    if variables:
        payload["variables"] = variables
    async with get_client() as client:
        return await client.post("/api/run-session/", json=payload)


async def get_session_updates(session_id: int) -> dict[str, Any]:
    """Poll for output messages and status updates of a running session."""
    async with get_client() as client:
        return await client.get(f"/api/sessions/{session_id}/get-updates/")


async def stop_session(session_id: int) -> dict[str, Any]:
    """Stop a running session."""
    async with get_client() as client:
        return await client.post(f"/api/sessions/{session_id}/stop/")


async def send_message(
    session_id: int,
    crew_id: int,
    execution_order: int,
    name: str,
    answer: str,
) -> dict[str, Any]:
    """Send a user message to a session that is waiting for human input.

    Use get_session_updates first to determine the crew_id, execution_order, and name
    of the pending human input request.
    """
    async with get_client() as client:
        return await client.post(
            "/api/answer-to-llm/",
            json={
                "session_id": session_id,
                "crew_id": crew_id,
                "execution_order": execution_order,
                "name": name,
                "answer": answer,
            },
        )


async def delete_session(session_id: int) -> dict[str, Any]:
    """Delete a session by its ID."""
    async with get_client() as client:
        return await client.delete(f"/api/sessions/{session_id}/")


async def get_session_warnings(session_id: int) -> dict[str, Any]:
    """Get warnings for a specific session."""
    async with get_client() as client:
        return await client.get(f"/api/sessions/{session_id}/warnings/")


async def list_session_messages(
    session_id: int, limit: int = 100, offset: int = 0
) -> dict[str, Any]:
    """List all messages for a specific session."""
    async with get_client() as client:
        return await client.get(
            "/api/graph-session-messages/",
            params={"session": session_id, "limit": limit, "offset": offset},
        )


_TERMINAL_STATUSES = {"completed", "failed", "stopped", "error"}


async def run_session_and_wait(
    flow_id: int,
    variables: dict[str, Any] | None = None,
    timeout: int = 300,
    poll_interval: int = 5,
) -> dict[str, Any]:
    """Start a session and poll until it completes, fails, or times out.

    Returns the final session state including status and any output variables.
    """
    payload: dict[str, Any] = {"graph_id": flow_id}
    if variables:
        payload["variables"] = variables

    async with get_client() as client:
        start_response = await client.post("/api/run-session/", json=payload)

    session_id = start_response.get("id") or start_response.get("session_id")

    start_time = time.monotonic()
    while True:
        elapsed = time.monotonic() - start_time
        if elapsed > timeout:
            return {"error": "timeout", "session_id": session_id, "elapsed": elapsed}

        async with get_client() as client:
            update = await client.get(f"/api/sessions/{session_id}/get-updates/")

        status = update.get("status", "")
        if status in _TERMINAL_STATUSES:
            update["elapsed_seconds"] = time.monotonic() - start_time
            return update

        await asyncio.sleep(poll_interval)
