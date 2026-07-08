"""Shared pytest fixtures for epicstaff-mcp tests."""

from __future__ import annotations

import os

import pytest

# Isolate tests from the developer's real shell env: force the test base URL and
# strip any auth vars so the client runs in no-auth mode (no real /auth/login/ calls).
os.environ["EPICSTAFF_BASE_URL"] = "http://test.epicstaff.local"
for _auth_var in ("EPICSTAFF_API_TOKEN", "EPICSTAFF_USERNAME", "EPICSTAFF_PASSWORD"):
    os.environ.pop(_auth_var, None)

BASE_URL = "http://test.epicstaff.local/"

AGENT_PAYLOAD: dict = {
    "id": 1,
    "role": "Researcher",
    "goal": "Find information",
    "backstory": "An expert researcher",
    "tools": [],
    "llm_config": None,
    "fcm_llm_config": None,
    "knowledge_collection": None,
    "memory": False,
    "allow_delegation": False,
    "cache": True,
    "allow_code_execution": False,
    "max_retry_limit": 2,
    "respect_context_window": True,
    "default_temperature": None,
    "max_iter": None,
    "max_rpm": None,
    "max_execution_time": None,
}


@pytest.fixture(autouse=True)
def reset_client():
    """Reset the module-level client singleton and active-org state before each test."""
    import epicstaff_mcp.client as client_module
    from epicstaff_mcp.config import get_settings

    def _reset() -> None:
        get_settings.cache_clear()
        client_module._client = None
        client_module._active_org_id = None
        client_module._override_set = False
        client_module._resolved_default_org_id = None
        client_module._default_resolved = False

    _reset()
    yield
    _reset()
