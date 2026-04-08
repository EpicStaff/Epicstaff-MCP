"""Tests for LLM and embedding configuration tools."""
from __future__ import annotations

import json

import httpx
import respx

from epicstaff_mcp.tools.llm_configs import (
    create_embedding_config,
    create_llm_config,
    delete_llm_config,
    get_llm_config,
    list_embedding_configs,
    list_llm_configs,
    update_llm_config,
)
from tests.conftest import BASE_URL

LLM_CONFIG = {
    "id": 1,
    "custom_name": "GPT-4o",
    "model": 5,
    "temperature": 0.7,
    "max_tokens": 4096,
    "is_visible": True,
    "top_p": None,
    "presence_penalty": None,
    "frequency_penalty": None,
    "seed": None,
    "api_key": None,
    "timeout": None,
    "headers": {},
    "extra_headers": {},
}


@respx.mock
async def test_list_llm_configs():
    respx.get(f"{BASE_URL}api/llm-configs/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [LLM_CONFIG]})
    )
    result = await list_llm_configs()
    assert result["count"] == 1


@respx.mock
async def test_get_llm_config():
    respx.get(f"{BASE_URL}api/llm-configs/1/").mock(
        return_value=httpx.Response(200, json=LLM_CONFIG)
    )
    result = await get_llm_config(config_id=1)
    assert result["custom_name"] == "GPT-4o"


@respx.mock
async def test_create_llm_config():
    respx.post(f"{BASE_URL}api/llm-configs/").mock(
        return_value=httpx.Response(201, json=LLM_CONFIG)
    )
    result = await create_llm_config(custom_name="GPT-4o", model=5, temperature=0.7)
    assert result["custom_name"] == "GPT-4o"


@respx.mock
async def test_create_llm_config_excludes_none():
    route = respx.post(f"{BASE_URL}api/llm-configs/").mock(
        return_value=httpx.Response(201, json=LLM_CONFIG)
    )
    await create_llm_config(custom_name="GPT-4o")
    body = json.loads(route.calls.last.request.content)
    assert "model" not in body
    assert "temperature" not in body
    assert body["custom_name"] == "GPT-4o"


@respx.mock
async def test_update_llm_config():
    respx.patch(f"{BASE_URL}api/llm-configs/1/").mock(
        return_value=httpx.Response(200, json={**LLM_CONFIG, "temperature": 0.5})
    )
    result = await update_llm_config(config_id=1, temperature=0.5)
    assert result["temperature"] == 0.5


@respx.mock
async def test_delete_llm_config():
    respx.delete(f"{BASE_URL}api/llm-configs/1/").mock(return_value=httpx.Response(204))
    result = await delete_llm_config(config_id=1)
    assert "deleted" in result["message"]


@respx.mock
async def test_list_embedding_configs():
    respx.get(f"{BASE_URL}api/embedding-configs/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    result = await list_embedding_configs()
    assert result["count"] == 0


@respx.mock
async def test_create_embedding_config():
    respx.post(f"{BASE_URL}api/embedding-configs/").mock(
        return_value=httpx.Response(201, json={"id": 1, "custom_name": "text-embedding-3-small"})
    )
    result = await create_embedding_config(custom_name="text-embedding-3-small")
    assert result["id"] == 1
