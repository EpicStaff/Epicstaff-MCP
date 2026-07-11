"""Scorecard rendering — a readable table plus a machine-readable JSON summary.

The JSON summary is the regression gate: later phases compare their own run's
`success_rate` (and per-category breakdown) against a checked-in baseline to
catch a drop in flow-build correctness before it ships.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict

from evals.grader import GradeResult


class CategoryBreakdown(BaseModel):
    model_config = ConfigDict(frozen=True)

    total: int
    correct: int
    success_rate: float


class Scorecard(BaseModel):
    """Full run summary — the machine-readable regression-gate artifact."""

    model_config = ConfigDict(frozen=True)

    generated_at: str
    total_specs: int
    correct: int
    success_rate: float
    categories: dict[str, CategoryBreakdown]
    results: list[GradeResult]


def build_scorecard(results: list[GradeResult]) -> Scorecard:
    total = len(results)
    correct = sum(1 for r in results if r.passed)
    success_rate = correct / total if total else 0.0

    by_category: dict[str, list[GradeResult]] = {}
    for result in results:
        by_category.setdefault(result.category, []).append(result)

    categories = {
        category: CategoryBreakdown(
            total=len(rows),
            correct=sum(1 for r in rows if r.passed),
            success_rate=sum(1 for r in rows if r.passed) / len(rows),
        )
        for category, rows in by_category.items()
    }

    return Scorecard(
        generated_at=datetime.now(timezone.utc).isoformat(),
        total_specs=total,
        correct=correct,
        success_rate=success_rate,
        categories=categories,
        results=results,
    )


def render_table(results: list[GradeResult]) -> str:
    """Render a fixed-width, readable table: id, category, expected, actual, pass/fail, reason."""
    headers = ("id", "category", "expected", "actual", "pass/fail", "reason")
    rows = [
        (
            r.spec_id,
            r.category,
            r.expected,
            r.actual,
            "PASS" if r.passed else "FAIL",
            r.reason,
        )
        for r in results
    ]
    widths = [
        max(len(headers[i]), *(len(row[i]) for row in rows))
        if rows
        else len(headers[i])
        for i in range(len(headers))
    ]

    def _format_row(row: tuple[str, ...]) -> str:
        return " | ".join(cell.ljust(widths[i]) for i, cell in enumerate(row))

    separator = "-+-".join("-" * width for width in widths)
    lines = [_format_row(headers), separator]
    lines.extend(_format_row(row) for row in rows)
    return "\n".join(lines)


def render_headline(scorecard: Scorecard) -> str:
    lines = [
        f"first-try build-success rate: {scorecard.correct}/{scorecard.total_specs} "
        f"({scorecard.success_rate:.1%})",
        "",
        "per-category breakdown:",
    ]
    for category, breakdown in sorted(scorecard.categories.items()):
        lines.append(
            f"  {category}: {breakdown.correct}/{breakdown.total} "
            f"({breakdown.success_rate:.1%})"
        )
    return "\n".join(lines)


def scorecard_to_json(scorecard: Scorecard) -> dict[str, Any]:
    return scorecard.model_dump()
