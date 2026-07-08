"""Tests for surface tools."""

from __future__ import annotations

import json

import httpx
import respx

from epicstaff_mcp.tools.surfaces import (
    combine_surfaces,
    create_surface,
    delete_surface,
    get_surface,
    list_surfaces,
    update_surface,
)
from tests.conftest import BASE_URL

SURFACE_PAYLOAD: dict = {
    "id": 1,
    "name": "Research Bundle",
    "instructions": None,
    "python_tools": [],
    "mcp_tools": [],
    "storage_items": [],
    "knowledge": [],
    "owner_agent": None,
}


@respx.mock
async def test_list_surfaces_returns_results():
    respx.get(f"{BASE_URL}api/surfaces/").mock(
        return_value=httpx.Response(
            200,
            json={
                "count": 1,
                "next": None,
                "previous": None,
                "results": [SURFACE_PAYLOAD],
            },
        )
    )
    result = await list_surfaces()
    assert result["count"] == 1
    assert result["results"][0]["name"] == "Research Bundle"


@respx.mock
async def test_list_surfaces_passes_pagination_params():
    route = respx.get(f"{BASE_URL}api/surfaces/").mock(
        return_value=httpx.Response(200, json={"count": 0, "results": []})
    )
    await list_surfaces(limit=10, offset=20)
    assert route.calls.last.request.url.params["limit"] == "10"
    assert route.calls.last.request.url.params["offset"] == "20"


@respx.mock
async def test_get_surface_returns_surface():
    respx.get(f"{BASE_URL}api/surfaces/1/").mock(
        return_value=httpx.Response(200, json=SURFACE_PAYLOAD)
    )
    result = await get_surface(surface_id=1)
    assert result["id"] == 1
    assert result["name"] == "Research Bundle"


@respx.mock
async def test_create_surface_sends_correct_payload():
    route = respx.post(f"{BASE_URL}api/surfaces/").mock(
        return_value=httpx.Response(201, json=SURFACE_PAYLOAD)
    )
    await create_surface(
        name="Research Bundle",
        python_tools=[{"python_tool": 2, "mode": "allow"}],
        owner_agent=7,
    )
    body = json.loads(route.calls.last.request.content)
    assert body["name"] == "Research Bundle"
    assert body["python_tools"] == [{"python_tool": 2, "mode": "allow"}]
    assert body["owner_agent"] == 7
    assert "instructions" not in body  # None fields not included


@respx.mock
async def test_update_surface():
    updated = {**SURFACE_PAYLOAD, "name": "Updated Bundle"}
    route = respx.patch(f"{BASE_URL}api/surfaces/1/").mock(
        return_value=httpx.Response(200, json=updated)
    )
    result = await update_surface(surface_id=1, name="Updated Bundle")
    assert result["name"] == "Updated Bundle"
    body = json.loads(route.calls.last.request.content)
    assert body == {"name": "Updated Bundle"}


@respx.mock
async def test_delete_surface():
    respx.delete(f"{BASE_URL}api/surfaces/1/").mock(return_value=httpx.Response(204))
    result = await delete_surface(surface_id=1)
    assert result == {"message": "Surface 1 deleted successfully"}


@respx.mock
async def test_combine_surfaces_sends_ids():
    route = respx.post(f"{BASE_URL}api/surfaces/combine/").mock(
        return_value=httpx.Response(200, json={"id": 99, "name": "Combined"})
    )
    result = await combine_surfaces(surface_ids=[1, 2, 3])
    assert result["id"] == 99
    body = json.loads(route.calls.last.request.content)
    assert body == {"surface_ids": [1, 2, 3]}
