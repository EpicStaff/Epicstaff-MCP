"""MCP tools for EpicStaff organization and multi-tenancy management."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


# Organizations
async def list_organizations(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all organizations."""
    async with get_client() as client:
        return await client.get(
            "/api/organizations/", params={"limit": limit, "offset": offset}
        )


async def get_organization(org_id: int) -> dict[str, Any]:
    """Get an organization by ID."""
    async with get_client() as client:
        return await client.get(f"/api/organizations/{org_id}/")


async def create_organization(
    name: str,
    description: str | None = None,
) -> dict[str, Any]:
    """Create a new organization."""
    payload: dict[str, Any] = {"name": name}
    if description is not None:
        payload["description"] = description
    async with get_client() as client:
        return await client.post("/api/organizations/", json=payload)


async def update_organization(
    org_id: int,
    name: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """Update an organization. Only provided fields are changed."""
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if description is not None:
        payload["description"] = description
    async with get_client() as client:
        return await client.patch(f"/api/organizations/{org_id}/", json=payload)


async def delete_organization(org_id: int) -> dict[str, str]:
    """Delete an organization by ID."""
    async with get_client() as client:
        await client.delete(f"/api/organizations/{org_id}/")
    return {"message": f"Organization {org_id} deleted successfully"}


# Organization Users
async def list_organization_users(
    org_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List organization user memberships, optionally filtered by organization."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if org_id is not None:
        params["organization"] = org_id
    async with get_client() as client:
        return await client.get("/api/organization-users/", params=params)


async def add_organization_user(
    org_id: int,
    user_id: int,
    role: str | None = None,
) -> dict[str, Any]:
    """Add a user to an organization.

    role: optional role string (e.g. 'admin', 'member')
    """
    payload: dict[str, Any] = {"organization": org_id, "user": user_id}
    if role is not None:
        payload["role"] = role
    async with get_client() as client:
        return await client.post("/api/organization-users/", json=payload)


async def remove_organization_user(membership_id: int) -> dict[str, str]:
    """Remove a user from an organization by membership ID."""
    async with get_client() as client:
        await client.delete(f"/api/organization-users/{membership_id}/")
    return {"message": f"Organization membership {membership_id} removed successfully"}


# Graph Organizations (associate flows with organizations)
async def list_graph_organizations(
    flow_id: int | None = None,
    org_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List flow-organization associations."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if flow_id is not None:
        params["graph"] = flow_id
    if org_id is not None:
        params["organization"] = org_id
    async with get_client() as client:
        return await client.get("/api/graph-organizations/", params=params)


async def add_graph_organization(
    flow_id: int,
    org_id: int,
) -> dict[str, Any]:
    """Associate a flow with an organization."""
    async with get_client() as client:
        return await client.post(
            "/api/graph-organizations/",
            json={"graph": flow_id, "organization": org_id},
        )


async def remove_graph_organization(membership_id: int) -> dict[str, str]:
    """Remove a flow-organization association by ID."""
    async with get_client() as client:
        await client.delete(f"/api/graph-organizations/{membership_id}/")
    return {"message": f"Graph organization association {membership_id} removed successfully"}


# Graph Organization Users (per-user flow access within org)
async def list_graph_organization_users(
    flow_id: int | None = None,
    org_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List per-user flow access records within organization context."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if flow_id is not None:
        params["graph"] = flow_id
    if org_id is not None:
        params["organization"] = org_id
    async with get_client() as client:
        return await client.get("/api/graph-organization-users/", params=params)
