"""Guardrail: the combined server must expose every tool-module function.

The combined server registers tools by introspecting ``TOOL_MODULES`` (see
``combined_server.py``). That removes the historical drift bug where a tool was
implemented but never hand-added to the server (so it 404'd live).

These tests re-derive the expected tool set **independently** — by parsing the
tool modules' source with ``ast`` — and assert every public function is exposed.
If the auto-registration logic ever silently drops a tool (e.g. a future sync
tool that an async-only filter would skip), this fails loudly instead.
"""
from __future__ import annotations

import ast
import inspect

from epicstaff_mcp.servers import combined_server as combined

# Tools that the skills depend on and that were previously unregistered. Kept as
# an explicit smoke-check so a regression names the offender directly.
REQUIRED_TOOLS = {
    # flow inspection & readable view
    "get_flow_connections",
    "describe_flow",
    "get_node",
    "get_crew_node",
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


def _public_functions_from_source(module) -> set[str]:
    """Top-level public ``def``/``async def`` names parsed from a module's source.

    Independent of the runtime registration logic — it reads the file directly so
    it can catch a tool the registration loop would skip.
    """
    src = inspect.getsource(module)
    tree = ast.parse(src)
    return {
        node.name
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and not node.name.startswith("_")
    }


def _expected_tool_names() -> set[str]:
    names: set[str] = set()
    for module in combined.TOOL_MODULES:
        names |= _public_functions_from_source(module)
    return names


async def _registered_tool_names() -> set[str]:
    # FastMCP exposes registered tools via get_tools() (a {name: Tool} dict);
    # older builds used list_tools() (a list of Tool objects). Support both.
    if hasattr(combined.mcp, "get_tools"):
        return set(await combined.mcp.get_tools())
    return {t.name for t in await combined.mcp.list_tools()}


async def test_every_tool_module_function_is_registered():
    expected = _expected_tool_names()
    registered = await _registered_tool_names()
    missing = expected - registered
    assert not missing, (
        "combined_server did not register these public tool-module functions "
        f"(registration drift): {sorted(missing)}"
    )


async def test_no_unexpected_tools_registered():
    """Every registered tool traces back to a tool-module function — no strays."""
    expected = _expected_tool_names()
    registered = await _registered_tool_names()
    unexpected = registered - expected
    assert not unexpected, (
        f"combined_server exposes tools with no source function: {sorted(unexpected)}"
    )


async def test_combined_server_exposes_required_flow_tools():
    registered = await _registered_tool_names()
    missing = REQUIRED_TOOLS - registered
    assert not missing, f"combined_server is missing required tools: {sorted(missing)}"
