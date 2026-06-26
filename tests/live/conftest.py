"""Fixtures for the live-integration suite.

These tests hit a REAL EpicStaff backend (no respx mocking). They are opt-in:
the whole package is skipped unless ``EPICSTAFF_LIVE=1`` is set, so the default
``pytest`` run (mocked) is unaffected.

Run with::

    EPICSTAFF_LIVE=1 \
    EPICSTAFF_BASE_URL=http://localhost:8000 \
    EPICSTAFF_API_KEY=<admin-key> \
    pytest tests/live/ -v

The tool functions resolve auth/base-url from the environment via
``epicstaff_mcp.client.get_client()`` exactly as the MCP server does, so the
suite exercises the same code path real tasks hit.
"""
from __future__ import annotations

import os

import pytest

LIVE = os.environ.get("EPICSTAFF_LIVE") == "1"


def pytest_collection_modifyitems(config, items):
    """Skip every test under tests/live/ unless EPICSTAFF_LIVE=1.

    A module-level `pytestmark` in a conftest.py is ignored by pytest, so the
    opt-in gate must be applied here via the collection hook. This keeps the
    default (mocked) `pytest` run from ever touching a real backend.
    """
    if LIVE:
        return
    skip = pytest.mark.skip(reason="live backend tests are opt-in; set EPICSTAFF_LIVE=1")
    for item in items:
        if "tests/live/" in item.nodeid or "tests\\live\\" in item.nodeid:
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def reset_client():
    """Reset the module-level client singleton before/after each test."""
    import epicstaff_mcp.client as client_module

    client_module._client = None
    yield
    client_module._client = None


@pytest.fixture(scope="session")
def llm_config_id() -> int:
    """A working LLM config id (override via EPICSTAFF_TEST_LLM_CONFIG_ID)."""
    return int(os.environ.get("EPICSTAFF_TEST_LLM_CONFIG_ID", "8"))


@pytest.fixture(scope="session")
def embedding_config_id() -> int:
    """A working embedding config id (override via EPICSTAFF_TEST_EMBEDDING_CONFIG_ID)."""
    return int(os.environ.get("EPICSTAFF_TEST_EMBEDDING_CONFIG_ID", "2"))
