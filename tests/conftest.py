"""Shared pytest fixtures for epicstaff-mcp tests."""
from __future__ import annotations

import os

import pytest

# Ensure EPICSTAFF_BASE_URL is set for all tests
os.environ.setdefault("EPICSTAFF_BASE_URL", "http://test.epicstaff.local")

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
