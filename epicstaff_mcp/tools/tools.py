"""MCP tools for managing EpicStaff tools (MCP servers and Python code tools)."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.exceptions import EpicStaffAPIError


async def list_tools(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all configured MCP tools and Python code tools."""
    async with get_client() as client:
        mcp = await client.get("/api/mcp-tools/", params={"limit": limit, "offset": offset})
        python = await client.get(
            "/api/python-code-tool/", params={"limit": limit, "offset": offset}
        )
    return {"mcp_tools": mcp, "python_tools": python}


async def get_tool(tool_id: int, tool_type: str = "mcp") -> dict[str, Any]:
    """Get tool details by ID.

    tool_type: 'mcp' (default) or 'python'
    """
    if tool_type not in ("mcp", "python"):
        raise EpicStaffAPIError(
            status_code=400, detail="tool_type must be 'mcp' or 'python'"
        )
    endpoint = "/api/mcp-tools/" if tool_type == "mcp" else "/api/python-code-tool/"
    async with get_client() as client:
        return await client.get(f"{endpoint}{tool_id}/")


async def create_mcp_tool(
    name: str,
    transport: str,
    tool_name: str,
    timeout: float = 30.0,
    auth: str | None = None,
    init_timeout: float = 10.0,
) -> dict[str, Any]:
    """Add a new MCP tool connection.

    transport: the SSE server URL (e.g. http://localhost:7001/sse)
    tool_name: the name of the tool exposed by the MCP server
    auth: optional OAuth/bearer token for the MCP server
    """
    payload: dict[str, Any] = {
        "name": name,
        "transport": transport,
        "tool_name": tool_name,
        "timeout": timeout,
        "init_timeout": init_timeout,
    }
    if auth is not None:
        payload["auth"] = auth
    async with get_client() as client:
        return await client.post("/api/mcp-tools/", json=payload)


async def create_python_tool(
    name: str,
    description: str,
    args_schema: dict[str, Any],
    code: str,
    entrypoint: str = "main",
    libraries: list[str] | None = None,
) -> dict[str, Any]:
    """Add a new Python code tool.

    args_schema: JSON Schema dict defining the tool's input parameters
    code: Python code containing the entrypoint function
    libraries: pip-installable packages required by the code
    """
    payload: dict[str, Any] = {
        "name": name,
        "description": description,
        "args_schema": args_schema,
        "python_code": {
            "code": code,
            "entrypoint": entrypoint,
            "libraries": libraries or [],
        },
    }
    async with get_client() as client:
        return await client.post("/api/python-code-tool/", json=payload)


async def update_mcp_tool(
    tool_id: int,
    name: str | None = None,
    transport: str | None = None,
    tool_name: str | None = None,
    timeout: float | None = None,
    auth: str | None = None,
    init_timeout: float | None = None,
) -> dict[str, Any]:
    """Update one or more fields of an existing MCP tool connection."""
    payload: dict[str, Any] = {}
    for key, val in [
        ("name", name),
        ("transport", transport),
        ("tool_name", tool_name),
        ("timeout", timeout),
        ("auth", auth),
        ("init_timeout", init_timeout),
    ]:
        if val is not None:
            payload[key] = val
    async with get_client() as client:
        return await client.patch(f"/api/mcp-tools/{tool_id}/", json=payload)


async def update_python_tool(
    tool_id: int,
    name: str | None = None,
    description: str | None = None,
    args_schema: dict[str, Any] | None = None,
    code: str | None = None,
    entrypoint: str | None = None,
    libraries: list[str] | None = None,
) -> dict[str, Any]:
    """Update one or more fields of an existing Python code tool."""
    payload: dict[str, Any] = {}
    for key, val in [
        ("name", name),
        ("description", description),
        ("args_schema", args_schema),
    ]:
        if val is not None:
            payload[key] = val
    python_code: dict[str, Any] = {}
    if code is not None:
        python_code["code"] = code
    if entrypoint is not None:
        python_code["entrypoint"] = entrypoint
    if libraries is not None:
        python_code["libraries"] = libraries
    if python_code:
        payload["python_code"] = python_code
    async with get_client() as client:
        return await client.patch(f"/api/python-code-tool/{tool_id}/", json=payload)


async def delete_tool(tool_id: int, tool_type: str = "mcp") -> dict[str, str]:
    """Delete a tool. tool_type: 'mcp' (default) or 'python'."""
    if tool_type not in ("mcp", "python"):
        raise EpicStaffAPIError(
            status_code=400, detail="tool_type must be 'mcp' or 'python'"
        )
    endpoint = "/api/mcp-tools/" if tool_type == "mcp" else "/api/python-code-tool/"
    async with get_client() as client:
        await client.delete(f"{endpoint}{tool_id}/")
    return {"message": f"{tool_type.upper()} tool {tool_id} deleted successfully"}


async def copy_tool(
    tool_id: int, tool_type: str = "mcp", name: str | None = None
) -> dict[str, Any]:
    """Create a copy of an existing tool.

    tool_id: ID of the tool to copy
    tool_type: 'mcp' (default) or 'python'
    name: optional name for the new tool copy; if omitted the server generates one
    """
    if tool_type not in ("mcp", "python"):
        raise EpicStaffAPIError(
            status_code=400, detail="tool_type must be 'mcp' or 'python'"
        )
    endpoint = "/api/mcp-tools/" if tool_type == "mcp" else "/api/python-code-tool/"
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    async with get_client() as client:
        return await client.post(f"{endpoint}{tool_id}/copy/", json=payload)
