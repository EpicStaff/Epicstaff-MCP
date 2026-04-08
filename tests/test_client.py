import httpx
import pytest
import respx

from epicstaff_mcp.client import EpicStaffClient
from epicstaff_mcp.config import Settings
from epicstaff_mcp.exceptions import (
    EpicStaffAPIError,
    EpicStaffConnectionError,
    EpicStaffNotFoundError,
)

BASE = "http://test.epicstaff.local/"


def make_settings(**kwargs) -> Settings:
    return Settings(base_url="http://test.epicstaff.local", **kwargs)


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
    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    settings = make_settings(api_token="secret-token")
    client = EpicStaffClient(settings)
    async with client:
        await client.get("/api/agents/")
    request = respx.calls.last.request
    assert request.headers["authorization"] == "Bearer secret-token"


@respx.mock
async def test_basic_auth_header():
    import base64

    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    settings = make_settings(username="user", password="pass")
    client = EpicStaffClient(settings)
    async with client:
        await client.get("/api/agents/")
    request = respx.calls.last.request
    expected = "Basic " + base64.b64encode(b"user:pass").decode()
    assert request.headers["authorization"] == expected


@respx.mock
async def test_no_auth_header():
    respx.get(f"{BASE}api/agents/").mock(return_value=httpx.Response(200, json={}))
    client = EpicStaffClient(make_settings())
    async with client:
        await client.get("/api/agents/")
    request = respx.calls.last.request
    assert "authorization" not in request.headers


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
        side_effect=[httpx.ConnectError("refused"), httpx.Response(200, json={"count": 0})]
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
