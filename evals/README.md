# evals — the flow-correctness ruler

A deterministic, offline, CI-friendly harness that puts a number on "how
correct are EpicStaff flows." It grades static exported-flow JSON fixtures
against the real `validate_flow` checking logic — no running Django backend,
no network I/O, same answer every run. This is the regression gate later
phases (live rollout grading, agent-authored flow benchmarks, etc.) compare
against.

## How it works

`epicstaff_mcp/tools/flows.py` exposes a pure seam, `_validate_graph(graph:
dict) -> list[finding]`, factored out of the `validate_flow` MCP tool. The
public tool still does fetch → `_validate_graph` → assemble
`{"ok", "findings", "summary"}`; this harness calls the same pure function
directly against fixture dicts, so there is exactly one implementation of the
checks — the harness never reimplements them.

```
evals/
├── README.md            # this file
├── spec.py               # EvalSpec pydantic model
├── grader.py              # grade_spec() — loads a fixture, runs _validate_graph, decides pass/fail
├── report.py              # scorecard table + JSON summary rendering
├── online.py              # online-mode extension point (NOT IMPLEMENTED — see below)
├── run.py                 # CLI entrypoint
├── __main__.py            # `python -m evals` shorthand
├── specs/                 # *.json task specs (one file per eval case)
└── fixtures/               # *.json exported-flow-shaped graph dicts referenced by specs
```

## Task-spec format

Each file under `evals/specs/` is one JSON object:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `str` | yes | Unique spec id, used as the scorecard row key. |
| `title` | `str` | yes | Human-readable one-line description. |
| `category` | `str` | yes | Grouping for the per-category breakdown (e.g. `cdt-branch`, `data-flow`, `python-node`). |
| `fixture` | `str` | for `mode: offline` | Path to the fixture JSON, relative to `evals/` (e.g. `fixtures/known_good_weather_flow.json`). |
| `should_pass` | `bool` | yes | `true` — the flow is expected to be structurally sound. `false` — the flow is expected to trip specific finding code(s). |
| `expected_codes` | `list[str]` | required when `should_pass: false` | Finding `code`(s) the validator must produce (any severity — some codes, like `ports_empty_list`, are warnings by design). |
| `mode` | `"offline" \| "online"` | no (default `"offline"`) | See **Online-mode extension point** below. |
| `graph_id` | `int` | required when `mode: online` | Live graph id to fetch instead of a fixture. |
| `notes` | `str` | no | Free-text context for humans. |

### Example

```json
{
  "id": "cdt-route-by-name",
  "title": "CDT condition group routes by node name instead of integer next_node_id",
  "category": "cdt-branch",
  "fixture": "fixtures/cdt_route_by_name.json",
  "should_pass": false,
  "expected_codes": ["cdt_route_by_name"]
}
```

## Grading rule

- A `should_pass: true` spec **passes** iff `_validate_graph` produces zero
  `error`-severity findings on its fixture. (Warnings are allowed — a
  cosmetic-only flow is still a pass.)
- A `should_pass: false` spec **passes** iff every code in `expected_codes`
  appears among the findings produced (regardless of severity — this is what
  lets a warning-only code like `ports_empty_list` be exercised as a
  should-fail case even though it never flips a flow's own `ok` to `false`).

"Pass/fail" in the scorecard always refers to **grading correctness** — did
the harness's expectation match the validator's actual output — not to
whether the underlying flow itself is good or bad.

## Adding a new case

1. Hand-author a minimal exported-flow JSON dict under `evals/fixtures/`. Keep
   it as small as possible while still triggering (or not triggering) the
   behavior under test. Study `evals/fixtures/known_good_weather_flow.json`
   for the node-list-keyed shape (`start_node_list`, `python_node_list`,
   `edge_list`, ...), which mirrors what `validate_flow` fetches from
   `/api/graphs/{id}/` and what `save_flow` sends.
2. Add a matching spec under `evals/specs/` pointing at that fixture.
3. Run the harness (below) and confirm the new row appears with `pass/fail =
   PASS` — i.e. the fixture actually produces (or doesn't produce) the finding
   code you intended.

## Running the harness

From the repo root, with the project's virtualenv active:

```bash
python -m evals.run
```

Equivalently: `python -m evals`.

Flags:

- `--specs-dir PATH` — grade a different specs directory (default
  `evals/specs/`).
- `--out PATH` — also write the JSON scorecard to `PATH` (stdout always gets
  both the table and the JSON).
- `--online` — attempt any `mode: online` specs (see below). Without this
  flag, online specs are skipped and logged, never silently scored.

Exit code is `0` iff every graded spec passed (success rate `== 1.0`), making
this suitable as a CI gate.

## Scorecard output

The table has one row per spec: `id`, `category`, `expected`, `actual`,
`pass/fail`, `reason`. The JSON summary (also printed, and optionally written
via `--out`) has the shape:

```json
{
  "generated_at": "2026-07-10T16:24:48.200608+00:00",
  "total_specs": 6,
  "correct": 6,
  "success_rate": 1.0,
  "categories": {
    "cdt-branch": {"total": 1, "correct": 1, "success_rate": 1.0},
    "...": "..."
  },
  "results": ["... one GradeResult per spec ..."]
}
```

`success_rate` is the headline **first-try build-success rate**. Check in a
baseline JSON and diff future runs against it to catch regressions.

## Online-mode extension point (not implemented)

`evals/online.py` defines `grade_spec_online(spec: EvalSpec) -> GradeResult`,
the seam a later phase can wire up to grade a **live** Claude Code rollout
instead of a static fixture: fetch a real `graph_id` via
`epicstaff_mcp.tools.flows.get_flow` and run it through the same
`_validate_graph` seam (live data, same checks), optionally followed by a
runtime smoke test via `epicstaff_mcp.tools.sessions.run_session_and_wait`
(did the session actually complete, not just does the structure look sound).

Today it always raises `NotImplementedError`. `evals/run.py` only calls it for
specs with `"mode": "online"`, and only when invoked with `--online`; those
specs are otherwise skipped with a log line, never counted as a pass or a
failure. Do not build the live rollout driver as part of extending this file
without re-scoping — it is a deliberately separate, larger piece of work
(driving an actual agent session against a running Django backend).
