"""Tests for agent definition tools."""

from __future__ import annotations

import json

import httpx
import respx

from epicstaff_mcp.tools.agent_definitions import (
    create_agent_definition,
    delete_agent_definition,
    get_agent_definition,
    list_agent_definitions,
    update_agent_definition,
)
from tests.conftest import BASE_URL

AGENT_DEFINITION_PAYLOAD: dict = {
    "id": 1,
    "name": "Researcher",
    "description": "Finds information",
    "instructions": None,
    "llm_config": None,
    "default_surfaces": [],
}


@respx.mock
async def test_list_agent_definitions_returns_results():
    respx.get(f"{BASE_URL}api/agent-definitions/").mock(
        return_value=httpx.Response(
            200,
            json={
                "count": 1,
                "next": None,
                "previous": None,
                "results": [AGENT_DEFINITION_PAYLOAD],
            },
        )
    )
    result = await list_agent_definitions()
    assert result["count"] == 1
    assert result["results"][0]["name"] == "Researcher"


@respx.mock
async def test_list_agent_definitions_passes_pagination_params():
    route = respx.get(f"{BASE_URL}api/agent-definitions/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    await list_agent_definitions(limit=10, offset=20)
    assert route.calls.last.request.url.params["limit"] == "10"
    assert route.calls.last.request.url.params["offset"] == "20"


@respx.mock
async def test_get_agent_definition_returns_definition():
    respx.get(f"{BASE_URL}api/agent-definitions/1/").mock(
        return_value=httpx.Response(200, json=AGENT_DEFINITION_PAYLOAD)
    )
    result = await get_agent_definition(agent_definition_id=1)
    assert result["id"] == 1
    assert result["name"] == "Researcher"


@respx.mock
async def test_create_agent_definition_sends_correct_payload():
    route = respx.post(f"{BASE_URL}api/agent-definitions/").mock(
        return_value=httpx.Response(201, json=AGENT_DEFINITION_PAYLOAD)
    )
    await create_agent_definition(
        name="Researcher",
        instructions="Do research",
        llm_config=5,
        default_surfaces=[{"surface": 3, "place": "all"}],
    )
    body = json.loads(route.calls.last.request.content)
    assert body["name"] == "Researcher"
    assert body["instructions"] == "Do research"
    assert body["llm_config"] == 5
    assert body["default_surfaces"] == [{"surface": 3, "place": "all"}]
    assert "description" not in body  # None fields not included


@respx.mock
async def test_update_agent_definition():
    updated = {**AGENT_DEFINITION_PAYLOAD, "name": "Senior Researcher"}
    route = respx.patch(f"{BASE_URL}api/agent-definitions/1/").mock(
        return_value=httpx.Response(200, json=updated)
    )
    result = await update_agent_definition(
        agent_definition_id=1, name="Senior Researcher"
    )
    assert result["name"] == "Senior Researcher"
    body = json.loads(route.calls.last.request.content)
    assert body == {"name": "Senior Researcher"}


@respx.mock
async def test_delete_agent_definition():
    respx.delete(f"{BASE_URL}api/agent-definitions/1/").mock(
        return_value=httpx.Response(204)
    )
    result = await delete_agent_definition(agent_definition_id=1)
    assert result == {"message": "Agent definition 1 deleted successfully"}
