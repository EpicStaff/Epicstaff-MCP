"""Tests for epicstaff_mcp.error_remediation — known backend error signatures."""

from __future__ import annotations

from epicstaff_mcp.error_remediation import find_remediation


def test_no_start_node_matches():
    remediation = find_remediation(400, "No node connected to start node")
    assert remediation is not None
    assert "__start__" in remediation


def test_rag_required_on_agent_update_matches():
    detail = "{'rag': ['This field is required when changing to a new knowledge_collection']}"
    remediation = find_remediation(400, detail)
    assert remediation is not None
    assert "rag_type" in remediation and "rag_id" in remediation


def test_unhandled_typeerror_matches():
    detail = "TypeError: Unpredictable error"
    remediation = find_remediation(500, detail)
    assert remediation is not None
    assert "condition_group" in remediation


def test_unrelated_error_is_not_matched():
    remediation = find_remediation(400, "This field may not be blank.")
    assert remediation is None


def test_wrong_status_code_does_not_match():
    # Same text, wrong status — must not fire (over-matching guard).
    remediation = find_remediation(500, "No node connected to start node")
    assert remediation is None
