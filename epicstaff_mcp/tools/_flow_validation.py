"""Validation-on-write helpers for flow tools.

Pure, side-effect-free checks plus an envelope wrapper so that write tools can
return ``{status, what_changed, warnings, suggested_next, result}`` instead of a
raw API echo. The raw API response is preserved under ``result`` so existing
callers can still reach every field (``envelope[...]["result"]["id"]``).

These checks encode the operational gotchas documented in the ``epicstaff`` skill
and verified by ``flows.test_flow`` (empty/entrypoint-less Python code, Decision
Table groups missing ``conditions: []``, CDT ``prompts`` typed as a list, non-CDT
``ports`` left as ``[]`` instead of ``null``). Keep this module import-light and
free of network I/O so it stays trivially unit-testable.
"""
from __future__ import annotations

import ast
from typing import Any

# A "blocker" warning means the move is almost certainly broken at runtime. The
# envelope reports status="error" when any of these are present (without raising,
# so the caller still receives the raw result and can decide what to do).
BLOCKER_CODES: frozenset[str] = frozenset(
    {"missing_main", "empty_code", "dt_group_no_conditions", "cdt_prompts_not_dict"}
)

# Modules importable without a declared library. Not exhaustive — just enough to
# avoid false "libraries wiped" warnings for the common standard-library imports.
_STDLIB_HINT: frozenset[str] = frozenset(
    {
        "abc", "argparse", "ast", "asyncio", "base64", "collections", "contextlib",
        "copy", "csv", "datetime", "decimal", "enum", "functools", "hashlib", "heapq",
        "hmac", "io", "itertools", "json", "logging", "math", "os", "pathlib",
        "random", "re", "secrets", "string", "struct", "sys", "textwrap", "time",
        "typing", "unicodedata", "urllib", "uuid", "warnings", "zoneinfo",
    }
)

Warning_ = dict[str, Any]


def _w(code: str, message: str, node: str | None = None) -> Warning_:
    return {"code": code, "message": message, "node": node}


def status_of(warnings: list[Warning_]) -> str:
    """ok | warning | error — error iff any blocker-level warning is present."""
    if any(w.get("code") in BLOCKER_CODES for w in warnings):
        return "error"
    return "warning" if warnings else "ok"


