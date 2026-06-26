"""Shared pytest fixtures for epicstaff-mcp tests."""
from __future__ import annotations

import os

import pytest

# Force the mocked test base URL so respx always matches — but only for the
# mocked suite. Live runs (EPICSTAFF_LIVE=1, under tests/live/) must keep the
# real EPICSTAFF_BASE_URL from the environment. Using setdefault here is not
# enough: a dev shell that exports EPICSTAFF_BASE_URL=http://localhost:8000 for
# the running stack would otherwise leak into the mocked suite and break every
# respx expectation.
if os.environ.get("EPICSTAFF_LIVE") != "1":
    os.environ["EPICSTAFF_BASE_URL"] = "http://test.epicstaff.local"
    # Clear ambient auth vars (a dev shell exports these for the running stack)
    # so auth-mode/config tests start from a clean baseline and set their own.
    for _var in (
        "EPICSTAFF_API_KEY",
        "EPICSTAFF_API_TOKEN",
        "EPICSTAFF_USERNAME",
        "EPICSTAFF_PASSWORD",
    ):
        os.environ.pop(_var, None)

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
    """Reset the module-level client singleton before each test."""
    import epicstaff_mcp.client as client_module
    client_module._client = None
    yield
    client_module._client = None
