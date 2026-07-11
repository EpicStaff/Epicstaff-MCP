"""Runnable gate for flows — prove a built/edited flow actually runs.

`smoke_test_flow` is the "ready to test" check: it runs the existing static
validator (`_validate_graph`) and, if that passes, executes the flow once on a
representative input and confirms it reached the end node with no node errors and
no unresolved output holes (the `"not found"` sentinel an end `output_map` leaves
when a path does not resolve).

It proves ONE happy path runs — not every branch or edge case. That is the
deliberate trade-off: fast and good enough to hand a flow off for testing.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.tools.flows import _validate_graph, get_flow

# Session statuses that mean the run is over (mirrors sessions.run_session_and_wait).
_TERMINAL_STATUSES = {"completed", "failed", "stopped", "error", "end", "ended"}
# The literal an end-node output_map yields when a variables path does not resolve.
_NOT_FOUND = "not found"


async def smoke_test_flow(
    flow_id: int,
    variables: dict[str, Any] | None = None,
    timeout: int = 180,
    poll_interval: int = 3,
    execute: bool = True,
) -> dict[str, Any]:
    """Prove a flow is runnable: static validation + one live happy-path run.

    Layer 1 (always, no LLM): fetch the flow and run `_validate_graph` — structural
    checks plus input_map/output_variable_path continuity. Any error-severity finding
    short-circuits (the flow is not run).

    Layer 2 (only if Layer 1 is clean, and execute=True): start a session and poll
    until it terminates, then read the final graph message and assert the run reached
    the end node, no node emitted an error, and the end result has no `"not found"`
    holes.

    variables: input for the run. If omitted, the start node's declared `variables`
      are used as-is (fill in a representative message for a better test).
    execute: set False for a static-only check (zero token cost).

    Returns a verdict dict:
      {runnable, stage, reached_end, session_id, status, elapsed_s,
       static_findings, node_errors, holes, null_outputs, end_result, summary}
    `runnable` is True/False after execution, or None for a static-only pass.
    """
    result: dict[str, Any] = {
        "flow_id": flow_id,
        "runnable": False,
        "reached_end": False,
        "stage": "static",
        "static_findings": [],
        "node_errors": [],
        "holes": [],
        "null_outputs": [],
        "end_result": None,
    }

    # -- Layer 1: static validation ----------------------------------------
    graph = await get_flow(flow_id)
    findings = _validate_graph(graph)
    result["static_findings"] = findings
    errors = [f for f in findings if f.get("severity") == "error"]
    if errors:
        result["summary"] = (
            f"Not runnable — {len(errors)} structural error(s); flow not executed. "
            f"First: {errors[0].get('code')}: {errors[0].get('message')}"
        )
        return result

    if not execute:
        result["runnable"] = None
        n_warn = len(findings)
        result["summary"] = (
            "Static checks passed (execution skipped)."
            + (f" {n_warn} warning(s)." if n_warn else "")
        )
        return result

    # -- Layer 2: execute once ---------------------------------------------
    result["stage"] = "execution"
    if variables is None:
        start_nodes = graph.get("start_node_list") or [{}]
        variables = start_nodes[0].get("variables") or {}

    async with get_client() as client:
        start_resp = await client.post(
            "/api/run-session/", json={"graph_id": flow_id, "variables": variables}
        )
    session_id = start_resp.get("session_id") or start_resp.get("id")
    result["session_id"] = session_id
    if not session_id:
        result["summary"] = "Not runnable — run-session did not return a session id."
        return result

    started = time.monotonic()
    status = ""
    while time.monotonic() - started < timeout:
        await asyncio.sleep(poll_interval)
        async with get_client() as client:
            upd = await client.get(f"/api/sessions/{session_id}/get-updates/")
        status = (upd.get("status") or "").lower() if isinstance(upd, dict) else ""
        if status in _TERMINAL_STATUSES:
            break
    result["status"] = status
    result["elapsed_s"] = round(time.monotonic() - started, 1)
    if status not in _TERMINAL_STATUSES:
        result["summary"] = f"Not runnable — timed out after {timeout}s (status '{status}')."
        return result

    # Read the message stream; the graph_end / end-node message can lag the
    # terminal status by a beat, so retry a few times before giving up.
    msgs: list[dict[str, Any]] = []
    end_result: Any = None
    for _ in range(8):
        async with get_client() as client:
            data = await client.get(
                "/api/graph-session-messages/",
                params={"session_id": session_id, "limit": 200},
            )
        msgs = data.get("results", []) if isinstance(data, dict) else []
        for m in reversed(msgs):
            md = m.get("message_data", {}) or {}
            if md.get("message_type") == "graph_end" and md.get("end_node_result") is not None:
                end_result = md["end_node_result"]
                break
        if end_result is None:
            for m in reversed(msgs):
                md = m.get("message_data", {}) or {}
                if "__end" in (m.get("name") or "") and isinstance(md.get("output"), dict):
                    end_result = md["output"]
                    break
        if end_result is not None:
            break
        await asyncio.sleep(0.8)

    # Node errors surfaced in the stream.
    node_errors: list[dict[str, Any]] = []
    for m in msgs:
        md = m.get("message_data", {}) or {}
        if md.get("message_type") == "error":
            node_errors.append(
                {"node": m.get("name") or "", "error": md.get("text") or md.get("message") or "error"}
            )
    result["node_errors"] = node_errors

    result["reached_end"] = end_result is not None
    result["end_result"] = end_result

    holes: list[str] = []
    null_outputs: list[str] = []
    if isinstance(end_result, dict):
        for key, value in end_result.items():
            if value == _NOT_FOUND:
                holes.append(key)
            elif value is None:
                null_outputs.append(key)
    result["holes"] = holes
    result["null_outputs"] = null_outputs

    runnable = result["reached_end"] and not node_errors and not holes
    result["runnable"] = runnable
    if runnable:
        extra = f" ({len(null_outputs)} null output(s))" if null_outputs else ""
        result["summary"] = (
            f"Runnable — reached end in {result['elapsed_s']}s, no errors or holes.{extra}"
        )
    else:
        parts: list[str] = []
        if not result["reached_end"]:
            parts.append("did not reach the end node")
        if node_errors:
            parts.append(f"{len(node_errors)} node error(s): {node_errors[0].get('node')}")
        if holes:
            parts.append(f"unresolved end output(s): {holes}")
        result["summary"] = "Not runnable — " + "; ".join(parts) + "."
    return result
