"""MCP tools for the general file-storage subsystem (MinIO/S3-backed).

Covers browsing, folder/file management, and attaching storage paths to a flow.
Attaching a path to a flow is what grants that flow's Python nodes (use_storage=true)
read/write access to it across sessions — a node's allowed paths are the flow's
attached storage paths plus its own session folder.

All operations target `/api/storage/<action>/`. Paths are org-relative (e.g.
"chat_memory/", "reports/q3.csv"); folders are addressed with a trailing slash.
"""

from __future__ import annotations

import base64
from typing import Any

from epicstaff_mcp.client import get_client


async def list_storage(path: str = "") -> dict[str, Any]:
    """List files and folders at a storage path (root when path is empty)."""
    async with get_client() as client:
        return await client.get("/api/storage/list/", params={"path": path})


async def storage_tree(path: str = "", max_depth: int | None = None) -> dict[str, Any]:
    """Get the folder tree under a storage path (optionally depth-limited)."""
    params: dict[str, Any] = {"path": path}
    if max_depth is not None:
        params["max_depth"] = max_depth
    async with get_client() as client:
        return await client.get("/api/storage/tree/", params=params)


async def get_storage_info(path: str) -> dict[str, Any]:
    """Get metadata for one storage file/folder, plus which flows it's attached to."""
    async with get_client() as client:
        return await client.get("/api/storage/info/", params={"path": path})


async def create_storage_folder(path: str) -> dict[str, Any]:
    """Create a storage folder (e.g. "chat_memory/"). 409 if it already exists."""
    async with get_client() as client:
        return await client.post("/api/storage/mkdir/", json={"path": path})


async def upload_storage_file(
    folder_path: str, filename: str, content_base64: str
) -> dict[str, Any]:
    """Upload a file into a storage folder. Provide file content as base64.

    folder_path: destination folder (e.g. "chat_memory/"); filename: name to store as.
    """
    file_bytes = base64.b64decode(content_base64)
    async with get_client() as client:
        return await client.post_multipart(
            "/api/storage/upload/",
            files=[("files", (filename, file_bytes))],
            data={"path": folder_path},
        )


async def delete_storage_paths(paths: list[str]) -> dict[str, Any]:
    """Delete one or more storage files/folders by path."""
    async with get_client() as client:
        return await client.delete("/api/storage/delete/", json={"paths": paths})


async def rename_storage(from_path: str, to_path: str) -> dict[str, Any]:
    """Rename a storage file/folder."""
    async with get_client() as client:
        return await client.post(
            "/api/storage/rename/", json={"from": from_path, "to": to_path}
        )


async def move_storage(from_path: str, to_path: str) -> dict[str, Any]:
    """Move a storage file/folder to a new path."""
    async with get_client() as client:
        return await client.post(
            "/api/storage/move/", json={"from": from_path, "to": to_path}
        )


async def copy_storage(from_path: str, to_path: str) -> dict[str, Any]:
    """Copy a storage file/folder to a new path."""
    async with get_client() as client:
        return await client.post(
            "/api/storage/copy/", json={"from": from_path, "to": to_path}
        )


async def attach_storage_to_flow(flow_id: int, paths: list[str]) -> dict[str, Any]:
    """Attach storage path(s) to a flow so its Python nodes (use_storage=true) can
    read/write them across sessions.

    A folder path grants access to everything under it; a folder is stored with a
    trailing slash automatically. The path(s) must already exist (create_storage_folder
    / upload_storage_file first).
    """
    async with get_client() as client:
        return await client.post(
            "/api/storage/add-to-graph/",
            json={"paths": paths, "graph_ids": [flow_id]},
        )


async def detach_storage_from_flow(flow_id: int, paths: list[str]) -> dict[str, Any]:
    """Remove storage path(s) from a flow (revokes its nodes' access)."""
    async with get_client() as client:
        return await client.delete(
            "/api/storage/remove-from-graph/",
            json={"paths": paths, "graph_ids": [flow_id]},
        )


async def list_flow_storage(flow_id: int) -> dict[str, Any]:
    """List the storage files/folders currently attached to a flow."""
    async with get_client() as client:
        return await client.get(
            "/api/storage/graph-files/", params={"graph_id": flow_id}
        )
