"""MCP tools for managing EpicStaff knowledge bases (RAG source collections)."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_source_collections(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all RAG knowledge collections."""
    async with get_client() as client:
        return await client.get(
            "/api/source-collections/", params={"limit": limit, "offset": offset}
        )


async def create_source_collection(
    collection_name: str,
    embedding_config: int | None = None,
) -> dict[str, Any]:
    """Create a new knowledge collection for RAG."""
    payload: dict[str, Any] = {"collection_name": collection_name}
    if embedding_config is not None:
        payload["embedding_config"] = embedding_config
    async with get_client() as client:
        return await client.post("/api/source-collections/", json=payload)


async def add_document(
    collection_id: int,
    content: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Add a document to a knowledge collection."""
    payload: dict[str, Any] = {"collection": collection_id, "content": content}
    if metadata:
        payload["metadata"] = metadata
    async with get_client() as client:
        return await client.post("/api/documents/", json=payload)


async def trigger_rag_indexing(collection_id: int) -> dict[str, Any]:
    """Trigger embedding computation and vector indexing for a collection."""
    async with get_client() as client:
        return await client.post(
            "/api/process-rag-indexing/", json={"collection_id": collection_id}
        )
