"""Tests for validate_flow — deep, read-only structural validation of a flow."""

from __future__ import annotations

import httpx
import respx

from epicstaff_mcp.tools.flows import _validate_graph, validate_flow
from tests.conftest import BASE_URL


def _codes(findings: list[dict], code: str) -> list[dict]:
    return [f for f in findings if f["code"] == code]


def _branching_graph(
    *, writer_code: str, expression: str, start_variables: dict | None = None
) -> dict:
    """A start -> python(Classify) -> CDT(Router) -> end graph, parameterized on
    the python writer body and the CDT group expression, for shape/dry-run tests.

    Classify writes to `variables.route`; the CDT group reads it via `expression`.
    """
    return {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": start_variables or {"input": {"text": ""}, "route": ""},
            }
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end_node__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Classify",
                "metadata": {"position": {}},
                "input_map": {"text": "variables.input.text"},
                "output_variable_path": "variables.route",
                "python_code": {"code": writer_code, "libraries": []},
            }
        ],
        "classification_decision_table_node_list": [
            {
                "id": 4,
                "node_name": "Router",
                "metadata": {"position": {}},
                "condition_groups": [
                    {
                        "group_name": "match",
                        "expression": expression,
                        "next_node_id": 2,
                        "route_code": "match",
                    }
                ],
                "default_next_node_id": 2,
                "next_error_node_id": 2,
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 4},
        ],
    }


_SCALAR_WRITER = "def main(text):\n    return 'urgent' if 'urgent' in text else 'normal'\n"
_DICT_WRITER = "def main(text):\n    return {'route': 'urgent' if 'urgent' in text else 'normal'}\n"

BASE_GRAPH: dict = {
    "id": 1,
    "name": "My Flow",
    "metadata": {},
    "crew_node_list": [],
    "python_node_list": [],
    "start_node_list": [],
    "end_node_list": [],
    "subgraph_node_list": [],
    "code_agent_node_list": [],
    "file_extractor_node_list": [],
    "audio_transcription_node_list": [],
    "decision_table_node_list": [],
    "classification_decision_table_node_list": [],
    "telegram_trigger_node_list": [],
    "webhook_trigger_node_list": [],
    "edge_list": [],
    "conditional_edge_list": [],
}


def _finding_codes(result: dict, code: str) -> list[dict]:
    return [f for f in result["findings"] if f["code"] == code]


@respx.mock
async def test_validate_flow_python_node_missing_def_main():
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {}},
                "output_map": {},
            }
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Broken",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": None,
                "python_code": {"code": "result = 1 + 1", "libraries": []},
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert result["ok"] is False
    missing = _finding_codes(result, "missing_entrypoint")
    assert len(missing) == 1
    assert missing[0]["node"] == "Broken"
    assert missing[0]["severity"] == "error"


@respx.mock
async def test_validate_flow_unwritten_input_map_path():
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {"request": {"message": None}},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {}},
                "output_map": {},
            }
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Fetch Weather",
                "metadata": {"position": {}},
                "input_map": {"city": "variables.request.city"},
                "output_variable_path": "variables.weather",
                "python_code": {
                    "code": "def main(city):\n    return {}",
                    "libraries": [],
                },
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert result["ok"] is False
    unwritten = _finding_codes(result, "unwritten_input_path")
    assert len(unwritten) == 1
    assert unwritten[0]["node"] == "Fetch Weather"
    assert "variables.request.city" in unwritten[0]["message"]
    assert unwritten[0]["severity"] == "error"


@respx.mock
async def test_validate_flow_cdt_routes_by_name_instead_of_id():
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {}},
                "output_map": {},
            }
        ],
        "classification_decision_table_node_list": [
            {
                "id": 3,
                "node_name": "Router",
                "metadata": {"position": {}},
                "condition_groups": [
                    {
                        "group_name": "g1",
                        "next_node": "__end__ #2",
                        "next_node_id": None,
                    }
                ],
                "default_next_node_id": 2,
                "next_error_node_id": 2,
            }
        ],
        "edge_list": [{"id": 10, "start_node_id": 1, "end_node_id": 3}],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert result["ok"] is False
    by_name = _finding_codes(result, "cdt_route_by_name")
    assert len(by_name) == 1
    assert by_name[0]["node"] == "Router"
    assert by_name[0]["severity"] == "error"


