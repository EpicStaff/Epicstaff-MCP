import httpx
import pytest
import respx

from epicstaff_mcp.client import EpicStaffClient, get_active_org_id, set_active_org_id
from epicstaff_mcp.config import Settings
from epicstaff_mcp.exceptions import (
    EpicStaffAPIError,
    EpicStaffConnectionError,
    EpicStaffNotFoundError,
)

BASE = "http://test.epicstaff.local/"

# Authenticated (BASIC or API_KEY) requests with no active-org override trigger a
# one-time GET /api/profile/ bootstrap (see _ensure_active_org). Mock it with no
# memberships so it resolves to "no default org" and stays out of the way of
# tests that only care about the login/refresh/retry/bearer mechanics.
NO_ORG_PROFILE = {"memberships": [], "active_organization_id": None}


def mock_empty_profile():
    return respx.get(f"{BASE}api/profile/").mock(
        return_value=httpx.Response(200, json=NO_ORG_PROFILE)
    )


def make_settings(**kwargs) -> Settings:
    return Settings(base_url="http://test.epicstaff.local", **kwargs)


@pytest.fixture(autouse=True)
def reset_active_org():
    """Reset the module-level active-org override to its unset state around each test."""
    import epicstaff_mcp.client as client_module

    client_module._active_org_id = None
    client_module._override_set = False
    yield
    client_module._active_org_id = None
    client_module._override_set = False


@pytest.fixture(autouse=True)
def reset_jwt_cache():
    """Clear cached JWT tokens on the singleton so BASIC-mode state can't leak."""
    import epicstaff_mcp.client as client_module

    if client_module._client is not None:
        client_module._client._access = None
        client_module._client._refresh = None
    yield
    if client_module._client is not None:
        client_module._client._access = None
        client_module._client._refresh = None


