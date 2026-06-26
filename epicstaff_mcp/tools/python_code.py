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
    # `libraries` is a required ListField on PythonCodeSerializer — always send it
    # (default to []), otherwise the backend rejects the create with a 400.
    payload: dict[str, Any] = {
        "code": code,
        "entrypoint": entrypoint,
        "libraries": libraries or [],
    }
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
    # Backend RunPythonCodeSerializer expects `python_code_id` (PK) and `variables`
    # (not `python_code` / `kwargs`).
    payload: dict[str, Any] = {"python_code_id": code_id}
    if kwargs is not None:
        payload["variables"] = kwargs
    async with get_client() as client:
        return await client.post("/api/run-python-code/", json=payload)


async def list_python_code_results(
    execution_id: str | None = None,
    returncode: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List Python code execution results.

    Results are keyed by ``execution_id`` (returned by ``run_python_code``); the
    backend supports filtering only by ``execution_id`` or ``returncode`` (the
    result model has no link back to the source code id).
    """
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if execution_id is not None:
        params["execution_id"] = execution_id
    if returncode is not None:
        params["returncode"] = returncode
    async with get_client() as client:
        return await client.get("/api/python-code-result/", params=params)


async def get_python_code_result(execution_id: str) -> dict[str, Any]:
    """Get a specific Python code execution result by its execution_id.

    ``execution_id`` is the string primary key returned by ``run_python_code``.
    """
    async with get_client() as client:
        return await client.get(f"/api/python-code-result/{execution_id}/")
