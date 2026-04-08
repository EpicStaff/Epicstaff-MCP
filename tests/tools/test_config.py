"""Tests for config/health tools."""
from __future__ import annotations

import httpx
import respx

from epicstaff_mcp.tools.config import list_providers, ping
from tests.conftest import BASE_URL


@respx.mock
async def test_ping_ok():
    respx.get(f"{BASE_URL}api/providers/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    result = await ping()
    assert result["status"] == "ok"
    assert result["base_url"] == BASE_URL


@respx.mock
async def test_ping_connection_error():
    import httpx as _httpx
    respx.get(f"{BASE_URL}api/providers/").mock(side_effect=_httpx.ConnectError("refused"))
    result = await ping()
    assert result["status"] == "error"
    assert "base_url" in result
    assert "detail" in result


@respx.mock
async def test_list_providers():
    respx.get(f"{BASE_URL}api/providers/").mock(
        return_value=httpx.Response(
            200,
            json={
                "count": 2,
                "results": [{"id": 1, "name": "OpenAI"}, {"id": 2, "name": "Anthropic"}],
            },
        )
    )
    result = await list_providers()
    assert result["count"] == 2
    assert result["results"][0]["name"] == "OpenAI"
