"""Tests for crew tools."""
from __future__ import annotations

import json

import httpx
import respx

from epicstaff_mcp.tools.crews import create_crew, get_crew, list_crews
from tests.conftest import BASE_URL

CREW_PAYLOAD = {
    "id": 1,
    "name": "Research Team",
    "description": None,
    "agents": [1, 2],
    "process": "sequential",
    "memory": False,
    "full_output": False,
    "planning": False,
    "memory_llm_config": None,
    "embedding_config": None,
    "manager_llm_config": None,
    "planning_llm_config": None,
    "max_rpm": None,
    "cache": None,
    "default_temperature": None,
}


@respx.mock
async def test_list_crews():
    respx.get(f"{BASE_URL}api/crews/").mock(
        return_value=httpx.Response(200, json={"count": 1, "results": [CREW_PAYLOAD]})
    )
    result = await list_crews()
    assert result["count"] == 1
    assert result["results"][0]["name"] == "Research Team"


@respx.mock
async def test_get_crew():
    respx.get(f"{BASE_URL}api/crews/1/").mock(
        return_value=httpx.Response(200, json=CREW_PAYLOAD)
    )
    result = await get_crew(crew_id=1)
    assert result["name"] == "Research Team"
    assert result["agents"] == [1, 2]


@respx.mock
async def test_create_crew():
    respx.post(f"{BASE_URL}api/crews/").mock(
        return_value=httpx.Response(201, json=CREW_PAYLOAD)
    )
    result = await create_crew(name="Research Team", agents=[1, 2])
    assert result["id"] == 1


@respx.mock
async def test_create_crew_payload():
    route = respx.post(f"{BASE_URL}api/crews/").mock(
        return_value=httpx.Response(201, json=CREW_PAYLOAD)
    )
    await create_crew(name="Research Team", agents=[1, 2], process="hierarchical", memory=True)
    body = json.loads(route.calls.last.request.content)
    assert body["name"] == "Research Team"
    assert body["process"] == "hierarchical"
    assert body["memory"] is True
    assert "description" not in body  # None not included
