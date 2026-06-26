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
    filename: str = "document.txt",
) -> dict[str, Any]:
    """Add a text document to a knowledge collection.

    The backend exposes no JSON document-create endpoint (`/api/documents/` is
    list/retrieve/delete only); documents are created exclusively through the
    file-upload endpoint. This uploads `content` as a text file via that path.
    Returns the upload envelope `{"message": ..., "documents": [...]}`.
    """
    file_bytes = content.encode("utf-8")
    async with get_client() as client:
        return await client.post_multipart(
            f"/api/documents/source-collection/{collection_id}/upload/",
            files={"files": (filename, file_bytes)},
        )


async def trigger_rag_indexing(rag_id: int, rag_type: str = "naive") -> dict[str, Any]:
    """Trigger embedding computation and vector indexing for a RAG configuration.

    rag_id: the NaiveRag id (naive_rag_id) to index — NOT the collection id.
    rag_type: "naive" (default) or "graph". The backend derives the collection
    from the RAG, so the endpoint requires {rag_id, rag_type}, not collection_id.
    """
    async with get_client() as client:
        return await client.post(
            "/api/process-rag-indexing/", json={"rag_id": rag_id, "rag_type": rag_type}
        )


async def get_source_collection(collection_id: int) -> dict[str, Any]:
    """Get a knowledge collection by its ID."""
    async with get_client() as client:
        return await client.get(f"/api/source-collections/{collection_id}/")


async def update_source_collection(
    collection_id: int,
    collection_name: str | None = None,
    embedding_config: int | None = None,
) -> dict[str, Any]:
    """Update a knowledge collection by its ID."""
    payload: dict[str, Any] = {}
    if collection_name is not None:
        payload["collection_name"] = collection_name
    if embedding_config is not None:
        payload["embedding_config"] = embedding_config
    async with get_client() as client:
        return await client.patch(f"/api/source-collections/{collection_id}/", json=payload)


async def delete_source_collection(collection_id: int) -> dict[str, Any]:
    """Delete a knowledge collection by its ID."""
    async with get_client() as client:
        return await client.delete(f"/api/source-collections/{collection_id}/")


async def list_documents(
    collection_id: int | None = None, limit: int = 100, offset: int = 0
) -> dict[str, Any]:
    """List documents, optionally filtered by collection ID."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if collection_id is not None:
        params["collection"] = collection_id
    async with get_client() as client:
        return await client.get("/api/documents/", params=params)


async def delete_document(document_id: int) -> dict[str, Any]:
    """Delete a document by its ID."""
    async with get_client() as client:
        return await client.delete(f"/api/documents/{document_id}/")


async def copy_source_collection(
    collection_id: int,
    new_collection_name: str | None = None,
) -> dict[str, Any]:
    """Copy a knowledge collection and all its documents to a new collection."""
    payload: dict[str, Any] = {}
    if new_collection_name is not None:
        payload["new_collection_name"] = new_collection_name
    async with get_client() as client:
        return await client.post(f"/api/source-collections/{collection_id}/copy/", json=payload)


async def list_collection_documents(
    collection_id: int,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List all documents in a specific source collection."""
    async with get_client() as client:
        return await client.get(
            f"/api/source-collections/{collection_id}/documents/",
            params={"limit": limit, "offset": offset},
        )


async def get_document(document_id: int) -> dict[str, Any]:
    """Get full details of a document by ID."""
    async with get_client() as client:
        return await client.get(f"/api/documents/{document_id}/")


async def bulk_delete_documents(document_ids: list[int]) -> dict[str, Any]:
    """Delete multiple documents by their IDs in a single request."""
    # Backend DocumentBulkDeleteSerializer requires the field `document_ids`.
    async with get_client() as client:
        return await client.post(
            "/api/documents/bulk-delete/", json={"document_ids": document_ids}
        )


async def upload_document_file(
    collection_id: int,
    file_content_base64: str,
    filename: str,
) -> dict[str, Any]:
    """Upload a file as a document to a source collection. Provide file content as base64."""
    import base64

    file_bytes = base64.b64decode(file_content_base64)
    async with get_client() as client:
        # Backend's document upload serializer reads request.FILES.getlist("files")
        # — the multipart field MUST be named "files" (not "file"), or it 400s
        # with {'files': ['This field is required.']}.
        return await client.post_multipart(
            f"/api/documents/source-collection/{collection_id}/upload/",
            files={"files": (filename, file_bytes)},
        )


# Naive RAG
async def list_naive_rag_for_collection(collection_id: int) -> dict[str, Any]:
    """List Naive RAG configurations associated with a source collection."""
    async with get_client() as client:
        return await client.get(f"/api/naive-rag/collections/{collection_id}/naive-rag/")


async def create_naive_rag(
    collection_id: int,
    embedder_id: int,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
    chunk_strategy: str | None = None,
) -> dict[str, Any]:
    """Create a Naive RAG configuration for a source collection.

    embedder_id (REQUIRED): the EmbeddingConfig id used to embed this collection's
    chunks — the backend rejects the create without it. Use the same embedding
    config the collection was created with (see list_embedding_configs).
    """
    payload: dict[str, Any] = {
        "source_collection": collection_id,
        "embedder_id": embedder_id,
    }
    if chunk_size is not None:
        payload["chunk_size"] = chunk_size
    if chunk_overlap is not None:
        payload["chunk_overlap"] = chunk_overlap
    if chunk_strategy is not None:
        payload["chunk_strategy"] = chunk_strategy
    async with get_client() as client:
        return await client.post(
            f"/api/naive-rag/collections/{collection_id}/naive-rag/", json=payload
        )


