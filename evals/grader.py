"""Deterministic, offline grading of eval specs against the real flow validator.

Grades a spec by loading its fixture (a static exported-flow-shaped JSON dict)
and running it through `epicstaff_mcp.tools.flows._validate_graph` — the same
pure validation seam `validate_flow` calls against a live-fetched graph. No
network I/O, no mutation, single source of truth for the checks themselves.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import BaseModel, ConfigDict

from epicstaff_mcp.tools.flows import _validate_graph
from evals.spec import EvalSpec

EVALS_ROOT = Path(__file__).resolve().parent


class GradeResult(BaseModel):
    """Outcome of grading one spec — one row of the scorecard."""

    model_config = ConfigDict(frozen=True)

    spec_id: str
    title: str
    category: str
    expected: str
    actual: str
    passed: bool
    reason: str


def load_fixture(fixture_relative_path: str) -> dict[str, Any]:
    """Load a fixture flow graph dict from `evals/<fixture_relative_path>`."""
    fixture_path = EVALS_ROOT / fixture_relative_path
    return json.loads(fixture_path.read_text())


def grade_spec(spec: EvalSpec) -> GradeResult:
    """Grade one offline spec.

    A `should_pass` spec passes iff `_validate_graph` produces zero
    error-severity findings. A `should_fail` spec passes iff every code in
    `expected_codes` appears among the produced findings (any severity —
    some key codes, e.g. `ports_empty_list`, are warnings by design and never
    flip `ok` to False on their own).
    """
    if spec.mode != "offline":
        raise ValueError(
            f"grade_spec only handles offline specs; spec '{spec.id}' has mode "
            f"'{spec.mode}' — use evals.online.grade_spec_online instead."
        )

    logger.info("Grading spec {} ({})", spec.id, spec.category)
    graph = load_fixture(spec.fixture)
    findings = _validate_graph(graph)
    error_codes = sorted({f["code"] for f in findings if f["severity"] == "error"})
    all_codes = sorted({f["code"] for f in findings})

    if spec.should_pass:
        expected = "pass (zero error-severity findings)"
        passed = not error_codes
        actual = "pass" if passed else f"fail — errors: {error_codes}"
        reason = (
            "no error-severity findings, as expected"
            if passed
            else f"expected zero errors but found {len(error_codes)}: {error_codes}"
        )
    else:
        expected = f"produces finding code(s): {spec.expected_codes}"
        missing = [code for code in spec.expected_codes if code not in all_codes]
        passed = not missing
        actual = f"codes found: {all_codes}" if all_codes else "codes found: []"
        reason = (
            "all expected finding codes were produced"
            if passed
            else f"missing expected code(s): {missing}"
        )

    return GradeResult(
        spec_id=spec.id,
        title=spec.title,
        category=spec.category,
        expected=expected,
        actual=actual,
        passed=passed,
        reason=reason,
    )
