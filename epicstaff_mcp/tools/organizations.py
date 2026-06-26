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


# Organization Users — managed under the RBAC admin endpoint nested by org id:
#   /api/admin/organizations/{org_id}/users/[{user_id}/]
# (the old flat /api/organization-users/ route does not exist). Requires
# superadmin globally OR a role with USERS permission in the org.
async def list_organization_users(
    org_id: int,
    role_name: str | None = None,
) -> dict[str, Any]:
    """List user memberships of an organization."""
    params: dict[str, Any] = {}
    if role_name is not None:
        params["role_name"] = role_name
    async with get_client() as client:
        return await client.get(
            f"/api/admin/organizations/{org_id}/users/", params=params
        )


async def add_organization_user(
    org_id: int,
    user_id: int,
    role_id: int,
) -> dict[str, Any]:
    """Add a user to an organization with a role.

    role_id: id of the org-scoped role to assign (see the org roles endpoint).
    """
    async with get_client() as client:
        return await client.post(
            f"/api/admin/organizations/{org_id}/users/",
            json={"user_id": user_id, "role_id": role_id},
        )


async def remove_organization_user(org_id: int, user_id: int) -> dict[str, str]:
    """Remove a user from an organization."""
    async with get_client() as client:
        await client.delete(f"/api/admin/organizations/{org_id}/users/{user_id}/")
    return {"message": f"User {user_id} removed from organization {org_id}"}


# Graph Organizations (associate flows with organizations)
async def list_graph_organizations(
    flow_id: int | None = None,
    org_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List flow-organization associations."""
    # GraphOrganizationViewSet has no filter backend, so `graph`/`organization`
    # query params are ignored and every association is returned. Filter
    # client-side so flow_id/org_id actually scope the result.
    async with get_client() as client:
        resp = await client.get(
            "/api/graph-organizations/", params={"limit": limit, "offset": offset}
        )
    results = resp.get("results", [])
    if flow_id is not None:
        results = [r for r in results if r.get("graph") == flow_id]
    if org_id is not None:
        results = [r for r in results if r.get("organization") == org_id]
    return {**resp, "results": results, "count": len(results)}


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
    # GraphOrganizationUserViewSet is a plain ReadOnly viewset with no filter
    # backend — scope client-side so flow_id/org_id are honored.
    async with get_client() as client:
        resp = await client.get(
            "/api/graph-organization-users/", params={"limit": limit, "offset": offset}
        )
    results = resp.get("results", [])
    if flow_id is not None:
        results = [r for r in results if r.get("graph") == flow_id]
    if org_id is not None:
        results = [r for r in results if r.get("organization") == org_id]
    return {**resp, "results": results, "count": len(results)}
