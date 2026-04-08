"""Tests for knowledge/RAG tools."""
from __future__ import annotations

import httpx
import respx

from epicstaff_mcp.tools.knowledge import (
    add_document,
    create_source_collection,
    list_source_collections,
    trigger_rag_indexing,
)
from tests.conftest import BASE_URL

COLLECTION = {
    "collection_id": 1,
    "collection_name": "Docs",
    "status": "empty",
    "collection_origin": "user",
    "created_at": "2026-04-08T10:00:00Z",
    "updated_at": "2026-04-08T10:00:00Z",
}


@respx.mock
async def test_list_collections():
    respx.get(f"{BASE_URL}api/source-collections/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [COLLECTION]})
    )
    result = await list_source_collections()
    assert result["count"] == 1


@respx.mock
async def test_create_collection():
    respx.post(f"{BASE_URL}api/source-collections/").mock(
        return_value=httpx.Response(201, json=COLLECTION)
    )
    result = await create_source_collection(collection_name="Docs")
    assert result["collection_name"] == "Docs"


@respx.mock
async def test_add_document():
    respx.post(f"{BASE_URL}api/documents/").mock(
        return_value=httpx.Response(201, json={"id": 1, "collection": 1, "content": "Hello"})
    )
    result = await add_document(collection_id=1, content="Hello")
    assert result["id"] == 1


@respx.mock
async def test_trigger_rag_indexing():
    respx.post(f"{BASE_URL}api/process-rag-indexing/").mock(
        return_value=httpx.Response(200, json={"status": "started"})
    )
    result = await trigger_rag_indexing(collection_id=1)
    assert result["status"] == "started"
