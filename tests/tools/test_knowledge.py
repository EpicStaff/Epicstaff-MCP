"""Tests for knowledge/RAG tools."""

from __future__ import annotations

import base64
import json
from urllib.parse import parse_qs, urlparse

import httpx
import respx

from epicstaff_mcp.tools.knowledge import (
    bulk_delete_documents,
    bulk_delete_naive_rag_document_configs,
    bulk_update_naive_rag_document_configs,
    create_graph_rag,
    create_naive_rag,
    create_source_collection,
    delete_graph_rag,
    get_graph_rag,
    list_available_rags,
    list_documents,
    list_source_collections,
    trigger_rag_indexing,
    update_graph_rag_index_config,
    update_naive_rag_document_config,
    update_source_collection,
    upload_document_file,
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


def _body(route) -> dict:
    return json.loads(route.calls.last.request.content)


@respx.mock
async def test_list_collections():
    respx.get(f"{BASE_URL}api/source-collections/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [COLLECTION]})
    )
    result = await list_source_collections()
    assert result["count"] == 1


@respx.mock
async def test_create_collection():
    route = respx.post(f"{BASE_URL}api/source-collections/").mock(
        return_value=httpx.Response(201, json=COLLECTION)
    )
    result = await create_source_collection(collection_name="Docs")
    assert result["collection_name"] == "Docs"
    assert _body(route) == {"collection_name": "Docs"}


@respx.mock
async def test_update_collection_only_sends_name():
    route = respx.patch(f"{BASE_URL}api/source-collections/1/").mock(
        return_value=httpx.Response(200, json=COLLECTION)
    )
    await update_source_collection(collection_id=1, collection_name="Renamed")
    assert _body(route) == {"collection_name": "Renamed"}


@respx.mock
async def test_trigger_rag_indexing():
    # The endpoint needs the collection's rag_id + rag_type, so the tool resolves
    # the collection's RAG configuration first, then indexes each one.
    respx.get(f"{BASE_URL}api/source-collections/1/").mock(
        return_value=httpx.Response(
            200,
            json={
                "collection_id": 1,
                "rag_configurations": [{"rag_id": 4, "rag_type": "naive"}],
            },
        )
    )
    route = respx.post(f"{BASE_URL}api/process-rag-indexing/").mock(
        return_value=httpx.Response(200, json={"status": "started"})
    )
    result = await trigger_rag_indexing(collection_id=1)
    assert result["count"] == 1
    assert _body(route) == {"collection_id": 1, "rag_id": 4, "rag_type": "naive"}


@respx.mock
async def test_list_documents_uses_collection_id_param():
    route = respx.get(f"{BASE_URL}api/documents/").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    await list_documents(collection_id=7)
    query = parse_qs(urlparse(str(route.calls.last.request.url)).query)
    assert query["collection_id"] == ["7"]
    assert "collection" not in query


@respx.mock
async def test_bulk_delete_documents_uses_document_ids_key():
    route = respx.post(f"{BASE_URL}api/documents/bulk-delete/").mock(
        return_value=httpx.Response(200, json={"deleted_count": 2})
    )
    await bulk_delete_documents(document_ids=[1, 2])
    assert _body(route) == {"document_ids": [1, 2]}


@respx.mock
async def test_upload_document_file_uses_files_field():
    route = respx.post(f"{BASE_URL}api/documents/source-collection/1/upload/").mock(
        return_value=httpx.Response(201, json={"documents": []})
    )
    content = base64.b64encode(b"hello world").decode()
    await upload_document_file(
        collection_id=1, file_content_base64=content, filename="a.txt"
    )
    request = route.calls.last.request
    assert b'name="files"' in request.content
    assert b'name="file"\r\n' not in request.content


@respx.mock
async def test_create_naive_rag_sends_embedder_id():
    route = respx.post(f"{BASE_URL}api/naive-rag/collections/1/naive-rag/").mock(
        return_value=httpx.Response(200, json={"naive_rag": {"naive_rag_id": 5}})
    )
    await create_naive_rag(collection_id=1, embedder_id=42)
    assert _body(route) == {"embedder_id": 42}


@respx.mock
async def test_update_naive_rag_document_config_partial_no_get():
    get_route = respx.get(f"{BASE_URL}api/naive-rag/1/document-configs/3/").mock(
        return_value=httpx.Response(200, json={})
    )
    put_route = respx.put(f"{BASE_URL}api/naive-rag/1/document-configs/3/").mock(
        return_value=httpx.Response(200, json={"config": {}})
    )
    await update_naive_rag_document_config(naive_rag_id=1, config_id=3, chunk_size=500)
    # No GET round-trip; only the provided field is sent.
    assert not get_route.called
    assert _body(put_route) == {"chunk_size": 500}


@respx.mock
async def test_bulk_update_naive_rag_document_configs_sends_object():
    route = respx.put(f"{BASE_URL}api/naive-rag/1/document-configs/bulk-update/").mock(
        return_value=httpx.Response(200, json={"updated_count": 2})
    )
    await bulk_update_naive_rag_document_configs(
        naive_rag_id=1, config_ids=[10, 11], chunk_size=800, chunk_overlap=50
    )
    assert _body(route) == {
        "config_ids": [10, 11],
        "chunk_size": 800,
        "chunk_overlap": 50,
    }


@respx.mock
async def test_bulk_delete_naive_rag_document_configs_uses_config_ids_key():
    route = respx.post(f"{BASE_URL}api/naive-rag/1/document-configs/bulk-delete/").mock(
        return_value=httpx.Response(200, json={"deleted_count": 2})
    )
    await bulk_delete_naive_rag_document_configs(naive_rag_id=1, config_ids=[10, 11])
    assert _body(route) == {"config_ids": [10, 11]}


@respx.mock
async def test_list_available_rags():
    route = respx.get(f"{BASE_URL}api/source-collections/1/available-rags/").mock(
        return_value=httpx.Response(200, json=[{"rag_id": 5, "rag_type": "naive"}])
    )
    result = await list_available_rags(collection_id=1)
    assert route.called
    assert result["results"][0]["rag_type"] == "naive"


@respx.mock
async def test_create_graph_rag_sends_embedder_and_llm():
    route = respx.post(f"{BASE_URL}api/graph-rag/collections/1/graph-rag/").mock(
        return_value=httpx.Response(200, json={"graph_rag": {"graph_rag_id": 9}})
    )
    await create_graph_rag(collection_id=1, embedder_id=2, llm_id=3)
    assert _body(route) == {"embedder_id": 2, "llm_id": 3}


@respx.mock
async def test_get_graph_rag():
    respx.get(f"{BASE_URL}api/graph-rag/9/").mock(
        return_value=httpx.Response(200, json={"graph_rag_id": 9})
    )
    result = await get_graph_rag(graph_rag_id=9)
    assert result["graph_rag_id"] == 9


@respx.mock
async def test_delete_graph_rag():
    route = respx.delete(f"{BASE_URL}api/graph-rag/9/").mock(
        return_value=httpx.Response(
            200, json={"message": "GraphRag deleted successfully"}
        )
    )
    result = await delete_graph_rag(graph_rag_id=9)
    assert route.called
    assert "message" in result


@respx.mock
async def test_update_graph_rag_index_config_partial():
    route = respx.put(f"{BASE_URL}api/graph-rag/9/index-config/").mock(
        return_value=httpx.Response(200, json={"graph_rag": {}})
    )
    await update_graph_rag_index_config(
        graph_rag_id=9, chunk_size=1200, entity_types=["person", "org"]
    )
    assert _body(route) == {"chunk_size": 1200, "entity_types": ["person", "org"]}