@respx.mock
async def test_validate_flow_flags_cdt_subscript_expression():
    # Regression: subscripting `variables` in a CDT expression raises at runtime
    # (SimpleNamespace) and dead-ends the branch. validate_flow must flag it.
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {"position": {}}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "classification_decision_table_node_list": [
            {
                "id": 3,
                "node_name": "Router",
                "metadata": {"position": {}},
                "condition_groups": [
                    {
                        "group_name": "g1",
                        "expression": "variables['route'] == 'x'",
                        "next_node_id": 2,
                        "route_code": "g1",
                    }
                ],
                "default_next_node_id": 2,
                "next_error_node_id": 2,
            }
        ],
        "edge_list": [{"id": 10, "start_node_id": 1, "end_node_id": 3}],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert result["ok"] is False
    subscript = _finding_codes(result, "cdt_expression_subscript")
    assert len(subscript) == 1
    assert subscript[0]["node"] == "Router"
    assert subscript[0]["severity"] == "error"


@respx.mock
async def test_validate_flow_warns_missing_route_code():
    # Regression: a CDT group with no route_code routes at runtime but draws no
    # connector on the canvas ("invisible branch") — validate_flow warns.
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {"position": {}}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "classification_decision_table_node_list": [
            {
                "id": 3,
                "node_name": "Router",
                "metadata": {"position": {}},
                "condition_groups": [
                    {
                        "group_name": "g1",
                        "expression": "variables.route == 'x'",
                        "next_node_id": 2,
                        "route_code": None,
                    }
                ],
                "default_next_node_id": 2,
                "next_error_node_id": 2,
            }
        ],
        "edge_list": [{"id": 10, "start_node_id": 1, "end_node_id": 3}],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    missing = _finding_codes(result, "cdt_missing_route_code")
    assert len(missing) == 1
    assert missing[0]["node"] == "Router"
    assert missing[0]["severity"] == "warning"


@respx.mock
async def test_validate_flow_ports_empty_list_flagged():
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {}},
                "output_map": {},
            }
        ],
        "crew_node_list": [
            {
                "id": 3,
                "node_name": "ResearchCrew",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": None,
                "ports": [],
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    ports_findings = _finding_codes(result, "ports_empty_list")
    assert len(ports_findings) == 1
    assert ports_findings[0]["node"] == "ResearchCrew"
    assert ports_findings[0]["severity"] == "warning"
    # A cosmetic ports bug alone must not fail the flow.
    assert result["ok"] is True


@respx.mock
async def test_validate_flow_disconnected_non_trigger_node():
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {}},
                "output_map": {},
            }
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Orphan",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": None,
                "python_code": {"code": "def main():\n    return {}", "libraries": []},
            }
        ],
        "edge_list": [{"id": 10, "start_node_id": 1, "end_node_id": 2}],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert result["ok"] is False
    disconnected = _finding_codes(result, "disconnected_node")
    assert len(disconnected) == 1
    assert disconnected[0]["node"] == "Orphan"
    assert disconnected[0]["severity"] == "error"


