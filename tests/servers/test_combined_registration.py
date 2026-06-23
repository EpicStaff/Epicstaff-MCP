"""Guardrail: the combined server must expose every flow-authoring tool.

The combined server uses a hand-maintained allowlist that previously drifted
out of date — the skills referenced tools (test_flow, patch_*, init_flow_metadata,
the session-debug family) that were implemented but never registered. This test
fails loudly if any of those regress out of the exposed surface.
"""
from __future__ import annotations

from epicstaff_mcp.servers import combined_server as combined

# Tools that the skills depend on and that were previously unregistered.
REQUIRED_TOOLS = {
    # flow inspection & readable view
    "get_flow_connections",
    "describe_flow",
    "get_cdt_node",
    "get_cdt_prompts",
    "get_cdt_route_map",
    # surgical patching
    "patch_python_node",
    "patch_webhook_node",
    "patch_code_agent_node",
    "patch_node_libraries",
    "patch_node_metadata",
    "patch_start_variables",
    "patch_cdt_node",
    "patch_dt_node",
    # structure / validation
    "init_flow_metadata",
    "test_flow",
    "validate_flow_paths",
    # sessions
    "run_session_and_wait",
    # session debug
    "inspect_session",
    "get_session_timings",
    "get_session_trace",
    "get_session_crew_input",
    "get_flow_persistent_vars",
}


async def test_combined_server_exposes_required_flow_tools():
    tools = await combined.mcp.list_tools()
    names = {t.name for t in tools}
    missing = REQUIRED_TOOLS - names
    assert not missing, f"combined_server is missing required tools: {sorted(missing)}"
