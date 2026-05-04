"""MCP tools for managing EpicStaff agents."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_agents(
    limit: int = 100,
    offset: int = 0,
    search: str | None = None,
) -> dict[str, Any]:
    """List all agents. Supports pagination (limit/offset) and optional search filter."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if search:
        params["search"] = search
    async with get_client() as client:
        return await client.get("/api/agents/", params=params)


async def get_agent(agent_id: int) -> dict[str, Any]:
    """Get full details of an agent by ID."""
    async with get_client() as client:
        return await client.get(f"/api/agents/{agent_id}/")


async def create_agent(
    role: str,
    goal: str,
    backstory: str,
    llm_config: int | None = None,
    fcm_llm_config: int | None = None,
    knowledge_collection: int | None = None,
    tool_ids: list[str] | None = None,
    max_iter: int | None = None,
    max_rpm: int | None = None,
    max_execution_time: int | None = None,
    memory: bool | None = None,
    allow_delegation: bool | None = None,
    cache: bool | None = None,
    allow_code_execution: bool | None = None,
    max_retry_limit: int | None = None,
    respect_context_window: bool | None = None,
    default_temperature: float | None = None,
) -> dict[str, Any]:
    """Create a new agent.

    tool_ids format: 'mcp-tool:5', 'python-code-tool:3', 'configured-tool:1'
    default_temperature: 0.0–2.0
    """
    payload: dict[str, Any] = {"role": role, "goal": goal, "backstory": backstory}
    if llm_config is not None:
        payload["llm_config"] = llm_config
    if fcm_llm_config is not None:
        payload["fcm_llm_config"] = fcm_llm_config
    if knowledge_collection is not None:
        payload["knowledge_collection"] = knowledge_collection
    if tool_ids is not None:
        payload["tool_ids"] = tool_ids
    if max_iter is not None:
        payload["max_iter"] = max_iter
    if max_rpm is not None:
        payload["max_rpm"] = max_rpm
    if max_execution_time is not None:
        payload["max_execution_time"] = max_execution_time
    if memory is not None:
        payload["memory"] = memory
    if allow_delegation is not None:
        payload["allow_delegation"] = allow_delegation
    if cache is not None:
        payload["cache"] = cache
    if allow_code_execution is not None:
        payload["allow_code_execution"] = allow_code_execution
    if max_retry_limit is not None:
        payload["max_retry_limit"] = max_retry_limit
    if respect_context_window is not None:
        payload["respect_context_window"] = respect_context_window
    if default_temperature is not None:
        payload["default_temperature"] = default_temperature
    async with get_client() as client:
        return await client.post("/api/agents/", json=payload)


async def update_agent(
    agent_id: int,
    role: str | None = None,
    goal: str | None = None,
    backstory: str | None = None,
    llm_config: int | None = None,
    fcm_llm_config: int | None = None,
    knowledge_collection: int | None = None,
    tool_ids: list[str] | None = None,
    max_iter: int | None = None,
    max_rpm: int | None = None,
    max_execution_time: int | None = None,
    memory: bool | None = None,
    allow_delegation: bool | None = None,
    cache: bool | None = None,
    allow_code_execution: bool | None = None,
    max_retry_limit: int | None = None,
    respect_context_window: bool | None = None,
    default_temperature: float | None = None,
) -> dict[str, Any]:
    """Update one or more fields of an existing agent. Only provided fields are updated."""
    payload: dict[str, Any] = {}
    if role is not None:
        payload["role"] = role
    if goal is not None:
        payload["goal"] = goal
    if backstory is not None:
        payload["backstory"] = backstory
    if llm_config is not None:
        payload["llm_config"] = llm_config
    if fcm_llm_config is not None:
        payload["fcm_llm_config"] = fcm_llm_config
    if knowledge_collection is not None:
        payload["knowledge_collection"] = knowledge_collection
    if tool_ids is not None:
        payload["tool_ids"] = tool_ids
    if max_iter is not None:
        payload["max_iter"] = max_iter
    if max_rpm is not None:
        payload["max_rpm"] = max_rpm
    if max_execution_time is not None:
        payload["max_execution_time"] = max_execution_time
    if memory is not None:
        payload["memory"] = memory
    if allow_delegation is not None:
        payload["allow_delegation"] = allow_delegation
    if cache is not None:
        payload["cache"] = cache
    if allow_code_execution is not None:
        payload["allow_code_execution"] = allow_code_execution
    if max_retry_limit is not None:
        payload["max_retry_limit"] = max_retry_limit
    if respect_context_window is not None:
        payload["respect_context_window"] = respect_context_window
    if default_temperature is not None:
        payload["default_temperature"] = default_temperature
    async with get_client() as client:
        return await client.patch(f"/api/agents/{agent_id}/", json=payload)


async def delete_agent(agent_id: int) -> dict[str, str]:
    """Delete an agent by ID."""
    async with get_client() as client:
        await client.delete(f"/api/agents/{agent_id}/")
    return {"message": f"Agent {agent_id} deleted successfully"}


async def copy_agent(agent_id: int, name: str | None = None) -> dict[str, Any]:
    """Create a copy of an existing agent.

    agent_id: ID of the agent to copy
    name: optional name for the new agent copy; if omitted the server generates one
    """
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    async with get_client() as client:
        return await client.post(f"/api/agents/{agent_id}/copy/", json=payload)


async def list_template_agents(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all template agents available in EpicStaff."""
    async with get_client() as client:
        return await client.get("/api/template-agents/", params={"limit": limit, "offset": offset})


async def get_template_agent(template_agent_id: int) -> dict[str, Any]:
    """Get full details of a template agent by ID."""
    async with get_client() as client:
        return await client.get(f"/api/template-agents/{template_agent_id}/")


async def list_agent_tags(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all agent tags."""
    async with get_client() as client:
        return await client.get("/api/agent-tags/", params={"limit": limit, "offset": offset})


async def create_agent_tag(name: str) -> dict[str, Any]:
    """Create a new agent tag."""
    async with get_client() as client:
        return await client.post("/api/agent-tags/", json={"name": name})


async def delete_agent_tag(tag_id: int) -> dict[str, str]:
    """Delete an agent tag by ID."""
    async with get_client() as client:
        await client.delete(f"/api/agent-tags/{tag_id}/")
    return {"message": f"Agent tag {tag_id} deleted successfully"}
