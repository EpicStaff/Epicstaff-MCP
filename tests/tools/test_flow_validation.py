"""Unit tests for the pure validation checks in tools/_flow_validation.py."""
from __future__ import annotations

from epicstaff_mcp.tools import _flow_validation as fv


def test_envelope_status_ok_when_no_warnings():
    env = fv.envelope({"id": 1}, "did a thing")
    assert env["status"] == "ok"
    assert env["result"] == {"id": 1}
    assert env["warnings"] == []


def test_status_of_blocker_vs_warning():
    assert fv.status_of([{"code": "empty_code"}]) == "error"
    assert fv.status_of([{"code": "dt_no_route"}]) == "warning"
    assert fv.status_of([]) == "ok"


def test_check_python_node_missing_entrypoint_is_blocker():
    warnings = fv.check_python_node(
        {"node_name": "X", "python_code": {"code": "x = 1"}}
    )
    codes = {w["code"] for w in warnings}
    assert "missing_main" in codes
    assert fv.status_of(warnings) == "error"


def test_check_python_node_respects_custom_entrypoint():
    warnings = fv.check_python_node(
        {"node_name": "X", "python_code": {"code": "def run():\n    return 1", "entrypoint": "run"}}
    )
    assert warnings == []


def test_check_python_node_empty_code():
    warnings = fv.check_python_node({"node_name": "X", "python_code": {"code": "  "}})
    assert any(w["code"] == "empty_code" for w in warnings)


def test_check_python_node_libraries_wiped():
    warnings = fv.check_python_node(
        {"node_name": "X", "python_code": {"code": "import requests\ndef main():\n    pass"}}
    )
    assert any(w["code"] == "libraries_wiped" for w in warnings)


def test_check_python_node_stdlib_import_no_warning():
    warnings = fv.check_python_node(
        {"node_name": "X", "python_code": {"code": "import json\ndef main():\n    pass"}}
    )
    assert not any(w["code"] == "libraries_wiped" for w in warnings)


def test_check_dt_groups_missing_conditions_is_blocker():
    warnings = fv.check_dt_groups([{"group_name": "g1", "next_node": "A"}], "DT")
    assert any(w["code"] == "dt_group_no_conditions" for w in warnings)
    assert fv.status_of(warnings) == "error"


def test_check_dt_groups_ok_with_conditions_and_route():
    warnings = fv.check_dt_groups(
        [{"group_name": "g1", "next_node": "A", "conditions": []}], "DT"
    )
    assert warnings == []


def test_check_cdt_prompts_list_is_blocker():
    warnings = fv.check_cdt({"node_name": "C", "prompts": ["a", "b"]})
    assert any(w["code"] == "cdt_prompts_not_dict" for w in warnings)


def test_check_ports_empty_list_warns():
    warnings = fv.check_ports({"node_name": "P", "ports": []})
    assert warnings and warnings[0]["code"] == "ports_not_null"


def test_check_node_config_dispatches_by_type():
    warnings = fv.check_node_config(
        "pythonnode", {"python_code": {"code": "x=1"}}, "PyNode"
    )
    assert any(w["code"] == "missing_main" for w in warnings)
