"""Tests for tool management (MCP and Python tools)."""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools.tools import (
    create_mcp_tool,
    create_python_tool,
    delete_tool,
    list_tools,
)
from tests.conftest import BASE_URL

MCP_TOOL = {
    "id": 1,
    "name": "Git Tool",
    "transport": "http://localhost:7001/sse",
    "tool_name": "git_status",
    "timeout": 30.0,
    "init_timeout": 10.0,
    "auth": None,
}

PYTHON_TOOL = {
    "id": 2,
    "name": "Data Formatter",
    "description": "Formats data",
    "args_schema": {"type": "object"},
    "python_code": {"id": 1, "code": "def main(): pass", "entrypoint": "main", "libraries": []},
    "favorite": False,
}


@respx.mock
async def test_list_tools_returns_both_types():
    respx.get(f"{BASE_URL}api/mcp-tools/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [MCP_TOOL]})
    )
    respx.get(f"{BASE_URL}api/python-code-tool/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [PYTHON_TOOL]})
    )
    result = await list_tools()
    assert "mcp_tools" in result
    assert "python_tools" in result
    assert result["mcp_tools"]["count"] == 1


@respx.mock
async def test_create_mcp_tool():
    respx.post(f"{BASE_URL}api/mcp-tools/").mock(
        return_value=httpx.Response(201, json=MCP_TOOL)
    )
    result = await create_mcp_tool(
        name="Git Tool", transport="http://localhost:7001/sse", tool_name="git_status"
    )
    assert result["id"] == 1


@respx.mock
async def test_create_mcp_tool_payload():
    route = respx.post(f"{BASE_URL}api/mcp-tools/").mock(
        return_value=httpx.Response(201, json=MCP_TOOL)
    )
    await create_mcp_tool(
        name="Git Tool",
        transport="http://localhost:7001/sse",
        tool_name="git_status",
        auth="token123",
    )
    body = json.loads(route.calls.last.request.content)
    assert body["auth"] == "token123"


@respx.mock
async def test_delete_mcp_tool():
    respx.delete(f"{BASE_URL}api/mcp-tools/1/").mock(return_value=httpx.Response(204))
    result = await delete_tool(tool_id=1, tool_type="mcp")
    assert "MCP" in result["message"]
    assert "1" in result["message"]


async def test_invalid_tool_type_raises():
    with pytest.raises(EpicStaffAPIError, match="tool_type must be"):
        await delete_tool(tool_id=1, tool_type="invalid")


@respx.mock
async def test_create_python_tool():
    respx.post(f"{BASE_URL}api/python-code-tool/").mock(
        return_value=httpx.Response(201, json=PYTHON_TOOL)
    )
    result = await create_python_tool(
        name="Data Formatter",
        description="Formats data",
        args_schema={"type": "object"},
        code="def main(): pass",
    )
    assert result["name"] == "Data Formatter"
