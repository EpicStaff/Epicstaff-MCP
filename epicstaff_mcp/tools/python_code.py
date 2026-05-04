"""MCP tools for managing and executing EpicStaff Python code."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_python_code(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all Python code snippets."""
    async with get_client() as client:
        return await client.get("/api/python-code/", params={"limit": limit, "offset": offset})


async def get_python_code(code_id: int) -> dict[str, Any]:
    """Get a Python code snippet by ID."""
    async with get_client() as client:
        return await client.get(f"/api/python-code/{code_id}/")


async def create_python_code(
    code: str,
    entrypoint: str,
    libraries: list[str] | None = None,
) -> dict[str, Any]:
    """Create a new Python code snippet.

    code: Python source code as a string
    entrypoint: name of the function to call (must exist in code)
    libraries: optional list of pip-installable package names (e.g. ['requests', 'pandas'])
    """
    payload: dict[str, Any] = {"code": code, "entrypoint": entrypoint}
    if libraries is not None:
        payload["libraries"] = libraries
    async with get_client() as client:
        return await client.post("/api/python-code/", json=payload)


async def update_python_code(
    code_id: int,
    code: str | None = None,
    entrypoint: str | None = None,
    libraries: list[str] | None = None,
) -> dict[str, Any]:
    """Update a Python code snippet. Only provided fields are changed."""
    payload: dict[str, Any] = {}
    if code is not None:
        payload["code"] = code
    if entrypoint is not None:
        payload["entrypoint"] = entrypoint
    if libraries is not None:
        payload["libraries"] = libraries
    async with get_client() as client:
        return await client.patch(f"/api/python-code/{code_id}/", json=payload)


async def delete_python_code(code_id: int) -> dict[str, str]:
    """Delete a Python code snippet by ID."""
    async with get_client() as client:
        await client.delete(f"/api/python-code/{code_id}/")
    return {"message": f"Python code {code_id} deleted successfully"}


async def run_python_code(
    code_id: int,
    kwargs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute a saved Python code snippet.

    code_id: ID of the Python code to run
    kwargs: optional dictionary of keyword arguments to pass to the entrypoint function
    """
    payload: dict[str, Any] = {"python_code": code_id}
    if kwargs is not None:
        payload["kwargs"] = kwargs
    async with get_client() as client:
        return await client.post("/api/run-python-code/", json=payload)


async def list_python_code_results(
    code_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List Python code execution results, optionally filtered by code ID."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if code_id is not None:
        params["python_code"] = code_id
    async with get_client() as client:
        return await client.get("/api/python-code-result/", params=params)


async def get_python_code_result(result_id: int) -> dict[str, Any]:
    """Get a specific Python code execution result by ID."""
    async with get_client() as client:
        return await client.get(f"/api/python-code-result/{result_id}/")
