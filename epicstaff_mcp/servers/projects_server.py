"""EpicStaff MCP Projects Server — exposes crews, agents, tasks, and tools."""
from __future__ import annotations

import inspect

from fastmcp import FastMCP

from epicstaff_mcp.tools import agents, crews, tasks, tools

mcp = FastMCP("EpicStaff Projects")

# Register all public tool functions from projects-related modules
for _module in (agents, crews, tasks, tools):
    for _name, _fn in inspect.getmembers(_module, inspect.isfunction):
        if not _name.startswith("_") and _fn.__module__ == _module.__name__:
            mcp.tool()(_fn)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
