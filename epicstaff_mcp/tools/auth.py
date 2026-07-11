"""MCP tools for EpicStaff authentication — API key management."""

from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def create_api_key(
    name: str,
    scopes: list[str] | None = None,
) -> dict[str, Any]:
    """Create a long-lived EpicStaff API key for the current user.

    Use this to authenticate a client (a custom UI, a script, a service) with a
    durable key instead of an email/password login. The key is owned by the
    account the MCP server is authenticated as.

    The raw key is returned only ONCE — store it securely. EpicStaff keeps only a
    salted hash and can never show it again. Authenticate with it by sending EITHER
    header on subsequent requests:
        Authorization: ApiKey <key>
        X-Api-Key: <key>

    name: human-readable label for the key (e.g. "pallet-quote-ui"). Required.
    scopes: optional list of scope strings. Defaults to no scopes.

    Returns {api_key, prefix, name, scopes, created_at}. `prefix` is the first 8
    characters (safe to display/log); `api_key` is the full secret.
    """
    payload: dict[str, Any] = {"name": name, "scopes": scopes or []}
    async with get_client() as client:
        return await client.post("/api/auth/api-key/", json=payload)
