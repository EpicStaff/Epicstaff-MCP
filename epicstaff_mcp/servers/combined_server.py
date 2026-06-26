"""EpicStaff MCP Combined Server — registers all tools and starts the server.

Tool registration is **automatic**, not a hand-maintained allowlist. Every public
function defined in one of the ``TOOL_MODULES`` below is registered as an MCP tool.
This removes the historical drift bug where a tool was implemented but never added
to the server (so it 404'd live). The contract is:

* A tool = a public function (``def``/``async def``, no leading underscore)
  **defined in** one of ``TOOL_MODULES``.
* Helpers must be ``_``-prefixed, or live in a non-tool module (e.g. the
  ``_flow_validation`` helpers used by ``flows``) — those are never scanned.

``tests/servers/test_combined_registration.py`` independently re-derives the tool
set from source and asserts every one is exposed, so a forgotten registration
becomes a loud test failure instead of a silent live 404.
"""
from __future__ import annotations

import inspect
from types import ModuleType

from fastmcp import FastMCP

from epicstaff_mcp.tools import (
    agents,
    config,
    crews,
    flows,
    knowledge,
    llm_configs,
    memory,
    organizations,
    python_code,
    realtime,
    session_debug,
    sessions,
    tasks,
    tools,
    webhooks,
)

# Modules whose public functions are exposed as MCP tools. Add a new tool by
# writing a public function in one of these modules — registration is automatic.
TOOL_MODULES: tuple[ModuleType, ...] = (
    agents,
    config,
    crews,
    flows,
    knowledge,
    llm_configs,
    memory,
    organizations,
    python_code,
    realtime,
    session_debug,
    sessions,
    tasks,
    tools,
    webhooks,
)


def iter_tool_functions(module: ModuleType):
    """Yield ``(name, fn)`` for every public function *defined in* ``module``.

    Excludes underscore-prefixed names (helpers) and symbols imported from
    elsewhere (``fn.__module__`` differs), e.g. ``get_client`` or typing aliases.
    """
    for name, fn in vars(module).items():
        if name.startswith("_"):
            continue
        if not inspect.isfunction(fn):
            continue
        if fn.__module__ != module.__name__:
            continue
        yield name, fn


mcp = FastMCP("EpicStaff")

for _module in TOOL_MODULES:
    for _name, _fn in iter_tool_functions(_module):
        mcp.tool(_fn)


def main() -> None:
    """Start the EpicStaff MCP server with stdio transport."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