@respx.mock
async def test_get_success():
    respx.get(f"{BASE}api/agents/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    client = EpicStaffClient(make_settings())
    async with client:
        data = await client.get("/api/agents/")
    assert data == {"count": 0, "results": []}


@respx.mock
async def test_404_raises_not_found():
    respx.get(f"{BASE}api/agents/999/").mock(
        return_value=httpx.Response(404, json={"detail": "Not found."})
    )
    client = EpicStaffClient(make_settings())
    async with client:
        with pytest.raises(EpicStaffNotFoundError):
            await client.get("/api/agents/999/")


@respx.mock
async def test_422_raises_api_error():
    respx.post(f"{BASE}api/agents/").mock(
        return_value=httpx.Response(422, json={"detail": "Invalid"})
    )
    client = EpicStaffClient(make_settings())
    async with client:
        with pytest.raises(EpicStaffAPIError) as exc_info:
            await client.post("/api/agents/", json={})
    assert exc_info.value.status_code == 422


@respx.mock
async def test_bearer_auth_header():
    mock_empty_profile()
    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    settings = make_settings(api_token="secret-token")
    client = EpicStaffClient(settings)
    async with client:
        await client.get("/api/agents/")
    request = respx.calls.last.request
    assert request.headers["authorization"] == "Bearer secret-token"


@respx.mock
async def test_basic_mode_logs_in_and_sends_bearer():
    """BASIC mode performs a JWT login and attaches the access token as Bearer."""
    login = respx.post(f"{BASE}api/auth/login/").mock(
        return_value=httpx.Response(200, json={"access": "A1", "refresh": "R1"})
    )
    mock_empty_profile()
    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    settings = make_settings(username="user@example.com", password="pass")
    client = EpicStaffClient(settings)
    async with client:
        await client.get("/api/agents/")

    assert login.call_count == 1
    login_body = login.calls.last.request.content
    assert b'"email"' in login_body and b"user@example.com" in login_body
    agents_request = respx.calls[-1].request
    assert agents_request.url.path == "/api/agents/"
    assert agents_request.headers["authorization"] == "Bearer A1"


@respx.mock
async def test_401_triggers_refresh_then_retry():
    """A 401 on a request refreshes the access token and retries once."""
    respx.post(f"{BASE}api/auth/login/").mock(
        return_value=httpx.Response(200, json={"access": "A1", "refresh": "R1"})
    )
    mock_empty_profile()
    refresh = respx.post(f"{BASE}api/auth/refresh/").mock(
        return_value=httpx.Response(200, json={"access": "A2"})
    )
    agents = respx.get(f"{BASE}api/agents/").mock(
        side_effect=[
            httpx.Response(401, json={"detail": "expired"}),
            httpx.Response(200, json={"count": 0}),
        ]
    )
    client = EpicStaffClient(
        make_settings(username="user@example.com", password="pass")
    )
    async with client:
        result = await client.get("/api/agents/")

    assert result == {"count": 0}
    assert refresh.call_count == 1
    assert agents.call_count == 2
    assert agents.calls.last.request.headers["authorization"] == "Bearer A2"


@respx.mock
async def test_refresh_failure_falls_back_to_relogin():
    """When refresh is rejected, the client re-logs in and retries successfully."""
    login = respx.post(f"{BASE}api/auth/login/").mock(
        side_effect=[
            httpx.Response(200, json={"access": "A1", "refresh": "R1"}),
            httpx.Response(200, json={"access": "A3", "refresh": "R3"}),
        ]
    )
    mock_empty_profile()
    respx.post(f"{BASE}api/auth/refresh/").mock(
        return_value=httpx.Response(401, json={"detail": "refresh expired"})
    )
    agents = respx.get(f"{BASE}api/agents/").mock(
        side_effect=[
            httpx.Response(401, json={"detail": "expired"}),
            httpx.Response(200, json={"count": 1}),
        ]
    )
    client = EpicStaffClient(
        make_settings(username="user@example.com", password="pass")
    )
    async with client:
        result = await client.get("/api/agents/")

    assert result == {"count": 1}
    assert login.call_count == 2
    assert agents.calls.last.request.headers["authorization"] == "Bearer A3"


@respx.mock
async def test_no_auth_header():
    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    client = EpicStaffClient(make_settings())
    async with client:
        await client.get("/api/agents/")
    request = respx.calls.last.request
    assert "authorization" not in request.headers


@respx.mock
async def test_active_org_header_from_resolved_default():
    """The auto-resolved default org (from GET /api/profile/) is used on the
    X-Organization-Id header when no explicit override is set. The end-to-end
    bootstrap flow (login -> GET /api/profile/ -> resolve) is exercised in
    tests/tools/test_organizations.py; this only checks header sourcing."""
    import epicstaff_mcp.client as client_module

    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    client_module.set_resolved_default_org_id(7)
    client = EpicStaffClient(make_settings())
    async with client:
        await client.get("/api/agents/")
    request = respx.calls.last.request
    assert request.headers["x-organization-id"] == "7"


@respx.mock
async def test_no_active_org_header_when_unset():
    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    client = EpicStaffClient(make_settings())
    async with client:
        await client.get("/api/agents/")
    request = respx.calls.last.request
    assert "x-organization-id" not in request.headers


@respx.mock
async def test_runtime_set_active_org_overrides():
    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    set_active_org_id(42)
    assert get_active_org_id() == 42
    client = EpicStaffClient(make_settings())
    async with client:
        await client.get("/api/agents/")
    assert respx.calls.last.request.headers["x-organization-id"] == "42"

    # Clearing back to the auto-resolved default (unresolved/None here) drops the header.
    set_active_org_id(None)
    async with client:
        await client.get("/api/agents/")
    assert "x-organization-id" not in respx.calls.last.request.headers


@respx.mock
async def test_204_returns_empty_dict():
    respx.delete(f"{BASE}api/agents/1/").mock(return_value=httpx.Response(204))
    client = EpicStaffClient(make_settings())
    async with client:
        result = await client.delete("/api/agents/1/")
    assert result == {}


@respx.mock
async def test_retries_on_connection_error():
    """Transport error is retried — first call fails, second succeeds."""
    route = respx.get(f"{BASE}api/agents/").mock(
        side_effect=[
            httpx.ConnectError("refused"),
            httpx.Response(200, json={"count": 0}),
        ]
    )
    client = EpicStaffClient(make_settings(max_retries=2))
    async with client:
        result = await client.get("/api/agents/")
    assert result == {"count": 0}
    assert route.call_count == 2


@respx.mock
async def test_raises_after_exhausting_retries():
    """After all retry attempts fail, raises EpicStaffConnectionError."""
    respx.get(f"{BASE}api/agents/").mock(side_effect=httpx.ConnectError("refused"))
    client = EpicStaffClient(make_settings(max_retries=2))
    async with client:
        with pytest.raises(EpicStaffConnectionError):
            await client.get("/api/agents/")
