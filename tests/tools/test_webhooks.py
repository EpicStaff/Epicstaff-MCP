"""Tests for webhook and ngrok tools."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools.webhooks import (
    get_ngrok_config,
    register_telegram_trigger,
    register_webhooks,
    update_ngrok_config,
)
from tests.conftest import BASE_URL

NGROK_PAYLOAD = {"id": 3, "auth_token": "tok", "domain": "old.ngrok.app"}


@respx.mock
async def test_register_webhooks_sends_empty_body():
    route = respx.post(f"{BASE_URL}api/register-webhooks/").mock(
        return_value=httpx.Response(200, json={"registered": 4})
    )
    result = await register_webhooks()
    body = json.loads(route.calls.last.request.content)
    assert body == {}
    assert result["registered"] == 4


@respx.mock
async def test_get_ngrok_config_returns_first_result():
    respx.get(f"{BASE_URL}api/ngrok-config/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [NGROK_PAYLOAD]})
    )
    result = await get_ngrok_config()
    assert result["id"] == 3
    assert result["domain"] == "old.ngrok.app"


@respx.mock
async def test_get_ngrok_config_empty():
    respx.get(f"{BASE_URL}api/ngrok-config/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    result = await get_ngrok_config()
    assert result == {}


@respx.mock
async def test_update_ngrok_config_puts_to_detail_route():
    respx.get(f"{BASE_URL}api/ngrok-config/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [NGROK_PAYLOAD]})
    )
    route = respx.put(f"{BASE_URL}api/ngrok-config/3/").mock(
        return_value=httpx.Response(
            200, json={**NGROK_PAYLOAD, "domain": "new.ngrok.app"}
        )
    )
    result = await update_ngrok_config(domain="new.ngrok.app")
    body = json.loads(route.calls.last.request.content)
    assert body["id"] == 3
    assert body["domain"] == "new.ngrok.app"
    assert body["auth_token"] == "tok"
    assert result["domain"] == "new.ngrok.app"


@respx.mock
async def test_update_ngrok_config_no_existing_raises():
    respx.get(f"{BASE_URL}api/ngrok-config/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    with pytest.raises(EpicStaffAPIError, match="No ngrok configuration"):
        await update_ngrok_config(domain="new.ngrok.app")


@respx.mock
async def test_register_telegram_trigger_uses_telegram_trigger_node_id():
    route = respx.post(f"{BASE_URL}api/register-telegram-trigger/").mock(
        return_value=httpx.Response(200, json={"registered": True})
    )
    await register_telegram_trigger(node_id=88, bot_token="tok")
    body = json.loads(route.calls.last.request.content)
    assert body == {"telegram_trigger_node_id": 88, "bot_token": "tok"}
