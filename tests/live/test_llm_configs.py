"""Live tests for LLM + embedding config tools (epicstaff_mcp/tools/llm_configs.py)."""
from __future__ import annotations

from epicstaff_mcp.tools import llm_configs


async def test_list_llm_models():
    result = await llm_configs.list_llm_models()
    assert result["count"] >= 1
    assert "id" in result["results"][0]


async def test_list_embedding_models():
    result = await llm_configs.list_embedding_models()
    assert result["count"] >= 1


async def test_llm_config_crud_lifecycle():
    models = await llm_configs.list_llm_models(limit=1)
    model_id = models["results"][0]["id"]

    created = await llm_configs.create_llm_config(
        custom_name="audit-probe-llm",
        model=model_id,
        temperature=0.2,
        max_tokens=512,
    )
    cid = created["id"]
    try:
        assert created["custom_name"] == "audit-probe-llm"

        fetched = await llm_configs.get_llm_config(cid)
        assert fetched["id"] == cid

        updated = await llm_configs.update_llm_config(cid, temperature=0.9)
        assert updated["temperature"] == 0.9
        assert updated["custom_name"] == "audit-probe-llm"  # unchanged

        listed = await llm_configs.list_llm_configs()
        assert any(c["id"] == cid for c in listed["results"])
    finally:
        msg = await llm_configs.delete_llm_config(cid)
        assert "deleted" in msg["message"]


async def test_embedding_config_crud_lifecycle():
    models = await llm_configs.list_embedding_models(limit=1)
    model_id = models["results"][0]["id"]

    created = await llm_configs.create_embedding_config(
        custom_name="audit-probe-embed", model=model_id
    )
    cid = created["id"]
    try:
        fetched = await llm_configs.get_embedding_config(cid)
        assert fetched["id"] == cid

        updated = await llm_configs.update_embedding_config(
            cid, custom_name="audit-probe-embed-2"
        )
        assert updated["custom_name"] == "audit-probe-embed-2"
    finally:
        msg = await llm_configs.delete_embedding_config(cid)
        assert "deleted" in msg["message"]
