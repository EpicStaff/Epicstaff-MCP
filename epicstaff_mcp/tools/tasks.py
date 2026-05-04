"""MCP tools for managing EpicStaff tasks."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_tasks(
    limit: int = 100,
    offset: int = 0,
    crew: int | None = None,
    agent: int | None = None,
    name: str | None = None,
    order: int | None = None,
    async_execution: bool | None = None,
) -> dict[str, Any]:
    """List tasks. Supports pagination and optional filters by crew, agent, name, order, or async_execution."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if crew is not None:
        params["crew"] = crew
    if agent is not None:
        params["agent"] = agent
    if name is not None:
        params["name"] = name
    if order is not None:
        params["order"] = order
    if async_execution is not None:
        params["async_execution"] = async_execution
    async with get_client() as client:
        return await client.get("/api/tasks/", params=params)


async def get_task(task_id: int) -> dict[str, Any]:
    """Get full details of a task by ID, including tools and context tasks."""
    async with get_client() as client:
        return await client.get(f"/api/tasks/{task_id}/")


async def create_task(
    name: str,
    instructions: str,
    expected_output: str,
    crew: int | None = None,
    agent: int | None = None,
    order: int | None = None,
    human_input: bool = False,
    async_execution: bool = False,
    knowledge_query: str | None = None,
    tool_ids: list[str] | None = None,
    task_context_list: list[int] | None = None,
    config: dict[str, Any] | None = None,
    output_model: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a new task.

    tool_ids format: 'mcp-tool:5', 'python-code-tool:3', 'configured-tool:1'
    task_context_list: list of task IDs whose output feeds into this task as context
    order: integer position of the task within its crew (lower = runs earlier)
    """
    payload: dict[str, Any] = {
        "name": name,
        "instructions": instructions,
        "expected_output": expected_output,
        "human_input": human_input,
        "async_execution": async_execution,
    }
    if crew is not None:
        payload["crew"] = crew
    if agent is not None:
        payload["agent"] = agent
    if order is not None:
        payload["order"] = order
    if knowledge_query is not None:
        payload["knowledge_query"] = knowledge_query
    if tool_ids is not None:
        payload["tool_ids"] = tool_ids
    if task_context_list is not None:
        payload["task_context_list"] = task_context_list
    if config is not None:
        payload["config"] = config
    if output_model is not None:
        payload["output_model"] = output_model
    async with get_client() as client:
        return await client.post("/api/tasks/", json=payload)


async def update_task(
    task_id: int,
    name: str | None = None,
    instructions: str | None = None,
    expected_output: str | None = None,
    crew: int | None = None,
    agent: int | None = None,
    order: int | None = None,
    human_input: bool | None = None,
    async_execution: bool | None = None,
    knowledge_query: str | None = None,
    tool_ids: list[str] | None = None,
    task_context_list: list[int] | None = None,
    config: dict[str, Any] | None = None,
    output_model: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Update one or more fields of an existing task. Only provided fields are updated."""
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if instructions is not None:
        payload["instructions"] = instructions
    if expected_output is not None:
        payload["expected_output"] = expected_output
    if crew is not None:
        payload["crew"] = crew
    if agent is not None:
        payload["agent"] = agent
    if order is not None:
        payload["order"] = order
    if human_input is not None:
        payload["human_input"] = human_input
    if async_execution is not None:
        payload["async_execution"] = async_execution
    if knowledge_query is not None:
        payload["knowledge_query"] = knowledge_query
    if tool_ids is not None:
        payload["tool_ids"] = tool_ids
    if task_context_list is not None:
        payload["task_context_list"] = task_context_list
    if config is not None:
        payload["config"] = config
    if output_model is not None:
        payload["output_model"] = output_model
    async with get_client() as client:
        return await client.patch(f"/api/tasks/{task_id}/", json=payload)


async def delete_task(task_id: int) -> dict[str, str]:
    """Delete a task by ID."""
    async with get_client() as client:
        await client.delete(f"/api/tasks/{task_id}/")
    return {"message": f"Task {task_id} deleted successfully"}