async def get_naive_rag(naive_rag_id: int) -> dict[str, Any]:
    """Get a Naive RAG configuration by ID."""
    async with get_client() as client:
        return await client.get(f"/api/naive-rag/{naive_rag_id}/")


async def delete_naive_rag(naive_rag_id: int) -> dict[str, str]:
    """Delete a Naive RAG configuration by ID."""
    async with get_client() as client:
        await client.delete(f"/api/naive-rag/{naive_rag_id}/")
    return {"message": f"Naive RAG {naive_rag_id} deleted successfully"}


async def init_naive_rag_document_configs(naive_rag_id: int) -> dict[str, Any]:
    """Initialize document configs for a Naive RAG (creates configs for all documents)."""
    async with get_client() as client:
        return await client.post(f"/api/naive-rag/{naive_rag_id}/document-configs/initialize/")


async def list_naive_rag_document_configs(naive_rag_id: int) -> dict[str, Any]:
    """List all document configs for a Naive RAG configuration."""
    async with get_client() as client:
        return await client.get(f"/api/naive-rag/{naive_rag_id}/document-configs/")


async def get_naive_rag_document_config(naive_rag_id: int, config_id: int) -> dict[str, Any]:
    """Get a specific document config within a Naive RAG."""
    async with get_client() as client:
        return await client.get(
            f"/api/naive-rag/{naive_rag_id}/document-configs/{config_id}/"
        )


async def update_naive_rag_document_config(
    naive_rag_id: int,
    config_id: int,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
    chunk_strategy: str | None = None,
    is_active: bool | None = None,
) -> dict[str, Any]:
    """Update a Naive RAG document config."""
    async with get_client() as client:
        current = await client.get(
            f"/api/naive-rag/{naive_rag_id}/document-configs/{config_id}/"
        )
    payload = dict(current)
    updates = {
        "chunk_size": chunk_size,
        "chunk_overlap": chunk_overlap,
        "chunk_strategy": chunk_strategy,
        "is_active": is_active,
    }
    for k, v in updates.items():
        if v is not None:
            payload[k] = v
    async with get_client() as client:
        return await client.put(
            f"/api/naive-rag/{naive_rag_id}/document-configs/{config_id}/", json=payload
        )


async def delete_naive_rag_document_config(naive_rag_id: int, config_id: int) -> dict[str, str]:
    """Delete a Naive RAG document config by ID."""
    async with get_client() as client:
        await client.delete(
            f"/api/naive-rag/{naive_rag_id}/document-configs/{config_id}/"
        )
    return {"message": f"Document config {config_id} deleted successfully"}


async def bulk_update_naive_rag_document_configs(
    naive_rag_id: int,
    config_ids: list[int],
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
    chunk_strategy: str | None = None,
    additional_params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bulk update document configs for a Naive RAG.

    The backend applies the SAME update fields to every config in `config_ids`
    (config ids are `naive_rag_document_id` values). At least one of
    chunk_size / chunk_overlap / chunk_strategy / additional_params is required.
    """
    payload: dict[str, Any] = {"config_ids": config_ids}
    for key, val in [
        ("chunk_size", chunk_size),
        ("chunk_overlap", chunk_overlap),
        ("chunk_strategy", chunk_strategy),
        ("additional_params", additional_params),
    ]:
        if val is not None:
            payload[key] = val
    async with get_client() as client:
        return await client.put(
            f"/api/naive-rag/{naive_rag_id}/document-configs/bulk-update/", json=payload
        )


async def bulk_delete_naive_rag_document_configs(
    naive_rag_id: int,
    config_ids: list[int],
) -> dict[str, Any]:
    """Bulk delete multiple document configs from a Naive RAG."""
    # Backend DocumentConfigBulkDeleteSerializer requires the field `config_ids`.
    async with get_client() as client:
        return await client.post(
            f"/api/naive-rag/{naive_rag_id}/document-configs/bulk-delete/",
            json={"config_ids": config_ids},
        )


async def process_chunking(naive_rag_id: int, config_id: int) -> dict[str, Any]:
    """Preview chunking for a specific document config (does not save)."""
    async with get_client() as client:
        return await client.post(
            f"/api/naive-rag/{naive_rag_id}/document-configs/{config_id}/process-chunking/"
        )


async def list_naive_rag_chunks(naive_rag_id: int, config_id: int) -> dict[str, Any]:
    """List chunks for a specific Naive RAG document config."""
    async with get_client() as client:
        return await client.get(
            f"/api/naive-rag/{naive_rag_id}/document-configs/{config_id}/chunks/"
        )


async def list_naive_rag_document_chunks(
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List all Naive RAG document chunks across all configs."""
    async with get_client() as client:
        return await client.get(
            "/api/naive-rag-document-chunks/",
            params={"limit": limit, "offset": offset},
        )


# Labels
async def list_labels(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all labels."""
    async with get_client() as client:
        return await client.get("/api/labels/", params={"limit": limit, "offset": offset})


async def create_label(name: str, color: str | None = None) -> dict[str, Any]:
    """Create a new label. Color should be a hex color code (e.g. '#FF5733')."""
    payload: dict[str, Any] = {"name": name}
    if color is not None:
        payload["color"] = color
    async with get_client() as client:
        return await client.post("/api/labels/", json=payload)


async def delete_label(label_id: int) -> dict[str, str]:
    """Delete a label by ID."""
    async with get_client() as client:
        await client.delete(f"/api/labels/{label_id}/")
    return {"message": f"Label {label_id} deleted successfully"}
