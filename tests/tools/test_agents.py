"""Tests for agent tools."""

from __future__ import annotations

import httpx
import respx

from epicstaff_mcp.tools.agents import (
    create_agent,
    delete_agent,
    get_agent,
    list_agents,
    update_agent,
)
from tests.conftest import AGENT_PAYLOAD, BASE_URL


@respx.mock
async def test_list_agents_returns_results():
    respx.get(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(
            200,
            json={
                "count": 1,
                "next": None,
                "previous": None,
                "results": [AGENT_PAYLOAD],
            },
        )
    )
    result = await list_agents()
    assert result["count"] == 1
    assert result["results"][0]["role"] == "Researcher"


@respx.mock
async def test_list_agents_passes_pagination_params():
    route = respx.get(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    await list_agents(limit=10, offset=20)
    assert route.calls.last.request.url.params["limit"] == "10"
    assert route.calls.last.request.url.params["offset"] == "20"


@respx.mock
async def test_list_agents_passes_search_param():
    route = respx.get(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    await list_agents(search="researcher")
    assert route.calls.last.request.url.params["search"] == "researcher"


@respx.mock
async def test_get_agent_returns_agent():
    respx.get(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=AGENT_PAYLOAD)
    )
    result = await get_agent(agent_id=1)
    assert result["id"] == 1
    assert result["role"] == "Researcher"


@respx.mock
async def test_create_agent():
    respx.post(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(201, json=AGENT_PAYLOAD)
    )
    result = await create_agent(
        role="Researcher", goal="Find information", backstory="An expert researcher"
    )
    assert result["role"] == "Researcher"


@respx.mock
async def test_create_agent_sends_correct_payload():
    route = respx.post(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(201, json=AGENT_PAYLOAD)
    )
    await create_agent(
        role="Researcher",
        goal="Find information",
        backstory="Expert",
        llm_config=5,
        tool_ids=["mcp-tool:1"],
        memory=True,
    )
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["role"] == "Researcher"
    assert body["llm_config"] == 5
    assert body["tool_ids"] == ["mcp-tool:1"]
    assert body["memory"] is True
    assert "fcm_llm_config" not in body  # None fields not included


@respx.mock
async def test_update_agent():
    respx.get(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=AGENT_PAYLOAD)
    )
    updated = {**AGENT_PAYLOAD, "role": "Senior Researcher"}
    respx.patch(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=updated)
    )
    result = await update_agent(agent_id=1, role="Senior Researcher")
    assert result["role"] == "Senior Researcher"


@respx.mock
async def test_delete_agent():
    respx.delete(f"{BASE_URL}api/agents/1/").mock(return_value=httpx.Response(204))
    result = await delete_agent(agent_id=1)
    assert result == {"message": "Agent 1 deleted successfully"}


@respx.mock
async def test_create_agent_forwards_rag_object():
    route = respx.post(f"{BASE_URL}api/agents/").mock(
        return_value=httpx.Response(201, json=AGENT_PAYLOAD)
    )
    await create_agent(
        role="R",
        goal="G",
        backstory="B",
        knowledge_collection=4,
        rag_type="naive",
        rag_id=7,
    )
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["knowledge_collection"] == 4
    assert body["rag"] == {"rag_type": "naive", "rag_id": 7}


@respx.mock
async def test_update_agent_forwards_rag_object():
    respx.get(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=AGENT_PAYLOAD)
    )
    respx.patch(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=AGENT_PAYLOAD)
    )
    route = respx.patch(f"{BASE_URL}api/agents/1/")
    await update_agent(agent_id=1, knowledge_collection=4, rag_type="naive", rag_id=7)
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["rag"] == {"rag_type": "naive", "rag_id": 7}


# ---------------------------------------------------------------------------
# update_agent tool_ids merge-vs-replace semantics (Fix #2)
# ---------------------------------------------------------------------------


@respx.mock
async def test_update_agent_preserves_tools_when_tool_ids_omitted():
    """The backend's PATCH wipes tool_ids whenever the key is absent from the
    request body — update_agent must always re-send the agent's existing
    tools even when the caller never mentions tool_ids."""
    existing = {
        **AGENT_PAYLOAD,
        "tools": [
            {"unique_name": "mcp-tool:1", "data": {}},
            {"unique_name": "python-code-tool:2", "data": {}},
        ],
    }
    respx.get(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=existing)
    )
    route = respx.patch(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=existing)
    )
    await update_agent(agent_id=1, role="Senior Researcher")
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["tool_ids"] == ["mcp-tool:1", "python-code-tool:2"]


@respx.mock
async def test_update_agent_merges_tool_ids_by_default():
    existing = {
        **AGENT_PAYLOAD,
        "tools": [{"unique_name": "mcp-tool:1", "data": {}}],
    }
    respx.get(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=existing)
    )
    route = respx.patch(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=existing)
    )
    await update_agent(agent_id=1, tool_ids=["configured-tool:3"])
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["tool_ids"] == ["mcp-tool:1", "configured-tool:3"]


@respx.mock
async def test_update_agent_replace_tool_ids_drops_existing():
    existing = {
        **AGENT_PAYLOAD,
        "tools": [{"unique_name": "mcp-tool:1", "data": {}}],
    }
    respx.get(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=existing)
    )
    route = respx.patch(f"{BASE_URL}api/agents/1/").mock(
        return_value=httpx.Response(200, json=existing)
    )
    await update_agent(
        agent_id=1, tool_ids=["configured-tool:3"], replace_tool_ids=True
    )
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["tool_ids"] == ["configured-tool:3"]
