"""Online-mode extension point for the eval harness — NOT IMPLEMENTED.

Phase 0/1 of this program is offline-only: grade static exported-flow JSON
fixtures against the pure `_validate_graph` seam, with zero network I/O. A
later phase will want to grade a live Claude Code rollout instead — build a
real flow via the MCP tools against a running Django backend, then:

  1. Fetch it with `epicstaff_mcp.tools.flows.get_flow(graph_id)` and run it
     through the same `_validate_graph` seam (static check, live data).
  2. Optionally call `epicstaff_mcp.tools.sessions.run_session_and_wait` for a
     runtime smoke test — did the session actually complete, not just does the
     structure look sound.

That live-rollout driver is deliberately not built here — this module is the
seam it will hang off. `evals/run.py` calls `grade_spec_online` only when a
spec declares `"mode": "online"` and the caller passes `--online`; otherwise
online specs are reported as skipped, never silently treated as failures.
"""

from __future__ import annotations

from evals.grader import GradeResult
from evals.spec import EvalSpec


async def grade_spec_online(spec: EvalSpec) -> GradeResult:
    """Grade a spec against a live `graph_id`. Extension point — not implemented.

    Wire this to `get_flow` + `_validate_graph` for the static check, and
    `run_session_and_wait` for a runtime smoke, per the module docstring.
    """
    raise NotImplementedError(
        f"spec '{spec.id}' requests online grading (graph_id={spec.graph_id}), "
        "which is an unimplemented extension point — see evals/online.py."
    )
