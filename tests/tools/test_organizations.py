"""Tests for organization tools."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from epicstaff_mcp.client import get_active_org_id, get_client, get_settings
from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools.organizations import (
    add_organization_user,
    create_organization,
    deactivate_organization,
    delete_organization,
    get_active_organization,
    get_organization,
    list_my_organizations,
    list_organization_users,
    list_organizations,
    remove_organization_user,
    set_active_organization,
    update_organization,
)
from tests.conftest import BASE_URL

ORG_PAYLOAD = {"id": 1, "name": "Acme", "is_active": True}

PROFILE_PAYLOAD = {
    "id": 1,
    "email": "user@example.com",
    "is_superadmin": False,
    "memberships": [
        {
            "id": 10,
            "organization": {"id": 3, "name": "Acme", "is_active": True},
            "role": {"id": 2, "name": "Admin"},
            "joined_at": "2024-01-01T00:00:00Z",
        }
    ],
    "active_organization_id": None,
    "active_permissions": None,
}

SUPERADMIN_PROFILE_PAYLOAD = {
    **PROFILE_PAYLOAD,
    "is_superadmin": True,
    "memberships": [],
}


@pytest.fixture
def basic_auth_settings(monkeypatch):
    """Force BASIC auth mode for auto-resolution tests."""
    monkeypatch.setenv("EPICSTAFF_USERNAME", "user@example.com")
    monkeypatch.setenv("EPICSTAFF_PASSWORD", "pass")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@respx.mock
async def test_list_organizations_uses_admin_route():
    route = respx.get(f"{BASE_URL}api/admin/organizations/").mock(
        return_value=httpx.Response(200, json=[ORG_PAYLOAD])
    )
    result = await list_organizations()
    assert route.called
    assert result["results"][0]["name"] == "Acme"


@respx.mock
async def test_get_organization_filters_list():
    respx.get(f"{BASE_URL}api/admin/organizations/").mock(
        return_value=httpx.Response(
            200, json=[ORG_PAYLOAD, {"id": 2, "name": "Other", "is_active": True}]
        )
    )
    result = await get_organization(org_id=1)
    assert result["id"] == 1
    assert result["name"] == "Acme"


@respx.mock
async def test_get_organization_missing_raises():
    respx.get(f"{BASE_URL}api/admin/organizations/").mock(
        return_value=httpx.Response(200, json=[ORG_PAYLOAD])
    )
    with pytest.raises(EpicStaffAPIError, match="Organization 99 not found"):
        await get_organization(org_id=99)


@respx.mock
async def test_create_organization_sends_name_only():
    route = respx.post(f"{BASE_URL}api/admin/organizations/").mock(
        return_value=httpx.Response(201, json=ORG_PAYLOAD)
    )
    result = await create_organization(name="Acme")
    body = json.loads(route.calls.last.request.content)
    assert body == {"name": "Acme"}
    assert result["name"] == "Acme"


@respx.mock
async def test_update_organization_patches_name():
    route = respx.patch(f"{BASE_URL}api/admin/organizations/1/").mock(
        return_value=httpx.Response(200, json={**ORG_PAYLOAD, "name": "Renamed"})
    )
    result = await update_organization(org_id=1, name="Renamed")
    body = json.loads(route.calls.last.request.content)
    assert body == {"name": "Renamed"}
    assert result["name"] == "Renamed"


@respx.mock
async def test_deactivate_organization():
    route = respx.post(f"{BASE_URL}api/admin/organizations/1/deactivate/").mock(
        return_value=httpx.Response(200, json={**ORG_PAYLOAD, "is_active": False})
    )
    result = await deactivate_organization(org_id=1)
    assert route.called
    assert result["is_active"] is False


@respx.mock
async def test_delete_organization_alias_deactivates():
    route = respx.post(f"{BASE_URL}api/admin/organizations/1/deactivate/").mock(
        return_value=httpx.Response(200, json={**ORG_PAYLOAD, "is_active": False})
    )
    result = await delete_organization(org_id=1)
    assert route.called
    assert result["is_active"] is False


@respx.mock
async def test_list_organization_users_uses_path():
    route = respx.get(f"{BASE_URL}api/admin/organizations/5/users/").mock(
        return_value=httpx.Response(200, json=[{"id": 3, "email": "a@b.c"}])
    )
    result = await list_organization_users(org_id=5)
    assert route.called
    assert result["results"][0]["id"] == 3


@respx.mock
async def test_add_organization_user_uses_assign_endpoint():
    route = respx.post(f"{BASE_URL}api/admin/organizations/5/assign-users/").mock(
        return_value=httpx.Response(200, json={"created": [], "updated": []})
    )
    await add_organization_user(org_id=5, user_id=3, role_id=2)
    body = json.loads(route.calls.last.request.content)
    assert body == {"assignments": [{"user_id": 3, "role_id": 2}]}


@respx.mock
async def test_remove_organization_user_uses_detail_route():
    route = respx.delete(f"{BASE_URL}api/admin/organizations/5/users/3/").mock(
        return_value=httpx.Response(204)
    )
    result = await remove_organization_user(org_id=5, user_id=3)
    assert route.called
    assert "removed" in result["message"]


# Active-organization auto-resolution


@respx.mock
async def test_auto_resolves_default_org_in_basic_mode(basic_auth_settings):
    """With no explicit override, BASIC mode adopts the caller's first membership."""
    login = respx.post(f"{BASE_URL}api/auth/login/").mock(
        return_value=httpx.Response(200, json={"access": "A1", "refresh": "R1"})
    )
    profile = respx.get(f"{BASE_URL}api/profile/").mock(
        return_value=httpx.Response(200, json=PROFILE_PAYLOAD)
    )
    agents = respx.get(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(200, json={})
    )

    async with get_client() as client:
        await client.get("/api/agents/")

    assert login.called
    assert profile.called
    assert agents.called
    assert "x-organization-id" not in login.calls.last.request.headers
    assert "x-organization-id" not in profile.calls.last.request.headers
    assert agents.calls.last.request.headers["x-organization-id"] == "3"


