"""EpicStaff MCP Organizations Server — exposes LLM configs, knowledge, and organizations."""
from __future__ import annotations

import inspect

from fastmcp import FastMCP

from epicstaff_mcp.tools import knowledge, llm_configs, organizations

mcp = FastMCP("EpicStaff Organizations")

# Register all public tool functions from organizations-related modules
for _module in (knowledge, llm_configs, organizations):
    for _name, _fn in inspect.getmembers(_module, inspect.isfunction):
        if not _name.startswith("_") and _fn.__module__ == _module.__name__:
            mcp.tool()(_fn)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
