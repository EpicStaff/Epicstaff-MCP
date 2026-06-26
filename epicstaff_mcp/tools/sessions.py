"""MCP tools for managing and running EpicStaff sessions."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.exceptions import EpicStaffAPIError


async def list_sessions(
    flow_id: int, limit: int = 50, offset: int = 0, include_graph_schema: bool = False
) -> dict[str, Any]:
    """List sessions for a specific flow.

    Each raw session embeds the full ``graph_schema`` (every node definition),
    so the list balloons past the MCP token cap (50KB+ even at limit=1). That
    field is dropped per session by default; pass ``include_graph_schema=True``
    to keep it. For per-node run data use ``inspect_session``.
    """
    async with get_client() as client:
        resp = await client.get(
            "/api/sessions/",
            params={"graph": flow_id, "limit": limit, "offset": offset},
        )
    if not include_graph_schema and isinstance(resp, dict):
        for s in resp.get("results", []):
            if isinstance(s, dict):
                s.pop("graph_schema", None)
    return resp


async def get_session(
    session_id: int, include_graph_schema: bool = False
) -> dict[str, Any]:
    """Get full details of a session by ID.

    The raw session embeds the entire ``graph_schema`` (every node definition),
    which can exceed the MCP token cap on large flows. By default that field is
    dropped; pass ``include_graph_schema=True`` if you actually need it. For
    per-node run data use ``inspect_session``; for message history use
    ``get_session_trace``.
    """
    async with get_client() as client:
        session = await client.get(f"/api/sessions/{session_id}/")
    if not include_graph_schema and isinstance(session, dict):
        session.pop("graph_schema", None)
    return session


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


# Backend SessionStatus enum: pending / run / wait_for_user / error / end /
# stop / expired. A finished run reports "end" (NOT "completed"). "wait_for_user"
# is a pause that cannot self-progress, so we return on it too rather than poll
# until timeout.
_TERMINAL_STATUSES = {"end", "error", "stop", "expired"}
_HALT_STATUSES = _TERMINAL_STATUSES | {"wait_for_user"}


async def run_session_and_wait(
    flow_id: int,
    variables: dict[str, Any] | None = None,
    timeout: int = 600,
    poll_interval: int = 5,
) -> dict[str, Any]:
    """Start a session and poll until it completes, halts, or times out.

    Returns the final session state: ``status``, ``session_id``,
    ``elapsed_seconds``, and ``variables`` (the final variables namespace, so
    callers get the run output without a second round-trip). A successful run
    ends with status ``"end"``. On a real timeout the latest state is returned
    with ``"incomplete": true`` (not a bare error) so partial progress is visible.
    """
    payload: dict[str, Any] = {"graph_id": flow_id}
    if variables:
        payload["variables"] = variables

    async with get_client() as client:
        start_response = await client.post("/api/run-session/", json=payload)

    session_id = start_response.get("id") or start_response.get("session_id")

    start_time = time.monotonic()
    update: dict[str, Any] = {}
    while True:
        elapsed = time.monotonic() - start_time
        if elapsed > timeout:
            update["incomplete"] = True
            update.setdefault("session_id", session_id)
            update["elapsed_seconds"] = elapsed
            return update

        async with get_client() as client:
            update = await client.get(f"/api/sessions/{session_id}/get-updates/")

        status = update.get("status", "")
        if status in _HALT_STATUSES:
            update["elapsed_seconds"] = time.monotonic() - start_time
            # The get-updates payload does not echo the session id; attach it so
            # callers can follow up with inspect_session / get_session_trace etc.
            update.setdefault("session_id", session_id)
            # get-updates omits the final variables. Fetch them once so the
            # caller gets the run output directly. status_data.variables holds the
            # final computed namespace; fall back to the (input) variables field.
            try:
                async with get_client() as client:
                    session = await client.get(f"/api/sessions/{session_id}/")
                if isinstance(session, dict):
                    status_data = session.get("status_data") or {}
                    final_vars = status_data.get("variables")
                    if final_vars is None:
                        final_vars = session.get("variables")
                    update.setdefault("variables", final_vars)
            except Exception:
                pass  # best-effort enrichment; never fail the wait on this
            return update

        await asyncio.sleep(poll_interval)
