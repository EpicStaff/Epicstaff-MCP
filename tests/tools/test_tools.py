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
    update_python_tool,
)
from epicstaff_mcp.variable_conversion import args_schema_to_variables
from tests.conftest import BASE_URL

PRICE_ARGS_SCHEMA = {
    "type": "object",
    "properties": {
        "width": {"type": "number", "description": "Machine width in meters"},
        "origin": {"type": "string", "description": "Pick-up city"},
        "make_model": {"type": "string", "description": "Machine make and model"},
    },
    "required": ["width", "origin"],
}

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


def test_args_schema_to_variables_marks_required_and_types():
    variables = args_schema_to_variables(PRICE_ARGS_SCHEMA)
    by_name = {v["name"]: v for v in variables}
    assert set(by_name) == {"width", "origin", "make_model"}
    assert by_name["width"]["type"] == "number"
    assert by_name["width"]["required"] is True
    assert by_name["origin"]["required"] is True
    assert by_name["make_model"]["required"] is False
    assert all(v["input_type"] == "agent_input" for v in variables)


@respx.mock
async def test_create_python_tool_sends_variables_not_args_schema():
    route = respx.post(f"{BASE_URL}api/python-code-tool/").mock(
        return_value=httpx.Response(201, json=PYTHON_TOOL)
    )
    await create_python_tool(
        name="Price Tool",
        description="Prices a shipment",
        args_schema=PRICE_ARGS_SCHEMA,
        code="def main(width, origin): return ''",
    )
    body = json.loads(route.calls.last.request.content)
    assert "args_schema" not in body
    names = {v["name"] for v in body["variables"]}
    assert names == {"width", "origin", "make_model"}


@respx.mock
async def test_create_python_tool_variables_override_wins():
    route = respx.post(f"{BASE_URL}api/python-code-tool/").mock(
        return_value=httpx.Response(201, json=PYTHON_TOOL)
    )
    explicit = [{"name": "x", "input_type": "agent_input", "required": True, "type": "string"}]
    await create_python_tool(
        name="Override Tool",
        description="d",
        args_schema=PRICE_ARGS_SCHEMA,
        code="def main(x): return x",
        variables=explicit,
    )
    body = json.loads(route.calls.last.request.content)
    assert body["variables"] == explicit


@respx.mock
async def test_update_python_tool_converts_args_schema_to_variables():
    route = respx.patch(f"{BASE_URL}api/python-code-tool/2/").mock(
        return_value=httpx.Response(200, json=PYTHON_TOOL)
    )
    await update_python_tool(tool_id=2, args_schema=PRICE_ARGS_SCHEMA)
    body = json.loads(route.calls.last.request.content)
    assert "args_schema" not in body
    assert {v["name"] for v in body["variables"]} == {"width", "origin", "make_model"}
