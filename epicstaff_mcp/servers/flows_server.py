"""EpicStaff MCP Flows Server — exposes only flows and sessions tools."""
from __future__ import annotations

import inspect

from fastmcp import FastMCP

from epicstaff_mcp.tools import (
    agents,
    crews,
    flow_compiler,
    flows,
    session_debug,
    sessions,
    tasks,
)

mcp = FastMCP("EpicStaff Flows")

# Register all public tool functions from flows and sessions modules
for _module in (flows, flow_compiler, sessions, session_debug, crews, agents, tasks):
    for _name, _fn in inspect.getmembers(_module, inspect.isfunction):
        if not _name.startswith("_") and _fn.__module__ == _module.__name__:
            mcp.tool()(_fn)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
