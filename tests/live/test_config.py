"""Live tests for config / defaults / env-var tools (epicstaff_mcp/tools/config.py)."""
from __future__ import annotations

import pytest

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools import config


async def test_ping():
    result = await config.ping()
    assert result["status"] == "ok"


async def test_list_providers():
    result = await config.list_providers()
    assert result["count"] >= 1
    assert any(p["name"] == "openai" for p in result["results"])


async def test_get_default_configs_bundle():
    result = await config.get_default_configs()
    assert "default_agent_config" in result
    assert "default_crew_config" in result
    assert "default_tool_config" in result


@pytest.mark.parametrize(
    "getter",
    [
        config.get_default_llm_config,
        config.get_default_agent_config,
        config.get_default_crew_config,
        config.get_default_embedding_config,
        config.get_default_tool_config,
    ],
)
async def test_default_getters(getter):
    result = await getter()
    assert isinstance(result, dict)


async def test_update_default_llm_config_merge():
    """GET-merge-PUT path: change one scalar, confirm it persists, restore it."""
    before = await config.get_default_llm_config()
    original = before.get("temperature")
    new_val = 0.33 if original != 0.33 else 0.44
    updated = await config.update_default_llm_config(temperature=new_val)
    assert updated["temperature"] == new_val
    # other fields preserved
    assert updated["max_tokens"] == before["max_tokens"]
    if original is not None:
        await config.update_default_llm_config(temperature=original)


async def test_update_default_crew_config_merge():
    before = await config.get_default_crew_config()
    original = before.get("default_temperature")
    new_val = 0.55 if original != 0.55 else 0.66
    updated = await config.update_default_crew_config(default_temperature=new_val)
    assert updated["default_temperature"] == new_val
    if original is not None:
        await config.update_default_crew_config(default_temperature=original)


async def test_update_default_agent_config_merge():
    before = await config.get_default_agent_config()
    original = before.get("max_iter")
    new_val = 21 if original != 21 else 22
    updated = await config.update_default_agent_config(max_iter=new_val)
    assert updated["max_iter"] == new_val
    if original is not None:
        await config.update_default_agent_config(max_iter=original)


async def test_env_var_error_is_legible():
    """The env-var endpoint 500s in this deployment (missing config.yaml).

    Regression guard for the client fix: the raised detail must be a compact
    summary, NOT the full ~100 KB Django debug HTML page (which leaked the
    entire settings dump into tool results).
    """
    with pytest.raises(EpicStaffAPIError) as exc_info:
        await config.list_env_vars()
    detail = exc_info.value.detail
    assert len(detail) < 2000, "error detail should be summarized, not a full HTML page"
    assert "<html" not in detail.lower()
