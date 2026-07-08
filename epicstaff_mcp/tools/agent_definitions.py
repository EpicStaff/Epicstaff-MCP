"""MCP tools for EpicStaff Agent Definitions — the CrewAI-replacement agent entity.

This is the new first-class Agent entity introduced on the crewai-replacement branch.
It is distinct from legacy `agents.py`, which manages Crew `Agent` rows.
"""

from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_agent_definitions(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all agent definitions."""
    async with get_client() as client:
        return await client.get(
            "/api/agent-definitions/", params={"limit": limit, "offset": offset}
        )


async def get_agent_definition(agent_definition_id: int) -> dict[str, Any]:
    """Get an agent definition by ID."""
    async with get_client() as client:
        return await client.get(f"/api/agent-definitions/{agent_definition_id}/")


async def create_agent_definition(
    name: str,
    description: str | None = None,
    instructions: str | None = None,
    llm_config: int | None = None,
    fcm_llm_config: int | None = None,
    max_iter: int | None = None,
    max_rpm: int | None = None,
    max_execution_time: int | None = None,
    cache: bool | None = None,
    max_retry_limit: int | None = None,
    default_temperature: float | None = None,
    metadata: dict[str, Any] | None = None,
    default_surfaces: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Create a new agent definition. Only `name` is required.

    default_surfaces items: {"surface": <id>, "place": "all"|"flow"|"chat"}
    default_temperature: 0.0–2.0
    """
    payload: dict[str, Any] = {"name": name}
    if description is not None:
        payload["description"] = description
    if instructions is not None:
        payload["instructions"] = instructions
    if llm_config is not None:
        payload["llm_config"] = llm_config
    if fcm_llm_config is not None:
        payload["fcm_llm_config"] = fcm_llm_config
    if max_iter is not None:
        payload["max_iter"] = max_iter
    if max_rpm is not None:
        payload["max_rpm"] = max_rpm
    if max_execution_time is not None:
        payload["max_execution_time"] = max_execution_time
    if cache is not None:
        payload["cache"] = cache
    if max_retry_limit is not None:
        payload["max_retry_limit"] = max_retry_limit
    if default_temperature is not None:
        payload["default_temperature"] = default_temperature
    if metadata is not None:
        payload["metadata"] = metadata
    if default_surfaces is not None:
        payload["default_surfaces"] = default_surfaces
    async with get_client() as client:
        return await client.post("/api/agent-definitions/", json=payload)


async def update_agent_definition(
    agent_definition_id: int,
    name: str | None = None,
    description: str | None = None,
    instructions: str | None = None,
    llm_config: int | None = None,
    fcm_llm_config: int | None = None,
    max_iter: int | None = None,
    max_rpm: int | None = None,
    max_execution_time: int | None = None,
    cache: bool | None = None,
    max_retry_limit: int | None = None,
    default_temperature: float | None = None,
    metadata: dict[str, Any] | None = None,
    default_surfaces: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Update an agent definition. Only provided fields are changed.

    default_surfaces items: {"surface": <id>, "place": "all"|"flow"|"chat"}
    """
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if description is not None:
        payload["description"] = description
    if instructions is not None:
        payload["instructions"] = instructions
    if llm_config is not None:
        payload["llm_config"] = llm_config
    if fcm_llm_config is not None:
        payload["fcm_llm_config"] = fcm_llm_config
    if max_iter is not None:
        payload["max_iter"] = max_iter
    if max_rpm is not None:
        payload["max_rpm"] = max_rpm
    if max_execution_time is not None:
        payload["max_execution_time"] = max_execution_time
    if cache is not None:
        payload["cache"] = cache
    if max_retry_limit is not None:
        payload["max_retry_limit"] = max_retry_limit
    if default_temperature is not None:
        payload["default_temperature"] = default_temperature
    if metadata is not None:
        payload["metadata"] = metadata
    if default_surfaces is not None:
        payload["default_surfaces"] = default_surfaces
    async with get_client() as client:
        return await client.patch(
            f"/api/agent-definitions/{agent_definition_id}/", json=payload
        )


async def delete_agent_definition(agent_definition_id: int) -> dict[str, str]:
    """Delete an agent definition by ID."""
    async with get_client() as client:
        await client.delete(f"/api/agent-definitions/{agent_definition_id}/")
    return {"message": f"Agent definition {agent_definition_id} deleted successfully"}
