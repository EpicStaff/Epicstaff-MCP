"""Tests for memory tools."""

from __future__ import annotations

import httpx
import respx

from epicstaff_mcp.tools.memory import delete_memory
from tests.conftest import BASE_URL


@respx.mock
async def test_delete_memory_uses_uuid_string():
    uuid = "550e8400-e29b-41d4-a716-446655440000"
    route = respx.delete(f"{BASE_URL}api/memory/{uuid}/").mock(
        return_value=httpx.Response(204)
    )
    result = await delete_memory(memory_id=uuid)
    assert route.called
    assert result == {"message": f"Memory {uuid} deleted successfully"}
