"""MCP tools for querying EpicStaff crew memory (vector store)."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client


async def list_memories(
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List stored crew memory records (vector database entries).

    Each record contains an 'id' (UUID) and a 'payload' object with the memory content.
    """
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    async with get_client() as client:
        return await client.get("/api/memory/", params=params)


async def delete_memory(memory_id: str) -> dict[str, str]:
    """Delete a memory entry by ID.

    ``memory_id`` is the UUID string primary key returned by ``list_memories``
    (the backend MemoryDatabase PK is a UUID, not an integer).
    """
    async with get_client() as client:
        await client.delete(f"/api/memory/{memory_id}/")
    return {"message": f"Memory {memory_id} deleted successfully"}
