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
    # add_document creates a document via the file-upload endpoint (there is no
    # JSON document-create endpoint), encoding the text content as a file.
    respx.post(f"{BASE_URL}api/documents/source-collection/1/upload/").mock(
        return_value=httpx.Response(
            201,
            json={"message": "ok", "documents": [{"document_id": 1, "file_name": "document.txt"}]},
        )
    )
    result = await add_document(collection_id=1, content="Hello")
    assert result["documents"][0]["document_id"] == 1


@respx.mock
async def test_trigger_rag_indexing():
    respx.post(f"{BASE_URL}api/process-rag-indexing/").mock(
        return_value=httpx.Response(200, json={"status": "started"})
    )
    result = await trigger_rag_indexing(rag_id=1, rag_type="naive")
    assert result["status"] == "started"
