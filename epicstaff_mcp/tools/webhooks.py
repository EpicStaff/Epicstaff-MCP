"""MCP tools for EpicStaff webhook and Telegram trigger management."""

from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.exceptions import EpicStaffAPIError


# Webhook Triggers
async def list_webhook_triggers(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all webhook trigger configurations."""
    async with get_client() as client:
        return await client.get(
            "/api/webhook-triggers/", params={"limit": limit, "offset": offset}
        )


async def get_webhook_trigger(trigger_id: int) -> dict[str, Any]:
    """Get a webhook trigger configuration by ID."""
    async with get_client() as client:
        return await client.get(f"/api/webhook-triggers/{trigger_id}/")


async def create_webhook_trigger(
    name: str,
    flow_id: int,
    is_active: bool | None = None,
) -> dict[str, Any]:
    """Create a new webhook trigger configuration for a flow."""
    payload: dict[str, Any] = {"name": name, "graph": flow_id}
    if is_active is not None:
        payload["is_active"] = is_active
    async with get_client() as client:
        return await client.post("/api/webhook-triggers/", json=payload)


async def update_webhook_trigger(
    trigger_id: int,
    name: str | None = None,
    is_active: bool | None = None,
) -> dict[str, Any]:
    """Update a webhook trigger configuration."""
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if is_active is not None:
        payload["is_active"] = is_active
    async with get_client() as client:
        return await client.patch(f"/api/webhook-triggers/{trigger_id}/", json=payload)


async def delete_webhook_trigger(trigger_id: int) -> dict[str, str]:
    """Delete a webhook trigger configuration by ID."""
    async with get_client() as client:
        await client.delete(f"/api/webhook-triggers/{trigger_id}/")
    return {"message": f"Webhook trigger {trigger_id} deleted successfully"}


async def register_webhooks() -> dict[str, Any]:
    """Register all webhook triggers with the webhook service.

    Activates the triggers so they start receiving incoming webhook events.
    Note: the backend re-registers every trigger and ignores any per-trigger
    selection, so this endpoint takes no arguments.
    """
    async with get_client() as client:
        return await client.post("/api/register-webhooks/", json={})


# Webhook Trigger Nodes (flow nodes — mostly read-only from this endpoint)
async def list_webhook_trigger_nodes(
    flow_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List webhook trigger nodes in flows, optionally filtered by flow."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if flow_id is not None:
        params["graph"] = flow_id
    async with get_client() as client:
        return await client.get("/api/webhook-trigger-nodes/", params=params)


# Telegram Trigger Nodes
async def list_telegram_trigger_nodes(
    flow_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List Telegram trigger nodes in flows, optionally filtered by flow."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if flow_id is not None:
        params["graph"] = flow_id
    async with get_client() as client:
        return await client.get("/api/telegram-trigger-nodes/", params=params)


async def get_telegram_trigger_node(node_id: int) -> dict[str, Any]:
    """Get a Telegram trigger node by ID."""
    async with get_client() as client:
        return await client.get(f"/api/telegram-trigger-nodes/{node_id}/")


async def list_telegram_trigger_node_fields(
    node_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List field configurations for Telegram trigger nodes."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if node_id is not None:
        params["telegram_trigger_node"] = node_id
    async with get_client() as client:
        return await client.get("/api/telegram-trigger-node-fields/", params=params)


async def list_telegram_available_fields() -> dict[str, Any]:
    """List all available fields that can be mapped from Telegram messages."""
    async with get_client() as client:
        return await client.get("/api/telegram-trigger-available-fields/")


async def register_telegram_trigger(
    node_id: int,
    bot_token: str,
) -> dict[str, Any]:
    """Register a Telegram bot for a trigger node.

    node_id: ID of the TelegramTriggerNode in the flow
    bot_token: Telegram Bot API token from @BotFather
    """
    async with get_client() as client:
        return await client.post(
            "/api/register-telegram-trigger/",
            json={"telegram_trigger_node_id": node_id, "bot_token": bot_token},
        )


# Ngrok Configuration
async def get_ngrok_config() -> dict[str, Any]:
    """Get the current ngrok tunnel configuration.

    The collection endpoint returns a paginated list; this returns the first
    (and typically only) configuration record, or an empty dict if none exist.
    """
    async with get_client() as client:
        response = await client.get("/api/ngrok-config/")
    results = response.get("results", [])
    return results[0] if results else {}


async def update_ngrok_config(
    auth_token: str | None = None,
    domain: str | None = None,
) -> dict[str, Any]:
    """Update the ngrok tunnel configuration.

    The ngrok config endpoint has no collection-level PUT; the existing record's
    id is fetched from the list first, then updated at its detail route.
    """
    async with get_client() as client:
        listing = await client.get("/api/ngrok-config/")
    results = listing.get("results", [])
    if not results:
        raise EpicStaffAPIError(
            status_code=404, detail="No ngrok configuration exists to update"
        )
    current = results[0]
    config_id = current["id"]
    payload = dict(current)
    if auth_token is not None:
        payload["auth_token"] = auth_token
    if domain is not None:
        payload["domain"] = domain
    async with get_client() as client:
        return await client.put(f"/api/ngrok-config/{config_id}/", json=payload)
