"""MCP tools for managing EpicStaff crews."""
from __future__ import annotations

from typing import Any, Literal

from epicstaff_mcp.client import get_client


async def list_crews(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all crews with their assigned agents."""
    async with get_client() as client:
        return await client.get("/api/crews/", params={"limit": limit, "offset": offset})


async def get_crew(crew_id: int) -> dict[str, Any]:
    """Get full details of a crew by ID, including its agents."""
    async with get_client() as client:
        return await client.get(f"/api/crews/{crew_id}/")


async def create_crew(
    name: str,
    description: str | None = None,
    agents: list[int] | None = None,
    process: Literal["sequential", "hierarchical"] = "sequential",
    memory: bool | None = None,
    memory_llm_config: int | None = None,
    embedding_config: int | None = None,
    manager_llm_config: int | None = None,
    planning_llm_config: int | None = None,
    max_rpm: int | None = None,
    cache: bool | None = None,
    full_output: bool = False,
    planning: bool = False,
    default_temperature: float | None = None,
) -> dict[str, Any]:
    """Create a new crew and optionally assign agents to it.

    process: 'sequential' (default) or 'hierarchical'
    agents: list of agent IDs to assign to this crew
    """
    payload: dict[str, Any] = {
        "name": name,
        "process": process,
        "full_output": full_output,
        "planning": planning,
    }
    if description is not None:
        payload["description"] = description
    if agents is not None:
        payload["agents"] = agents
    if memory is not None:
        payload["memory"] = memory
    if memory_llm_config is not None:
        payload["memory_llm_config"] = memory_llm_config
    if embedding_config is not None:
        payload["embedding_config"] = embedding_config
    if manager_llm_config is not None:
        payload["manager_llm_config"] = manager_llm_config
    if planning_llm_config is not None:
        payload["planning_llm_config"] = planning_llm_config
    if max_rpm is not None:
        payload["max_rpm"] = max_rpm
    if cache is not None:
        payload["cache"] = cache
    if default_temperature is not None:
        payload["default_temperature"] = default_temperature
    async with get_client() as client:
        return await client.post("/api/crews/", json=payload)


async def update_crew(
    crew_id: int,
    name: str | None = None,
    description: str | None = None,
    agents: list[int] | None = None,
    process: Literal["sequential", "hierarchical"] | None = None,
    memory: bool | None = None,
    memory_llm_config: int | None = None,
    embedding_config: int | None = None,
    manager_llm_config: int | None = None,
    planning_llm_config: int | None = None,
    max_rpm: int | None = None,
    cache: bool | None = None,
    full_output: bool | None = None,
    planning: bool | None = None,
    default_temperature: float | None = None,
) -> dict[str, Any]:
    """Update one or more fields of an existing crew. Only provided fields are updated."""
    payload: dict[str, Any] = {}
    for key, val in [
        ("name", name),
        ("description", description),
        ("agents", agents),
        ("process", process),
        ("memory", memory),
        ("memory_llm_config", memory_llm_config),
        ("embedding_config", embedding_config),
        ("manager_llm_config", manager_llm_config),
        ("planning_llm_config", planning_llm_config),
        ("max_rpm", max_rpm),
        ("cache", cache),
        ("full_output", full_output),
        ("planning", planning),
        ("default_temperature", default_temperature),
    ]:
        if val is not None:
            payload[key] = val
    async with get_client() as client:
        return await client.patch(f"/api/crews/{crew_id}/", json=payload)


async def delete_crew(crew_id: int) -> dict[str, str]:
    """Delete a crew by ID."""
    async with get_client() as client:
        await client.delete(f"/api/crews/{crew_id}/")
    return {"message": f"Crew {crew_id} deleted successfully"}


async def copy_crew(crew_id: int, name: str | None = None) -> dict[str, Any]:
    """Create a copy of an existing crew.

    crew_id: ID of the crew to copy
    name: optional name for the new crew copy; if omitted the server generates one
    """
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    async with get_client() as client:
        return await client.post(f"/api/crews/{crew_id}/copy/", json=payload)


async def list_crew_tags(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all crew tags."""
    async with get_client() as client:
        return await client.get("/api/crew-tags/", params={"limit": limit, "offset": offset})


async def create_crew_tag(name: str) -> dict[str, Any]:
    """Create a new crew tag."""
    async with get_client() as client:
        return await client.post("/api/crew-tags/", json={"name": name})


async def delete_crew_tag(tag_id: int) -> dict[str, str]:
    """Delete a crew tag by ID."""
    async with get_client() as client:
        await client.delete(f"/api/crew-tags/{tag_id}/")
    return {"message": f"Crew tag {tag_id} deleted successfully"}
