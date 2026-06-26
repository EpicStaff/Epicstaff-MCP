"""Live tests for tool management + python-code execution.

Covers epicstaff_mcp/tools/tools.py and epicstaff_mcp/tools/python_code.py.
"""
from __future__ import annotations

import asyncio

import pytest

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools import python_code, tools


# ---------------------------------------------------------------- python_code

async def test_python_code_create_run_result_lifecycle():
    created = await python_code.create_python_code(
        code="def main(x):\n    return x * 2\n",
        entrypoint="main",
    )
    code_id = created["id"]
    try:
        fetched = await python_code.get_python_code(code_id)
        assert fetched["entrypoint"] == "main"

        updated = await python_code.update_python_code(
            code_id, code="def main(x):\n    return x * 3\n"
        )
        assert "x * 3" in updated["code"]

        run = await python_code.run_python_code(code_id, kwargs={"x": 7})
        execution_id = run.get("execution_id")
        assert execution_id, f"run did not return an execution_id: {run}"

        # Result is produced asynchronously by a worker — poll by execution_id.
        single = None
        for _ in range(30):
            results = await python_code.list_python_code_results(execution_id=execution_id)
            if results.get("results"):
                single = results["results"][0]
                break
            await asyncio.sleep(1)
        assert single is not None, "no execution result appeared within 30s"

        fetched_result = await python_code.get_python_code_result(execution_id)
        assert fetched_result["execution_id"] == execution_id
        # entrypoint returns x * 3 = 21
        assert "21" in (fetched_result.get("result_data") or fetched_result.get("stdout") or "")
    finally:
        msg = await python_code.delete_python_code(code_id)
        assert "deleted" in msg["message"]


# ---------------------------------------------------------------- python tool

async def test_python_tool_crud_and_copy():
    created = await tools.create_python_tool(
        name="audit-probe-pytool",
        description="probe tool",
        args_schema={
            "type": "object",
            "properties": {"x": {"type": "integer"}},
            "required": ["x"],
        },
        code="def main(x):\n    return x + 1\n",
        entrypoint="main",
    )
    tool_id = created["id"]
    copy_id = None
    try:
        fetched = await tools.get_tool(tool_id, tool_type="python")
        assert fetched["id"] == tool_id

        updated = await tools.update_python_tool(tool_id, description="probe tool v2")
        assert updated["description"] == "probe tool v2"

        # Updating the nested python_code (code) must not trip the required
        # `libraries` field on the nested serializer.
        code_updated = await tools.update_python_tool(
            tool_id, code="def main(x):\n    return x + 2\n", libraries=[]
        )
        assert "x + 2" in code_updated["python_code"]["code"]

        listed = await tools.list_tools()
        assert "python_tools" in listed and "mcp_tools" in listed

        copy = await tools.copy_tool(tool_id, tool_type="python")
        copy_id = copy.get("id")
        assert copy_id is not None and copy_id != tool_id
    finally:
        if copy_id:
            await tools.delete_tool(copy_id, tool_type="python")
        msg = await tools.delete_tool(tool_id, tool_type="python")
        assert "deleted" in msg["message"]


async def test_get_tool_rejects_bad_type():
    with pytest.raises(EpicStaffAPIError):
        await tools.get_tool(1, tool_type="bogus")


# ------------------------------------------------------------------- mcp tool

async def test_mcp_tool_crud():
    created = await tools.create_mcp_tool(
        name="audit-probe-mcp",
        transport="http://localhost:7099/sse",
        tool_name="probe",
    )
    tool_id = created["id"]
    try:
        fetched = await tools.get_tool(tool_id, tool_type="mcp")
        assert fetched["id"] == tool_id

        updated = await tools.update_mcp_tool(tool_id, timeout=45.0)
        assert updated["timeout"] == 45.0
    finally:
        msg = await tools.delete_tool(tool_id, tool_type="mcp")
        assert "deleted" in msg["message"]