def envelope(
    result: Any,
    what_changed: str,
    warnings: list[Warning_] | None = None,
    suggested_next: list[str] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Wrap a raw tool result in the semantic-return envelope.

    The raw API response stays under ``result`` so no information is lost.
    ``extra`` lets specific tools attach fields (e.g. ``gate`` for save_flow).
    """
    out: dict[str, Any] = {
        "status": status_of(warnings or []),
        "what_changed": what_changed,
        "warnings": warnings or [],
        "suggested_next": suggested_next or [],
        "result": result,
    }
    if extra:
        out.update(extra)
    return out


# ---------------------------------------------------------------------------
# Pure node checks. Each takes a "node-like" dict (the create payload, the patch
# payload merged with existing data, or a node from a graph response) and returns
# a list of warnings. None of these touch the network.
# ---------------------------------------------------------------------------

def _third_party_imports(code: str) -> set[str]:
    """Top-level module names imported in ``code`` that look non-stdlib."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set()
    mods: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mods.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                mods.add(node.module.split(".")[0])
    return {m for m in mods if m and m not in _STDLIB_HINT}


def check_python_node(node: Warning_) -> list[Warning_]:
    """Empty code, missing entrypoint, and libraries-likely-wiped checks."""
    name = node.get("node_name")
    pc = node.get("python_code") or {}
    code = pc.get("code", "") or ""
    entrypoint = pc.get("entrypoint") or "main"
    libraries = pc.get("libraries")
    out: list[Warning_] = []

    if not code.strip():
        out.append(_w("empty_code", f"Node '{name}' has empty Python code.", name))
        return out

    if f"def {entrypoint}" not in code:
        out.append(
            _w(
                "missing_main",
                f"Node '{name}' has no `def {entrypoint}(...)` entrypoint in its code.",
                name,
            )
        )

    third_party = _third_party_imports(code)
    if third_party and not libraries:
        out.append(
            _w(
                "libraries_wiped",
                f"Node '{name}' imports non-stdlib module(s) "
                f"{sorted(third_party)} but has no libraries declared — "
                "they may have been wiped. Pass libraries explicitly.",
                name,
            )
        )
    return out


def check_dt_groups(
    condition_groups: list[dict[str, Any]] | None, node_name: str | None = None
) -> list[Warning_]:
    """Every Decision Table group must carry a ``conditions`` key (the backend
    pops it and errors otherwise); at least one group should route somewhere."""
    out: list[Warning_] = []
    groups = condition_groups or []
    for i, g in enumerate(groups):
        if "conditions" not in g:
            label = g.get("group_name", f"#{i}")
            out.append(
                _w(
                    "dt_group_no_conditions",
                    f"DT group '{label}' is missing the required \"conditions\": [] key.",
                    node_name,
                )
            )
    if groups and not any(g.get("next_node_id") or g.get("next_node") for g in groups):
        out.append(
            _w(
                "dt_no_route",
                f"DT node '{node_name}' has no condition group with a next_node.",
                node_name,
            )
        )
    return out


def check_cdt(node: Warning_) -> list[Warning_]:
    """CDT ``prompts`` must be a dict; at least one group should route."""
    out: list[Warning_] = []
    name = node.get("node_name")
    prompts = node.get("prompts")
    if isinstance(prompts, list):
        out.append(
            _w(
                "cdt_prompts_not_dict",
                f"CDT node '{name}' prompts must be a dict keyed by group name, not a list.",
                name,
            )
        )
    groups = node.get("condition_groups") or []
    if groups and not any(g.get("next_node_id") or g.get("next_node") for g in groups):
        out.append(
            _w(
                "cdt_no_route",
                f"CDT node '{name}' has no condition group with a next_node.",
                name,
            )
        )
    return out


def check_code_agent(node: Warning_) -> list[Warning_]:
    """Code-agent nodes need a runtime message and an LLM to run.

    The executor reads the user message from a ``prompt`` or ``action`` key in
    ``input_map`` (the ``system_prompt`` is only the system role), and fails at
    run time with "requires a 'prompt' or 'action' in input_map" without it.
    The LLM lives on ``llm_config`` (``add_node`` accepts the ``llm_config_id``
    alias); missing it leaves the node unrunnable.
    """
    out: list[Warning_] = []
    name = node.get("node_name")
    input_map = node.get("input_map") or {}
    if not any(k in input_map for k in ("prompt", "action")):
        out.append(
            _w(
                "codeagent_no_prompt",
                f"Code-agent node '{name}' input_map needs a 'prompt' or 'action' "
                f"key (the runtime message) — without it the node errors at run time.",
                name,
            )
        )
    if not (node.get("llm_config") or node.get("llm_config_id")):
        out.append(
            _w(
                "codeagent_no_llm",
                f"Code-agent node '{name}' has no llm_config; pass llm_config_id "
                f"so it can run.",
                name,
            )
        )
    return out


def check_ports(node: Warning_) -> list[Warning_]:
    """Non-CDT nodes must have ports=null, not [] (an empty list breaks wiring)."""
    if node.get("ports") == []:
        name = node.get("node_name")
        return [
            _w(
                "ports_not_null",
                f"Node '{name}' has ports=[]; non-CDT nodes must use ports=null.",
                name,
            )
        ]
    return []


# Node types that accept Python code under check_python_node.
_PYTHON_NODE_TYPES = frozenset({"pythonnode", "webhooktriggernode"})


def check_node_config(
    node_type: str, config: dict[str, Any], node_name: str | None
) -> list[Warning_]:
    """Dispatch the right pure check for a node create/update payload."""
    node = {**config, "node_name": node_name}
    nt = node_type.lower()
    warnings: list[Warning_] = []
    if nt in _PYTHON_NODE_TYPES:
        warnings += check_python_node(node)
    elif nt == "decisiontablenode":
        warnings += check_dt_groups(node.get("condition_groups"), node_name)
    elif nt == "codeagentnode":
        warnings += check_code_agent(node)
    warnings += check_ports(node)
    return warnings


def structural_next_steps(graph_id: int) -> list[str]:
    """The mandatory follow-ups after any structural change, as call hints."""
    return [f"init_flow_metadata({graph_id})", f"test_flow({graph_id})"]
