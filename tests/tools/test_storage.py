"""Tests for storage tools."""

from __future__ import annotations

import base64
import json

import httpx
import respx

from epicstaff_mcp.tools.storage import (
    attach_storage_to_flow,
    create_storage_folder,
    delete_storage_paths,
    list_flow_storage,
    list_storage,
    upload_storage_file,
)
from tests.conftest import BASE_URL


@respx.mock
async def test_create_storage_folder_posts_path():
    route = respx.post(f"{BASE_URL}api/storage/mkdir/").mock(
        return_value=httpx.Response(201, json={"path": "chat_memory/", "created": True})
    )
    await create_storage_folder("chat_memory/")
    assert json.loads(route.calls.last.request.content) == {"path": "chat_memory/"}


@respx.mock
async def test_attach_storage_to_flow_body():
    route = respx.post(f"{BASE_URL}api/storage/add-to-graph/").mock(
        return_value=httpx.Response(201, json=[])
    )
    await attach_storage_to_flow(flow_id=9, paths=["chat_memory/"])
    assert json.loads(route.calls.last.request.content) == {
        "paths": ["chat_memory/"],
        "graph_ids": [9],
    }


@respx.mock
async def test_detach_and_delete_use_delete_body():
    route = respx.delete(f"{BASE_URL}api/storage/delete/").mock(
        return_value=httpx.Response(204)
    )
    await delete_storage_paths(["chat_memory/tg-1.json"])
    assert json.loads(route.calls.last.request.content) == {
        "paths": ["chat_memory/tg-1.json"]
    }


@respx.mock
async def test_list_storage_passes_path_param():
    route = respx.get(f"{BASE_URL}api/storage/list/").mock(
        return_value=httpx.Response(200, json={"path": "chat_memory/", "items": []})
    )
    await list_storage("chat_memory/")
    assert route.calls.last.request.url.params["path"] == "chat_memory/"


@respx.mock
async def test_list_flow_storage_passes_graph_id():
    route = respx.get(f"{BASE_URL}api/storage/graph-files/").mock(
        return_value=httpx.Response(200, json=[])
    )
    await list_flow_storage(9)
    assert route.calls.last.request.url.params["graph_id"] == "9"


@respx.mock
async def test_upload_storage_file_sends_multipart():
    route = respx.post(f"{BASE_URL}api/storage/upload/").mock(
        return_value=httpx.Response(201, json={"uploaded": []})
    )
    await upload_storage_file(
        "chat_memory/", "note.txt", base64.b64encode(b"hello").decode()
    )
    req = route.calls.last.request
    assert b"multipart/form-data" in req.headers["content-type"].encode()
    assert b"note.txt" in req.content