@respx.mock
async def test_default_org_resolution_happens_once(basic_auth_settings):
    """The /api/profile/ bootstrap runs once per process, not on every request."""
    respx.post(f"{BASE_URL}api/auth/login/").mock(
        return_value=httpx.Response(200, json={"access": "A1", "refresh": "R1"})
    )
    profile = respx.get(f"{BASE_URL}api/profile/").mock(
        return_value=httpx.Response(200, json=PROFILE_PAYLOAD)
    )
    agents = respx.get(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(200, json={})
    )

    async with get_client() as client:
        await client.get("/api/agents/")
        await client.get("/api/agents/")

    assert profile.call_count == 1
    assert agents.call_count == 2
    assert agents.calls[0].request.headers["x-organization-id"] == "3"
    assert agents.calls[1].request.headers["x-organization-id"] == "3"


@respx.mock
async def test_list_my_organizations_returns_flattened_roster():
    respx.get(f"{BASE_URL}api/profile/").mock(
        return_value=httpx.Response(200, json=PROFILE_PAYLOAD)
    )
    result = await list_my_organizations()
    assert result["active_organization_id"] is None
    assert result["organizations"] == [
        {
            "id": 3,
            "name": "Acme",
            "is_active": True,
            "role": "Admin",
            "membership_id": 10,
        }
    ]


@respx.mock
async def test_get_active_organization_falls_back_when_profile_call_fails():
    """A failing profile call (e.g. no auth configured) still returns the active id."""
    respx.get(f"{BASE_URL}api/profile/").mock(
        return_value=httpx.Response(401, json={"detail": "Unauthorized"})
    )
    result = await get_active_organization()
    assert result == {"active_organization_id": get_active_org_id()}


@respx.mock
async def test_set_active_organization_rejects_non_member():
    respx.get(f"{BASE_URL}api/profile/").mock(
        return_value=httpx.Response(200, json=PROFILE_PAYLOAD)
    )
    with pytest.raises(EpicStaffAPIError) as exc_info:
        await set_active_organization(org_id=99)
    assert exc_info.value.status_code == 403
    assert get_active_org_id() != 99


@respx.mock
async def test_set_active_organization_succeeds_for_member():
    respx.get(f"{BASE_URL}api/profile/").mock(
        return_value=httpx.Response(200, json=PROFILE_PAYLOAD)
    )
    result = await set_active_organization(org_id=3)
    assert result == {"active_organization_id": 3}
    assert get_active_org_id() == 3


@respx.mock
async def test_set_active_organization_succeeds_for_superadmin():
    respx.get(f"{BASE_URL}api/profile/").mock(
        return_value=httpx.Response(200, json=SUPERADMIN_PROFILE_PAYLOAD)
    )
    result = await set_active_organization(org_id=42)
    assert result == {"active_organization_id": 42}
    assert get_active_org_id() == 42