@respx.mock
async def test_validate_flow_exempts_cdt_and_schedule_trigger_from_disconnection():
    """CDT nodes (metadata-routed) and schedule triggers (self-starting) are not edges."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {}},
                "output_map": {},
            }
        ],
        "classification_decision_table_node_list": [
            {
                "id": 3,
                "node_name": "Router",
                "metadata": {"position": {}},
                "condition_groups": [
                    {"group_name": "g1", "next_node_id": 2, "next_node": "__end__ #2"}
                ],
                "default_next_node_id": 2,
                "next_error_node_id": 2,
            }
        ],
        "schedule_trigger_node_list": [
            {"id": 4, "node_name": "Daily Digest", "metadata": {"position": {}}}
        ],
        "edge_list": [{"id": 10, "start_node_id": 1, "end_node_id": 3}],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert _finding_codes(result, "disconnected_node") == []


@respx.mock
async def test_validate_flow_known_good_flow_passes():
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {"x": 0, "y": 0}},
                "variables": {"request": {"city": "Kyiv"}},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {"x": 400, "y": 0}},
                "output_map": {"weather": "variables.weather"},
            }
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Fetch Weather",
                "metadata": {"position": {"x": 200, "y": 0}},
                "input_map": {"city": "variables.request.city"},
                "output_variable_path": "variables.weather",
                "python_code": {
                    "code": "import json\n\n\ndef main(city):\n    return {'city': city}",
                    "libraries": [],
                },
                "ports": None,
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    error_findings = [f for f in result["findings"] if f["severity"] == "error"]
    assert error_findings == []
    assert result["ok"] is True


@respx.mock
async def test_validate_flow_missing_start_and_end_nodes():
    graph = {**BASE_GRAPH}
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert result["ok"] is False
    assert len(_finding_codes(result, "missing_start_node")) == 1
    assert len(_finding_codes(result, "missing_end_node")) == 1


@respx.mock
async def test_validate_flow_missing_library_is_a_warning_not_a_blocker():
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {},
            }
        ],
        "end_node_list": [
            {
                "id": 2,
                "node_name": "__end__",
                "metadata": {"position": {}},
                "output_map": {},
            }
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Caller",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": None,
                "python_code": {
                    "code": "import requests\n\n\ndef main():\n    return requests.get('x')",
                    "libraries": [],
                },
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    missing_lib = _finding_codes(result, "missing_library")
    assert len(missing_lib) == 1
    assert missing_lib[0]["severity"] == "warning"
    assert "requests" in missing_lib[0]["message"]


@respx.mock
async def test_validate_flow_sandbox_native_import_is_not_flagged():
    """epicstaff_storage is a sandbox-provided SDK, not an installable library."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {"position": {}}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Save Context",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": None,
                "python_code": {
                    "code": (
                        "from epicstaff_storage.storage import EpicStaffStorage\n"
                        "import requests\n\n\n"
                        "def main():\n"
                        "    return {}"
                    ),
                    "libraries": [],
                },
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    missing_lib = _finding_codes(result, "missing_library")
    assert len(missing_lib) == 1
    assert "epicstaff_storage" not in missing_lib[0]["message"]
    assert "requests" in missing_lib[0]["message"]


