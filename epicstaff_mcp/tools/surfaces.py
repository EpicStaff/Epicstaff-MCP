"""MCP tools for EpicStaff Surfaces — resource bundles attached to agents/nodes.

A surface bundles tools, storage files, and knowledge collections (each with allow/deny
access rules) so it can be attached to agent definitions or flow nodes.
"""

from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_surfaces(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all surfaces."""
    async with get_client() as client:
        return await client.get(
            "/api/surfaces/", params={"limit": limit, "offset": offset}
        )


async def get_surface(surface_id: int) -> dict[str, Any]:
    """Get a surface by ID."""
    async with get_client() as client:
        return await client.get(f"/api/surfaces/{surface_id}/")


async def create_surface(
    name: str,
    instructions: str | None = None,
    python_tools: list[dict[str, Any]] | None = None,
    mcp_tools: list[dict[str, Any]] | None = None,
    storage_items: list[dict[str, Any]] | None = None,
    knowledge: list[dict[str, Any]] | None = None,
    owner_agent: int | None = None,
) -> dict[str, Any]:
    """Create a new surface. Only `name` is required.

    Item shapes:
      python_tools: {"python_tool": <id>, "mode": "allow"|"deny"}
      mcp_tools: {"mcp_tool": <id>, "mode": "allow"|"deny"}
      storage_items: {"storage_file": <id>, "can_list"/"can_view"/"can_edit"/"can_delete":
        "allow"|"unset"|"deny"}
      knowledge: {"collection": <id>, "naive_search_config"/"graph_basic_search_config"/
        "graph_local_search_config": {...}|null}
      owner_agent: agent-definition id (null ⇒ shared)
    """
    payload: dict[str, Any] = {"name": name}
    if instructions is not None:
        payload["instructions"] = instructions
    if python_tools is not None:
        payload["python_tools"] = python_tools
    if mcp_tools is not None:
        payload["mcp_tools"] = mcp_tools
    if storage_items is not None:
        payload["storage_items"] = storage_items
    if knowledge is not None:
        payload["knowledge"] = knowledge
    if owner_agent is not None:
        payload["owner_agent"] = owner_agent
    async with get_client() as client:
        return await client.post("/api/surfaces/", json=payload)


async def update_surface(
    surface_id: int,
    name: str | None = None,
    instructions: str | None = None,
    python_tools: list[dict[str, Any]] | None = None,
    mcp_tools: list[dict[str, Any]] | None = None,
    storage_items: list[dict[str, Any]] | None = None,
    knowledge: list[dict[str, Any]] | None = None,
    owner_agent: int | None = None,
) -> dict[str, Any]:
    """Update a surface. Only provided fields are changed.

    See `create_surface` for the item shapes of python_tools, mcp_tools, storage_items,
    knowledge, and owner_agent.
    """
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if instructions is not None:
        payload["instructions"] = instructions
    if python_tools is not None:
        payload["python_tools"] = python_tools
    if mcp_tools is not None:
        payload["mcp_tools"] = mcp_tools
    if storage_items is not None:
        payload["storage_items"] = storage_items
    if knowledge is not None:
        payload["knowledge"] = knowledge
    if owner_agent is not None:
        payload["owner_agent"] = owner_agent
    async with get_client() as client:
        return await client.patch(f"/api/surfaces/{surface_id}/", json=payload)


async def delete_surface(surface_id: int) -> dict[str, str]:
    """Delete a surface by ID."""
    async with get_client() as client:
        await client.delete(f"/api/surfaces/{surface_id}/")
    return {"message": f"Surface {surface_id} deleted successfully"}


async def combine_surfaces(surface_ids: list[int]) -> dict[str, Any]:
    """Combine multiple surfaces into a merged CombinedSurface."""
    async with get_client() as client:
        return await client.post(
            "/api/surfaces/combine/", json={"surface_ids": surface_ids}
        )
