"""Entrypoint for the flow-correctness eval harness.

Run all specs, print a readable scorecard, and emit a machine-readable JSON
summary. Run with `python -m evals.run` (or `python -m evals`) from the repo
root. See `evals/README.md` for the exact command and the spec format.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from loguru import logger

from evals.grader import GradeResult, grade_spec
from evals.online import grade_spec_online
from evals.report import (
    build_scorecard,
    render_headline,
    render_table,
    scorecard_to_json,
)
from evals.spec import EvalSpec

EVALS_ROOT = Path(__file__).resolve().parent
DEFAULT_SPECS_DIR = EVALS_ROOT / "specs"


def load_specs(specs_dir: Path = DEFAULT_SPECS_DIR) -> list[EvalSpec]:
    """Load every `*.json` spec file, sorted by filename for a stable run order."""
    spec_paths = sorted(specs_dir.glob("*.json"))
    if not spec_paths:
        raise ValueError(f"No spec files found under {specs_dir}")
    return [EvalSpec.from_dict(json.loads(path.read_text())) for path in spec_paths]


async def _grade_online(specs: list[EvalSpec]) -> list[GradeResult]:
    results: list[GradeResult] = []
    for spec in specs:
        try:
            results.append(await grade_spec_online(spec))
        except NotImplementedError as exc:
            logger.warning("Skipping online spec {}: {}", spec.id, exc)
    return results


def run(
    specs_dir: Path = DEFAULT_SPECS_DIR, *, online: bool = False
) -> tuple[str, dict]:
    """Grade every spec and return (readable report text, JSON-serializable scorecard)."""
    specs = load_specs(specs_dir)
    offline_specs = [spec for spec in specs if spec.mode == "offline"]
    online_specs = [spec for spec in specs if spec.mode == "online"]

    results = [grade_spec(spec) for spec in offline_specs]

    if online_specs:
        if online:
            results.extend(asyncio.run(_grade_online(online_specs)))
        else:
            logger.info(
                "{} online spec(s) skipped (pass --online to attempt them): {}",
                len(online_specs),
                [spec.id for spec in online_specs],
            )

    scorecard = build_scorecard(results)
    table = render_table(results)
    headline = render_headline(scorecard)
    return f"{table}\n\n{headline}", scorecard_to_json(scorecard)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the EpicStaff MCP flow-correctness eval harness."
    )
    parser.add_argument(
        "--specs-dir",
        type=Path,
        default=DEFAULT_SPECS_DIR,
        help="Directory of spec JSON files (default: evals/specs/).",
    )
    parser.add_argument(
        "--online",
        action="store_true",
        help="Also attempt 'online' mode specs (extension point — unimplemented today).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write the JSON scorecard to this path in addition to stdout.",
    )
    args = parser.parse_args(argv)

    report_text, scorecard_json = run(args.specs_dir, online=args.online)
    print(report_text)
    print()
    print(json.dumps(scorecard_json, indent=2))

    if args.out is not None:
        args.out.write_text(json.dumps(scorecard_json, indent=2))
        logger.info("Wrote scorecard JSON to {}", args.out)

    return 0 if scorecard_json["success_rate"] == 1.0 else 1


if __name__ == "__main__":
    sys.exit(main())