@respx.mock
async def test_validate_flow_root_writer_known_key_reads_are_satisfied():
    """A bare `output_variable_path: "variables"` writer's *literal* dict keys
    are proven statically: exact/nested-literal reads resolve cleanly, but a
    read past a key whose value isn't a literal dict (shape unknown) is
    downgraded to a warning instead of asserted broken.
    """
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {"position": {}}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Session Init",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": "variables",
                "python_code": {
                    "code": (
                        "def main():\n"
                        "    mem = {}\n"
                        "    return {'session': {'user_key': 'u1'}, 'memory': mem}"
                    ),
                    "entrypoint": "main",
                    "libraries": [],
                },
            },
            {
                "id": 4,
                "node_name": "Reader",
                "metadata": {"position": {}},
                "input_map": {
                    "user_key": "variables.session.user_key",
                    "memory": "variables.memory",
                    "turns": "variables.memory.turns",
                },
                "output_variable_path": "variables.processed",
                "python_code": {
                    "code": "def main(user_key=None, memory=None, turns=None):\n    return {}",
                    "entrypoint": "main",
                    "libraries": [],
                },
            },
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 4},
            {"id": 12, "start_node_id": 4, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert _finding_codes(result, "unwritten_input_path") == []
    unverifiable = _finding_codes(result, "unverifiable_input_path")
    assert len(unverifiable) == 1
    assert unverifiable[0]["node"] == "Reader"
    assert unverifiable[0]["severity"] == "warning"
    assert "variables.memory.turns" in unverifiable[0]["message"]
    assert result["ok"] is True


@respx.mock
async def test_validate_flow_platform_injected_namespaces_are_satisfied():
    """telegram/file-extractor/audio-transcription nodes guarantee their
    namespaces structurally — reading them isn't an undeclared-path bug."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {"position": {}}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "telegram_trigger_node_list": [
            {"id": 5, "node_name": "Telegram Intake", "metadata": {"position": {}}}
        ],
        "file_extractor_node_list": [
            {
                "id": 6,
                "node_name": "Doc Extractor",
                "metadata": {"position": {}},
                "input_map": {"document": "variables.files.document"},
                "output_variable_path": "variables.enrichment",
            }
        ],
        "audio_transcription_node_list": [
            {
                "id": 7,
                "node_name": "Voice Intake",
                "metadata": {"position": {}},
                "input_map": {"audio": "variables.files.audio"},
                "output_variable_path": "variables.enrichment2",
            }
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Session Init",
                "metadata": {"position": {}},
                "input_map": {"tg": "variables.telegram_payload"},
                "output_variable_path": "variables.session",
                "python_code": {
                    "code": "def main(tg=None):\n    return {}",
                    "entrypoint": "main",
                    "libraries": [],
                },
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 6},
            {"id": 11, "start_node_id": 6, "end_node_id": 7},
            {"id": 12, "start_node_id": 7, "end_node_id": 3},
            {"id": 13, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert _finding_codes(result, "unwritten_input_path") == []
    assert result["ok"] is True


@respx.mock
async def test_validate_flow_duplicate_writer_on_exclusive_cdt_branches_not_flagged():
    """Two nodes writing the same path from different CDT branches (exactly
    one fires per run) is a normal convergence pattern, not a bug."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {"position": {}}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "classification_decision_table_node_list": [
            {
                "id": 10,
                "node_name": "Router",
                "metadata": {"position": {}},
                "condition_groups": [
                    {"group_name": "g1", "next_node_id": 20, "next_node": "Writer A #20"}
                ],
                "default_next_node_id": 21,
                "next_error_node_id": None,
            }
        ],
        "python_node_list": [
            {
                "id": 20,
                "node_name": "Writer A",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": "variables.result",
                "python_code": {"code": "def main():\n    return {}", "libraries": []},
            },
            {
                "id": 21,
                "node_name": "Writer B",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": "variables.result",
                "python_code": {"code": "def main():\n    return {}", "libraries": []},
            },
        ],
        "edge_list": [
            {"id": 30, "start_node_id": 1, "end_node_id": 10},
            {"id": 31, "start_node_id": 20, "end_node_id": 2},
            {"id": 32, "start_node_id": 21, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert _finding_codes(result, "duplicate_output_writer") == []


@respx.mock
async def test_validate_flow_duplicate_writer_sequential_still_flagged():
    """Two nodes writing the same path in a straight sequential chain (no
    CDT/DT branching separates them) is still a real override-last-wins bug."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {"position": {}}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Doc Extractor",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": "variables.enrichment",
                "python_code": {"code": "def main():\n    return {}", "libraries": []},
            },
            {
                "id": 4,
                "node_name": "Voice Intake",
                "metadata": {"position": {}},
                "input_map": {},
                "output_variable_path": "variables.enrichment",
                "python_code": {"code": "def main():\n    return {}", "libraries": []},
            },
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 4},
            {"id": 12, "start_node_id": 4, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    duplicates = _finding_codes(result, "duplicate_output_writer")
    assert len(duplicates) == 1
    assert "Doc Extractor" in duplicates[0]["message"]
    assert "Voice Intake" in duplicates[0]["message"]


@respx.mock
async def test_validate_flow_synthetic_start_end_nodes_exempt_from_stale_metadata():
    """__start__/__end_node__ are auto-created and never canvas-positioned —
    an empty metadata dict there is normal, not a stale-metadata symptom."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [{"id": 1, "node_name": "__start__", "metadata": {}, "variables": {}}],
        "end_node_list": [
            {"id": 2, "node_name": "__end_node__", "metadata": {}, "output_map": {}}
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Fetch Weather",
                "metadata": {"position": {"x": 0, "y": 0}},
                "input_map": {},
                "output_variable_path": None,
                "python_code": {"code": "def main():\n    return {}", "libraries": []},
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    assert _finding_codes(result, "stale_metadata") == []


@respx.mock
async def test_validate_flow_real_node_without_position_still_flagged():
    """A user-placed node (not the synthetic start/end) missing metadata is
    still a genuine "black dot" bug after the synthetic-node exemption."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {"id": 1, "node_name": "__start__", "metadata": {}, "variables": {}}
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end_node__", "metadata": {}, "output_map": {}}
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Fetch Weather",
                "metadata": {},
                "input_map": {},
                "output_variable_path": None,
                "python_code": {"code": "def main():\n    return {}", "libraries": []},
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    respx.get(f"{BASE_URL}api/graphs/1/").mock(
        return_value=httpx.Response(200, json=graph)
    )

    result = await validate_flow(graph_id=1)

    stale = _finding_codes(result, "stale_metadata")
    assert len(stale) == 1
    assert stale[0]["node"] == "Fetch Weather"
    assert stale[0]["severity"] == "warning"
    assert result["ok"] is True


# ---------------------------------------------------------------------------
# Fix #1 — python return-shape <-> CDT expression mismatch
# ---------------------------------------------------------------------------


def test_dict_writer_vs_scalar_compare_is_flagged():
    # The silent-misroute trap: Classify returns {'route': ...} into
    # variables.route (making it a dict), but the CDT compares that path to a
    # scalar — it can never match.
    graph = _branching_graph(
        writer_code=_DICT_WRITER, expression="variables.route == 'urgent'"
    )
    findings = _validate_graph(graph)
    mismatch = _codes(findings, "output_shape_mismatch")
    assert len(mismatch) == 1
    assert mismatch[0]["severity"] == "error"
    assert mismatch[0]["node"] == "Router"
    assert "Classify" in mismatch[0]["message"]


def test_scalar_writer_vs_scalar_compare_is_clean():
    # False-positive guard: the correct shape (scalar writer, scalar compare)
    # produces no shape finding and no dry-run error.
    graph = _branching_graph(
        writer_code=_SCALAR_WRITER, expression="variables.route == 'urgent'"
    )
    findings = _validate_graph(graph)
    assert _codes(findings, "output_shape_mismatch") == []
    assert _codes(findings, "cdt_expression_error") == []
    assert not [f for f in findings if f["severity"] == "error"]


def test_reading_subkey_of_scalar_writer_is_flagged():
    # Vice-versa: Classify writes a scalar to variables.route, but the CDT reads
    # variables.route.level — a scalar has no such member.
    graph = _branching_graph(
        writer_code=_SCALAR_WRITER, expression="variables.route.level == 'high'"
    )
    findings = _validate_graph(graph)
    mismatch = _codes(findings, "output_shape_mismatch")
    assert any(m["severity"] == "error" for m in mismatch)
    assert any("level" in m["message"] for m in mismatch)


def test_unprovable_writer_shape_does_not_hard_error():
    # When the writer's return isn't a static literal (a bare name), the shape
    # can't be proven — no output_shape_mismatch error is asserted.
    graph = _branching_graph(
        writer_code="def main(text):\n    x = text\n    return x\n",
        expression="variables.route == 'urgent'",
    )
    findings = _validate_graph(graph)
    assert _codes(findings, "output_shape_mismatch") == []


# ---------------------------------------------------------------------------
# Fix #2 — safe dry-run evaluation of CDT expressions
# ---------------------------------------------------------------------------


def test_dryrun_flags_typoed_path():
    # variables.rout (typo) is neither declared nor written -> AttributeError at
    # eval -> cdt_expression_error.
    graph = _branching_graph(
        writer_code=_SCALAR_WRITER, expression="variables.rout == 'urgent'"
    )
    findings = _validate_graph(graph)
    err = _codes(findings, "cdt_expression_error")
    assert len(err) == 1
    assert err[0]["severity"] == "error"
    assert err[0]["node"] == "Router"


def test_dryrun_flags_non_boolean_expression():
    graph = _branching_graph(
        writer_code=_SCALAR_WRITER, expression="variables.route"
    )
    findings = _validate_graph(graph)
    non_bool = _codes(findings, "cdt_expression_not_boolean")
    assert len(non_bool) == 1
    assert non_bool[0]["severity"] == "warning"


def test_dryrun_flags_impossible_equality_as_never_true():
    # Comparing the (dict) writer output to a scalar: the whole-expression static
    # check flags it as an error; the dynamic check additionally proves the
    # equality can never hold.
    graph = _branching_graph(
        writer_code=_DICT_WRITER, expression="variables.route == 'urgent'"
    )
    findings = _validate_graph(graph)
    assert _codes(findings, "cdt_expression_never_true")


def test_dryrun_skips_function_call_expression_as_uncheckable():
    graph = _branching_graph(
        writer_code=_SCALAR_WRITER,
        expression="len(variables.route) > 0",
    )
    findings = _validate_graph(graph)
    uncheckable = _codes(findings, "cdt_expression_uncheckable")
    assert len(uncheckable) == 1
    assert uncheckable[0]["severity"] == "warning"
    # A skipped call must NOT be reported as an evaluation error.
    assert _codes(findings, "cdt_expression_error") == []


def test_dryrun_evaluator_is_safe_against_dunder_escape():
    # A classic sandbox-escape probe must be CAUGHT (flagged) and never executed.
    # If it were eval'd it would reach object subclasses; the safety scan refuses
    # to run it and reports an error instead.
    malicious = "variables.__class__.__base__.__subclasses__() == []"
    graph = _branching_graph(writer_code=_SCALAR_WRITER, expression=malicious)
    findings = _validate_graph(graph)
    err = _codes(findings, "cdt_expression_error")
    assert len(err) == 1
    assert err[0]["severity"] == "error"
    assert "dunder" in err[0]["message"] or "introspection" in err[0]["message"]


def test_dryrun_evaluator_rejects_import_payload_without_running_it():
    # __import__ is a dunder name -> refused before any eval; nothing executes.
    graph = _branching_graph(
        writer_code=_SCALAR_WRITER,
        expression="__import__('os').getcwd() == '/'",
    )
    findings = _validate_graph(graph)
    err = _codes(findings, "cdt_expression_error")
    assert len(err) == 1
    assert err[0]["severity"] == "error"


def test_persistence_wrapped_start_variables_are_unwrapped_for_readers():
    """A live persistence flow stores start variables wrapped as
    {"variables": {...}, "persistent_variables": {...}}. A node reading a
    declared inner path must NOT be flagged unwritten — the validator must look
    through the wrapper (regression: it previously only unwrapped for the CDT
    dry-run namespace, not for known_shape_paths)."""
    graph = {
        **BASE_GRAPH,
        "start_node_list": [
            {
                "id": 1,
                "node_name": "__start__",
                "metadata": {"position": {}},
                "variables": {
                    "variables": {"context": {"counter": 0, "history": []}, "out": {}},
                    "persistent_variables": {
                        "organization": ["context.counter"],
                        "user": ["context.history"],
                    },
                },
            }
        ],
        "end_node_list": [
            {"id": 2, "node_name": "__end_node__", "metadata": {"position": {}}, "output_map": {}}
        ],
        "python_node_list": [
            {
                "id": 3,
                "node_name": "Step",
                "metadata": {"position": {}},
                "python_code": {"code": "def main(c=0):\n    return {'msg': str(c)}\n", "libraries": []},
                "input_map": {"c": "variables.context.counter"},
                "output_variable_path": "variables.out",
            }
        ],
        "edge_list": [
            {"id": 10, "start_node_id": 1, "end_node_id": 3},
            {"id": 11, "start_node_id": 3, "end_node_id": 2},
        ],
    }
    findings = _validate_graph(graph)
    assert _codes(findings, "unwritten_input_path") == []
    assert [f for f in findings if f["severity"] == "error"] == []
