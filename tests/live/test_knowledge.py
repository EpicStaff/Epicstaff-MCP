"""Live tests for knowledge / RAG tools (epicstaff_mcp/tools/knowledge.py)."""
from __future__ import annotations

import base64

import pytest

from epicstaff_mcp.tools import knowledge


async def test_labels_crud():
    created = await knowledge.create_label(name="audit-probe-label", color="#FF5733")
    label_id = created["id"]
    try:
        listed = await knowledge.list_labels()
        assert any(l["id"] == label_id for l in listed["results"])
    finally:
        msg = await knowledge.delete_label(label_id)
        assert "deleted" in msg["message"]


async def test_list_naive_rag_document_chunks():
    # Global read endpoint — should always answer.
    result = await knowledge.list_naive_rag_document_chunks()
    assert isinstance(result, dict)


@pytest.fixture
async def collection(embedding_config_id):
    created = await knowledge.create_source_collection(
        collection_name="audit-probe-collection",
        embedding_config=embedding_config_id,
    )
    yield created
    try:
        await knowledge.delete_source_collection(created["collection_id"] if "collection_id" in created else created["id"])
    except Exception:
        pass


def _cid(collection: dict) -> int:
    return collection.get("collection_id", collection.get("id"))


async def test_collection_crud_and_documents(collection):
    cid = _cid(collection)

    fetched = await knowledge.get_source_collection(cid)
    assert _cid(fetched) == cid

    updated = await knowledge.update_source_collection(
        cid, collection_name="audit-probe-collection-2"
    )
    assert updated["collection_name"] == "audit-probe-collection-2"

    listed = await knowledge.list_source_collections()
    assert any(_cid(c) == cid for c in listed["results"])

    # add a text document (routed through the upload endpoint)
    doc = await knowledge.add_document(
        cid, content="The quick brown fox jumps over the lazy dog.",
    )
    doc_id = doc["documents"][0]["document_id"]

    # upload a file document (multipart "files" field)
    b64 = base64.b64encode(b"Audit upload content line one.\nLine two.").decode()
    upload = await knowledge.upload_document_file(cid, b64, "audit.txt")
    assert isinstance(upload, dict)

    got = await knowledge.get_document(doc_id)
    assert got["document_id"] == doc_id

    in_coll = await knowledge.list_collection_documents(cid)
    assert in_coll["document_count"] >= 1

    all_docs = await knowledge.list_documents(collection_id=cid)
    assert len(all_docs["results"]) >= 1

    # delete the text doc individually, leave the uploaded one for collection delete
    del_resp = await knowledge.delete_document(doc_id)
    assert isinstance(del_resp, dict)


async def test_naive_rag_lifecycle(collection, embedding_config_id):
    cid = _cid(collection)
    await knowledge.add_document(cid, content="EpicStaff is an agent orchestration platform.")

    rag = await knowledge.create_naive_rag(
        collection_id=cid, embedder_id=embedding_config_id, chunk_size=400, chunk_overlap=40
    )
    rag_id = rag["naive_rag"]["naive_rag_id"]

    for_coll = await knowledge.list_naive_rag_for_collection(cid)
    assert isinstance(for_coll, dict)

    fetched = await knowledge.get_naive_rag(rag_id)
    assert fetched["naive_rag_id"] == rag_id

    # initialize per-document configs
    await knowledge.init_naive_rag_document_configs(rag_id)
    configs = await knowledge.list_naive_rag_document_configs(rag_id)
    cfg_list = configs["configs"]
    assert cfg_list, f"no document configs created: {configs}"
    config_id = cfg_list[0]["naive_rag_document_id"]

    single_cfg = await knowledge.get_naive_rag_document_config(rag_id, config_id)
    assert isinstance(single_cfg, dict)

    upd = await knowledge.update_naive_rag_document_config(rag_id, config_id, chunk_size=300)
    assert upd["config"]["chunk_size"] == 300

    # preview chunking
    chunked = await knowledge.process_chunking(rag_id, config_id)
    assert isinstance(chunked, dict)

    chunks = await knowledge.list_naive_rag_chunks(rag_id, config_id)
    assert isinstance(chunks, dict)

    # trigger async indexing (worker + real embedder key required)
    indexing = await knowledge.trigger_rag_indexing(rag_id=rag_id, rag_type="naive")
    assert isinstance(indexing, dict)

    # bulk update then bulk delete the config (config ids = naive_rag_document_id)
    bulk_upd = await knowledge.bulk_update_naive_rag_document_configs(
        rag_id, config_ids=[config_id], chunk_size=256
    )
    assert isinstance(bulk_upd, dict)
    bulk_del = await knowledge.bulk_delete_naive_rag_document_configs(rag_id, [config_id])
    assert isinstance(bulk_del, dict)


async def test_bulk_delete_documents_and_copy(collection):
    cid = _cid(collection)
    d1 = (await knowledge.add_document(cid, content="bulk doc one"))["documents"][0]["document_id"]
    d2 = (await knowledge.add_document(cid, content="bulk doc two"))["documents"][0]["document_id"]

    bulk = await knowledge.bulk_delete_documents([d1, d2])
    assert isinstance(bulk, dict)

    copy = await knowledge.copy_source_collection(cid, new_collection_name="audit-probe-copy")
    copy_id = copy["collection"]["collection_id"]
    assert copy_id is not None
    await knowledge.delete_source_collection(copy_id)
