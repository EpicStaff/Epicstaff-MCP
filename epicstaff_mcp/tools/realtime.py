"""MCP tools for EpicStaff realtime (voice/audio) features."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


# Realtime Models (read-only catalogue)
async def list_realtime_models(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all available realtime models."""
    async with get_client() as client:
        return await client.get(
            "/api/realtime-models/", params={"limit": limit, "offset": offset}
        )


# Realtime Model Configs
async def list_realtime_model_configs(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all realtime model configurations."""
    async with get_client() as client:
        return await client.get(
            "/api/realtime-model-configs/", params={"limit": limit, "offset": offset}
        )


async def get_realtime_model_config(config_id: int) -> dict[str, Any]:
    """Get a realtime model configuration by ID."""
    async with get_client() as client:
        return await client.get(f"/api/realtime-model-configs/{config_id}/")


async def create_realtime_model_config(
    custom_name: str,
    model: int,
    temperature: float | None = None,
    max_response_output_tokens: int | None = None,
    voice: str | None = None,
    instructions: str | None = None,
) -> dict[str, Any]:
    """Create a new realtime model configuration."""
    payload: dict[str, Any] = {"custom_name": custom_name, "model": model}
    if temperature is not None:
        payload["temperature"] = temperature
    if max_response_output_tokens is not None:
        payload["max_response_output_tokens"] = max_response_output_tokens
    if voice is not None:
        payload["voice"] = voice
    if instructions is not None:
        payload["instructions"] = instructions
    async with get_client() as client:
        return await client.post("/api/realtime-model-configs/", json=payload)


async def update_realtime_model_config(
    config_id: int,
    custom_name: str | None = None,
    model: int | None = None,
    temperature: float | None = None,
    max_response_output_tokens: int | None = None,
    voice: str | None = None,
    instructions: str | None = None,
) -> dict[str, Any]:
    """Update a realtime model configuration. Only provided fields are changed."""
    payload: dict[str, Any] = {}
    if custom_name is not None:
        payload["custom_name"] = custom_name
    if model is not None:
        payload["model"] = model
    if temperature is not None:
        payload["temperature"] = temperature
    if max_response_output_tokens is not None:
        payload["max_response_output_tokens"] = max_response_output_tokens
    if voice is not None:
        payload["voice"] = voice
    if instructions is not None:
        payload["instructions"] = instructions
    async with get_client() as client:
        return await client.patch(f"/api/realtime-model-configs/{config_id}/", json=payload)


async def delete_realtime_model_config(config_id: int) -> dict[str, str]:
    """Delete a realtime model configuration by ID."""
    async with get_client() as client:
        await client.delete(f"/api/realtime-model-configs/{config_id}/")
    return {"message": f"Realtime model config {config_id} deleted successfully"}


# Realtime Transcription Models (read-only catalogue)
async def list_realtime_transcription_models(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all available realtime transcription models."""
    async with get_client() as client:
        return await client.get(
            "/api/realtime-transcription-models/", params={"limit": limit, "offset": offset}
        )


# Realtime Transcription Model Configs
async def list_realtime_transcription_model_configs(
    limit: int = 100, offset: int = 0
) -> dict[str, Any]:
    """List all realtime transcription model configurations."""
    async with get_client() as client:
        return await client.get(
            "/api/realtime-transcription-model-configs/",
            params={"limit": limit, "offset": offset},
        )


async def create_realtime_transcription_model_config(
    custom_name: str,
    model: int,
) -> dict[str, Any]:
    """Create a new realtime transcription model configuration."""
    async with get_client() as client:
        return await client.post(
            "/api/realtime-transcription-model-configs/",
            json={"custom_name": custom_name, "model": model},
        )


async def update_realtime_transcription_model_config(
    config_id: int,
    custom_name: str | None = None,
    model: int | None = None,
) -> dict[str, Any]:
    """Update a realtime transcription model configuration."""
    payload: dict[str, Any] = {}
    if custom_name is not None:
        payload["custom_name"] = custom_name
    if model is not None:
        payload["model"] = model
    async with get_client() as client:
        return await client.patch(
            f"/api/realtime-transcription-model-configs/{config_id}/", json=payload
        )


async def delete_realtime_transcription_model_config(config_id: int) -> dict[str, str]:
    """Delete a realtime transcription model configuration by ID."""
    async with get_client() as client:
        await client.delete(f"/api/realtime-transcription-model-configs/{config_id}/")
    return {"message": f"Realtime transcription model config {config_id} deleted successfully"}


# Realtime Agents
async def list_realtime_agents(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all realtime agents."""
    async with get_client() as client:
        return await client.get(
            "/api/realtime-agents/", params={"limit": limit, "offset": offset}
        )


async def get_realtime_agent(agent_id: int) -> dict[str, Any]:
    """Get a realtime agent by ID."""
    async with get_client() as client:
        return await client.get(f"/api/realtime-agents/{agent_id}/")


async def create_realtime_agent(
    name: str,
    realtime_config: int | None = None,
    transcription_config: int | None = None,
    knowledge_collection: int | None = None,
) -> dict[str, Any]:
    """Create a new realtime agent."""
    payload: dict[str, Any] = {"name": name}
    if realtime_config is not None:
        payload["realtime_config"] = realtime_config
    if transcription_config is not None:
        payload["transcription_config"] = transcription_config
    if knowledge_collection is not None:
        payload["knowledge_collection"] = knowledge_collection
    async with get_client() as client:
        return await client.post("/api/realtime-agents/", json=payload)


async def update_realtime_agent(
    agent_id: int,
    name: str | None = None,
    realtime_config: int | None = None,
    transcription_config: int | None = None,
    knowledge_collection: int | None = None,
) -> dict[str, Any]:
    """Update a realtime agent. Only provided fields are changed."""
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if realtime_config is not None:
        payload["realtime_config"] = realtime_config
    if transcription_config is not None:
        payload["transcription_config"] = transcription_config
    if knowledge_collection is not None:
        payload["knowledge_collection"] = knowledge_collection
    async with get_client() as client:
        return await client.patch(f"/api/realtime-agents/{agent_id}/", json=payload)


async def delete_realtime_agent(agent_id: int) -> dict[str, str]:
    """Delete a realtime agent by ID."""
    async with get_client() as client:
        await client.delete(f"/api/realtime-agents/{agent_id}/")
    return {"message": f"Realtime agent {agent_id} deleted successfully"}


# Realtime Agent Chats
async def list_realtime_agent_chats(
    agent_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List realtime agent chat sessions, optionally filtered by agent."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if agent_id is not None:
        params["realtime_agent"] = agent_id
    async with get_client() as client:
        return await client.get("/api/realtime-agent-chats/", params=params)


# Realtime Session Items
async def list_realtime_session_items(
    session_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List realtime session items, optionally filtered by session."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if session_id is not None:
        params["session"] = session_id
    async with get_client() as client:
        return await client.get("/api/realtime-session-items/", params=params)


# Realtime Session Initialization
async def init_realtime(
    agent_id: int,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Initialize a realtime session for a realtime agent.

    Returns connection credentials and session info for establishing a WebRTC/WebSocket connection.
    """
    payload: dict[str, Any] = {"realtime_agent": agent_id}
    if session_id is not None:
        payload["session_id"] = session_id
    async with get_client() as client:
        return await client.post("/api/init-realtime/", json=payload)
