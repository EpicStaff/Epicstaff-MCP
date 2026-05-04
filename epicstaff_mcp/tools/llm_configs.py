"""MCP tools for managing EpicStaff LLM and embedding configurations."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_llm_configs(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all LLM configurations."""
    async with get_client() as client:
        return await client.get("/api/llm-configs/", params={"limit": limit, "offset": offset})


async def get_llm_config(config_id: int) -> dict[str, Any]:
    """Get an LLM configuration by ID."""
    async with get_client() as client:
        return await client.get(f"/api/llm-configs/{config_id}/")


async def create_llm_config(
    custom_name: str,
    model: int | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    max_tokens: int | None = None,
    presence_penalty: float | None = None,
    frequency_penalty: float | None = None,
    seed: int | None = None,
    api_key: str | None = None,
    timeout: float | None = None,
    is_visible: bool = True,
) -> dict[str, Any]:
    """Create a new LLM configuration.

    custom_name: unique display name for this config
    model: ID of the LLM model to use (from list_providers)
    temperature: 0.0–2.0
    max_tokens: minimum 500
    """
    payload: dict[str, Any] = {"custom_name": custom_name, "is_visible": is_visible}
    for key, val in [
        ("model", model),
        ("temperature", temperature),
        ("top_p", top_p),
        ("max_tokens", max_tokens),
        ("presence_penalty", presence_penalty),
        ("frequency_penalty", frequency_penalty),
        ("seed", seed),
        ("api_key", api_key),
        ("timeout", timeout),
    ]:
        if val is not None:
            payload[key] = val
    async with get_client() as client:
        return await client.post("/api/llm-configs/", json=payload)


async def update_llm_config(
    config_id: int,
    custom_name: str | None = None,
    model: int | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    max_tokens: int | None = None,
    presence_penalty: float | None = None,
    frequency_penalty: float | None = None,
    seed: int | None = None,
    api_key: str | None = None,
    timeout: float | None = None,
    is_visible: bool | None = None,
) -> dict[str, Any]:
    """Update one or more fields of an LLM configuration.

    Only provided (non-None) fields are sent in the PATCH request.
    """
    payload: dict[str, Any] = {}
    for key, val in [
        ("custom_name", custom_name),
        ("model", model),
        ("temperature", temperature),
        ("top_p", top_p),
        ("max_tokens", max_tokens),
        ("presence_penalty", presence_penalty),
        ("frequency_penalty", frequency_penalty),
        ("seed", seed),
        ("api_key", api_key),
        ("timeout", timeout),
        ("is_visible", is_visible),
    ]:
        if val is not None:
            payload[key] = val
    async with get_client() as client:
        return await client.patch(f"/api/llm-configs/{config_id}/", json=payload)


async def delete_llm_config(config_id: int) -> dict[str, str]:
    """Delete an LLM configuration."""
    async with get_client() as client:
        await client.delete(f"/api/llm-configs/{config_id}/")
    return {"message": f"LLM config {config_id} deleted successfully"}


async def list_embedding_configs(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all embedding configurations."""
    async with get_client() as client:
        return await client.get(
            "/api/embedding-configs/", params={"limit": limit, "offset": offset}
        )


async def create_embedding_config(
    custom_name: str,
    model: int | None = None,
) -> dict[str, Any]:
    """Create a new embedding configuration."""
    payload: dict[str, Any] = {"custom_name": custom_name}
    if model is not None:
        payload["model"] = model
    async with get_client() as client:
        return await client.post("/api/embedding-configs/", json=payload)


async def get_embedding_config(config_id: int) -> dict[str, Any]:
    """Get an embedding configuration by ID."""
    async with get_client() as client:
        return await client.get(f"/api/embedding-configs/{config_id}/")


async def update_embedding_config(
    config_id: int,
    custom_name: str | None = None,
    model: int | None = None,
) -> dict[str, Any]:
    """Update one or more fields of an embedding configuration.

    Only provided (non-None) fields are sent in the PATCH request.
    """
    payload: dict[str, Any] = {}
    if custom_name is not None:
        payload["custom_name"] = custom_name
    if model is not None:
        payload["model"] = model
    async with get_client() as client:
        return await client.patch(f"/api/embedding-configs/{config_id}/", json=payload)


async def delete_embedding_config(config_id: int) -> dict[str, str]:
    """Delete an embedding configuration by ID."""
    async with get_client() as client:
        await client.delete(f"/api/embedding-configs/{config_id}/")
    return {"message": f"Embedding config {config_id} deleted successfully"}


async def list_llm_models(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all available LLM models (used when creating or updating LLM configs)."""
    async with get_client() as client:
        return await client.get("/api/llm-models/", params={"limit": limit, "offset": offset})


async def list_embedding_models(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all available embedding models (used when creating or updating embedding configs)."""
    async with get_client() as client:
        return await client.get(
            "/api/embedding-models/", params={"limit": limit, "offset": offset}
        )
