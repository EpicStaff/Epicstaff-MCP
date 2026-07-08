"""MCP tools for EpicStaff organization and multi-tenancy management."""

from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_active_org_id, get_client, set_active_org_id
from epicstaff_mcp.exceptions import EpicStaffAPIError, EpicStaffConnectionError


# Active Organization (controls the X-Organization-Id RBAC header)
async def list_my_organizations() -> dict[str, Any]:
    """List the organizations the current user belongs to.

    Reads GET /api/profile/, which is scoped to the current user's own
    memberships (already filtered to active organizations).
    """
    async with get_client() as client:
        profile = await client.get("/api/profile/")
    return {
        "active_organization_id": get_active_org_id(),
        "organizations": [
            {
                "id": membership["organization"]["id"],
                "name": membership["organization"].get("name"),
                "is_active": membership["organization"].get("is_active"),
                "role": (membership.get("role") or {}).get("name"),
                "membership_id": membership.get("id"),
            }
            for membership in profile.get("memberships", [])
        ],
    }


async def set_active_organization(org_id: int) -> dict[str, Any]:
    """Set the active organization for all subsequent org-scoped calls.

    This controls the X-Organization-Id header the client sends on every request,
    which the backend uses to resolve the active organization for RBAC. Validates
    that the current user is a member of org_id first (superadmins may switch to
    any organization).
    """
    async with get_client() as client:
        profile = await client.get("/api/profile/")
    if not profile.get("is_superadmin", False):
        memberships = profile.get("memberships", [])
        member_org_ids = {
            membership["organization"]["id"] for membership in memberships
        }
        if org_id not in member_org_ids:
            available = (
                ", ".join(
                    f"{membership['organization']['id']} ({membership['organization'].get('name')})"
                    for membership in memberships
                )
                or "none"
            )
            raise EpicStaffAPIError(
                status_code=403,
                detail=(
                    f"User is not a member of organization {org_id}. "
                    f"Available organizations: {available}"
                ),
            )
    set_active_org_id(org_id)
    return {"active_organization_id": org_id}


async def get_active_organization() -> dict[str, Any]:
    """Get the active organization used for the X-Organization-Id RBAC header.

    Includes the caller's organization roster when the profile call succeeds.
    Falls back to just the active id (e.g. when no auth is configured) rather
    than raising, so this tool always returns something useful.
    """
    try:
        return await list_my_organizations()
    except (EpicStaffAPIError, EpicStaffConnectionError):
        return {"active_organization_id": get_active_org_id()}


async def clear_active_organization() -> dict[str, Any]:
    """Clear the runtime active-organization override.

    Subsequent org-scoped calls fall back to the auto-resolved default organization
    (the caller's first membership from /api/profile/) for the X-Organization-Id
    RBAC header.
    """
    set_active_org_id(None)
    return {"active_organization_id": get_active_org_id()}


# Organizations (superadmin-only admin routes)
async def list_organizations(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all organizations."""
    async with get_client() as client:
        return await client.get(
            "/api/admin/organizations/", params={"limit": limit, "offset": offset}
        )


async def get_organization(org_id: int) -> dict[str, Any]:
    """Get an organization by ID.

    The admin API has no per-organization retrieve route, so this filters the
    list of organizations for the matching id.
    """
    async with get_client() as client:
        response = await client.get("/api/admin/organizations/")
    for org in response.get("results", []):
        if org.get("id") == org_id:
            return org
    raise EpicStaffAPIError(status_code=404, detail=f"Organization {org_id} not found")


async def create_organization(name: str) -> dict[str, Any]:
    """Create a new organization."""
    async with get_client() as client:
        return await client.post("/api/admin/organizations/", json={"name": name})


async def update_organization(org_id: int, name: str) -> dict[str, Any]:
    """Rename an organization."""
    async with get_client() as client:
        return await client.patch(
            f"/api/admin/organizations/{org_id}/", json={"name": name}
        )


async def deactivate_organization(org_id: int) -> dict[str, Any]:
    """Deactivate an organization by ID.

    Organizations are never hard-deleted; the admin API only supports
    deactivation (which can be reversed via reactivate on the backend).
    """
    async with get_client() as client:
        return await client.post(f"/api/admin/organizations/{org_id}/deactivate/")


async def delete_organization(org_id: int) -> dict[str, Any]:
    """Deactivate an organization by ID (alias for deactivate_organization).

    There is no hard-delete route; this deactivates the organization.
    """
    return await deactivate_organization(org_id)


# Organization Users
async def list_organization_users(
    org_id: int,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List the members of an organization."""
    async with get_client() as client:
        return await client.get(
            f"/api/admin/organizations/{org_id}/users/",
            params={"limit": limit, "offset": offset},
        )


async def add_organization_user(
    org_id: int,
    user_id: int,
    role_id: int,
) -> dict[str, Any]:
    """Link an existing user to an organization with the given role.

    Uses the batch assign-users endpoint with a single assignment.
    """
    async with get_client() as client:
        return await client.post(
            f"/api/admin/organizations/{org_id}/assign-users/",
            json={"assignments": [{"user_id": user_id, "role_id": role_id}]},
        )


async def remove_organization_user(org_id: int, user_id: int) -> dict[str, str]:
    """Remove a user from an organization."""
    async with get_client() as client:
        await client.delete(f"/api/admin/organizations/{org_id}/users/{user_id}/")
    return {
        "message": f"User {user_id} removed from organization {org_id} successfully"
    }


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
    return {
        "message": f"Graph organization association {membership_id} removed successfully"
    }


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
