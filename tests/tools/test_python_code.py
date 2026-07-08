"""Tests for python code tools."""

from __future__ import annotations

import json

import httpx
import respx

from epicstaff_mcp.tools.python_code import (
    create_python_code,
    list_python_code_results,
    run_python_code,
)
from tests.conftest import BASE_URL


@respx.mock
async def test_create_python_code_always_includes_libraries():
    route = respx.post(f"{BASE_URL}api/python-code/").mock(
        return_value=httpx.Response(201, json={"id": 1})
    )
    await create_python_code(code="def main():\n    return 1\n", entrypoint="main")
    body = json.loads(route.calls.last.request.content)
    assert body["libraries"] == []
    assert body["code"] == "def main():\n    return 1\n"
    assert body["entrypoint"] == "main"


@respx.mock
async def test_create_python_code_passes_through_libraries():
    route = respx.post(f"{BASE_URL}api/python-code/").mock(
        return_value=httpx.Response(201, json={"id": 1})
    )
    await create_python_code(
        code="x", entrypoint="main", libraries=["requests", "pandas"]
    )
    body = json.loads(route.calls.last.request.content)
    assert body["libraries"] == ["requests", "pandas"]


@respx.mock
async def test_run_python_code_sends_python_code_id():
    route = respx.post(f"{BASE_URL}api/run-python-code/").mock(
        return_value=httpx.Response(200, json={"execution_id": "e1"})
    )
    result = await run_python_code(python_code_id=5)
    body = json.loads(route.calls.last.request.content)
    assert body == {"python_code_id": 5}
    assert result["execution_id"] == "e1"


@respx.mock
async def test_run_python_code_includes_variables():
    route = respx.post(f"{BASE_URL}api/run-python-code/").mock(
        return_value=httpx.Response(200, json={"execution_id": "e1"})
    )
    await run_python_code(python_code_id=5, variables={"x": 1})
    body = json.loads(route.calls.last.request.content)
    assert body == {"python_code_id": 5, "variables": {"x": 1}}
    assert "python_code" not in body
    assert "kwargs" not in body


@respx.mock
async def test_list_python_code_results_filters():
    route = respx.get(f"{BASE_URL}api/python-code-result/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    await list_python_code_results(execution_id="abc", returncode=0)
    params = route.calls.last.request.url.params
    assert params["execution_id"] == "abc"
    assert params["returncode"] == "0"
    assert "python_code" not in params
