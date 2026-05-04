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


async def list_env_vars() -> dict[str, Any]:
    """List all environment variable key-value pairs stored in EpicStaff."""
    async with get_client() as client:
        return await client.get("/api/environment/config/")


async def set_env_vars(data: dict[str, str]) -> dict[str, Any]:
    """Set (create or update) one or more environment variables.

    data: mapping of variable names to their string values,
          e.g. {"OPENAI_API_KEY": "sk-...", "SOME_VAR": "value"}
    """
    async with get_client() as client:
        return await client.post("/api/environment/config/", json={"data": data})


async def delete_env_var(key: str) -> dict[str, str]:
    """Delete a single environment variable by key."""
    async with get_client() as client:
        await client.delete(f"/api/environment/config/{key}/")
    return {"message": f"Environment variable '{key}' deleted successfully"}


async def get_default_configs() -> dict[str, Any]:
    """Get the combined default configuration for agents, crews, tools, and realtime agents."""
    async with get_client() as client:
        return await client.get("/api/default-config/")


async def update_default_llm_config(
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
    """Update the global default LLM config (singleton). Fetches current values then PUTs merged data.

    Only provided (non-None) fields are changed; all others retain their current values.
    model: ID of the LLM model
    temperature: 0.0–2.0
    max_tokens: minimum 500
    """
    async with get_client() as client:
        current = await client.get("/api/default-llm-config/")
        updates: dict[str, Any] = {}
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
            ("is_visible", is_visible),
        ]:
            if val is not None:
                updates[key] = val
        payload = {**current, **updates}
        return await client.put("/api/default-llm-config/", json=payload)


async def get_default_llm_config() -> dict[str, Any]:
    """Get the current default LLM configuration."""
    async with get_client() as client:
        return await client.get("/api/default-llm-config/")


async def get_default_embedding_config() -> dict[str, Any]:
    """Get the current default embedding configuration."""
    async with get_client() as client:
        return await client.get("/api/default-embedding-config/")


async def update_default_embedding_config(
    model: int | None = None,
    custom_name: str | None = None,
) -> dict[str, Any]:
    """Update the default embedding configuration."""
    async with get_client() as client:
        current = await client.get("/api/default-embedding-config/")
    payload = dict(current)
    if model is not None:
        payload["model"] = model
    if custom_name is not None:
        payload["custom_name"] = custom_name
    async with get_client() as client:
        return await client.put("/api/default-embedding-config/", json=payload)


async def get_default_agent_config() -> dict[str, Any]:
    """Get the current default agent configuration."""
    async with get_client() as client:
        return await client.get("/api/default-agent-config/")


async def update_default_agent_config(
    llm_config: int | None = None,
    max_iter: int | None = None,
    max_rpm: int | None = None,
    max_execution_time: int | None = None,
    memory: bool | None = None,
    allow_delegation: bool | None = None,
    cache: bool | None = None,
    allow_code_execution: bool | None = None,
    max_retry_limit: int | None = None,
    respect_context_window: bool | None = None,
    default_temperature: float | None = None,
) -> dict[str, Any]:
    """Update the default agent configuration. Only provided fields are changed."""
    async with get_client() as client:
        current = await client.get("/api/default-agent-config/")
    payload = dict(current)
    updates = {
        "llm_config": llm_config,
        "max_iter": max_iter,
        "max_rpm": max_rpm,
        "max_execution_time": max_execution_time,
        "memory": memory,
        "allow_delegation": allow_delegation,
        "cache": cache,
        "allow_code_execution": allow_code_execution,
        "max_retry_limit": max_retry_limit,
        "respect_context_window": respect_context_window,
        "default_temperature": default_temperature,
    }
    for k, v in updates.items():
        if v is not None:
            payload[k] = v
    async with get_client() as client:
        return await client.put("/api/default-agent-config/", json=payload)


async def get_default_crew_config() -> dict[str, Any]:
    """Get the current default crew configuration."""
    async with get_client() as client:
        return await client.get("/api/default-crew-config/")


async def update_default_crew_config(
    manager_llm_config: int | None = None,
    planning_llm_config: int | None = None,
    memory_llm_config: int | None = None,
    embedding_config: int | None = None,
    max_rpm: int | None = None,
    cache: bool | None = None,
    full_output: bool | None = None,
    planning: bool | None = None,
    default_temperature: float | None = None,
) -> dict[str, Any]:
    """Update the default crew configuration. Only provided fields are changed."""
    async with get_client() as client:
        current = await client.get("/api/default-crew-config/")
    payload = dict(current)
    updates = {
        "manager_llm_config": manager_llm_config,
        "planning_llm_config": planning_llm_config,
        "memory_llm_config": memory_llm_config,
        "embedding_config": embedding_config,
        "max_rpm": max_rpm,
        "cache": cache,
        "full_output": full_output,
        "planning": planning,
        "default_temperature": default_temperature,
    }
    for k, v in updates.items():
        if v is not None:
            payload[k] = v
    async with get_client() as client:
        return await client.put("/api/default-crew-config/", json=payload)


async def get_default_tool_config() -> dict[str, Any]:
    """Get the current default tool configuration."""
    async with get_client() as client:
        return await client.get("/api/default-tool-config/")


async def update_default_tool_config(
    embedding_config: int | None = None,
) -> dict[str, Any]:
    """Update the default tool configuration."""
    async with get_client() as client:
        current = await client.get("/api/default-tool-config/")
    payload = dict(current)
    if embedding_config is not None:
        payload["embedding_config"] = embedding_config
    async with get_client() as client:
        return await client.put("/api/default-tool-config/", json=payload)


async def get_quickstart() -> dict[str, Any]:
    """Get the EpicStaff quickstart guide and initial configuration status."""
    async with get_client() as client:
        return await client.get("/api/quickstart/")
