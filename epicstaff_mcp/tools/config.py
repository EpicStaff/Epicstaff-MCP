"""MCP tools for EpicStaff health check and provider configuration."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.config import get_settings
from epicstaff_mcp.exceptions import EpicStaffConnectionError


async def ping() -> dict[str, Any]:
    """Check if EpicStaff is reachable.

    Returns {"status": "ok", "base_url": ...} on success,
    {"status": "error", "base_url": ..., "detail": ...} on failure.
    """
    settings = get_settings()
    try:
        async with get_client() as client:
            await client.get("/api/providers/")
        return {"status": "ok", "base_url": settings.base_url}
    except EpicStaffConnectionError as exc:
        return {"status": "error", "base_url": settings.base_url, "detail": str(exc)}


async def list_providers(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List available LLM providers (OpenAI, Anthropic, Groq, etc.)."""
    async with get_client() as client:
        return await client.get("/api/providers/", params={"limit": limit, "offset": offset})
