---
name: es-deliver
description: Front door for any request to build or extend something with EpicStaff — a flow, agent, automation, tool, pipeline, or an app powered by one. FIRST decide the delivery shape (ES-only, ES + a new app, or ES integrated into an existing app), then drive the es-* pipeline plus the right delivery tail to completion. Use whenever the task involves creating or changing EpicStaff behavior, whatever its domain or interface.
---

# Deliver an EpicStaff solution

One responsibility: turn a request into the right *shape* of deliverable and drive it end to end.
The flow is always the engine; what wraps it — nothing, a new app, or a change to an existing app
— is the decision this skill exists to make. This is domain-agnostic: the flow may be a chat
agent, a data pipeline, a document processor, a scheduled job, a classifier, a form-style
input→output tool, or anything else. Do not assume a conversational interface.

## Step 1 — Classify the delivery shape

Read the request and pick ONE. The signal is **who or what consumes the flow**, not its difficulty
or domain.

| Shape | The deliverable is… | Signals in the request |
|---|---|---|
| **ES-only** | The flow itself, running on EpicStaff. | "build a flow / agent / automation / pipeline / tool", "when X happens do Y", trigger-driven (webhook / schedule / telegram) — the trigger *is* the interface. No separate consumer named. |
| **ES + App** | The flow **plus a new app** you create to drive it. | The request names an interface or consumer to build: a UI, page, dashboard, form, chat, CLI, service, "expose an API for …", "so <someone> can use it". |
| **ES + Integration** | The flow **plus changes to an existing app** so it calls the flow. | "add this to our app", "integrate into <existing system>", "in our frontend / website / product / service", "our existing …". |

If genuinely ambiguous, ask exactly ONE clarifying question: *"Should I deliver just the EpicStaff
flow, a new app on top of it, or wire it into an existing app?"* — then proceed. Otherwise infer
and state the shape you chose in your first response.

## Step 2 — Build the flow (all shapes)

Every shape needs a working graph first. Do not build any app or integration until the flow runs
green.

1. `es-connect` — auth + organization.
2. `es-write-flow` — discover and **reuse** existing entities before defining new ones, then
   author/edit the flow source.
3. `es-build-flow` → `es-push-flow` — compile clean, then materialize.
4. `es-test-flow` — run with realistic input and confirm the output is genuinely good against the
   task's own bar (correct; and for anything user-facing, clear and useful). Iterate until it is.

Stop here for **ES-only**: report the graph id, how it is triggered/run, and — if a caller will
invoke it programmatically — the run-session contract (below).

## Step 3 — Deliver the wrapper

First, read the flow's **interaction shape** from its own wiring — the `input_map` reads
(`variables.…`) tell you what inputs it consumes, and the `output_variable_path` writes tell you
what it produces. Build the *smallest* wrapper that exercises that shape well. Examples, not a
menu:

- turn-based text in → text out → a chat UI (the `generate_chat_ui` tool emits a self-contained
  one; give it the input/reply variable paths).
- a fixed set of fields → one result → a form + result view.
- a document / dataset in → a structured report → an upload + report page, or a batch runner.
- event/schedule-triggered → usually no UI at all; deliver the trigger config and a status view if
  asked.

### ES + App — build a new client

Scaffold a self-contained, runnable app in a stack that fits the interaction shape, driving the
flow through the run-session contract below. Reach for `generate_chat_ui` only when the shape is
actually conversational; otherwise build what fits. Deliver the artifact(s) and how to run them.

### ES + Integration — wire into the existing app

1. Locate the existing app and its stack; read enough to match its conventions.
2. Add a client/service that calls the run-session contract below, following the app's own
   patterns (HTTP layer, config, auth). Use the stack's proper tooling — if the target codebase
   has dedicated specialist agents/skills, defer code changes to them rather than hand-editing.
3. Wire it into the entry point the user named, and verify a round trip.

## The run-session contract (any flow; App + Integration share it)

Per invocation:

1. `POST {apiUrl}run-session/` — multipart, field **`variables`** (NOT `initial_state`, which the
   backend ignores). Send the full variables map the flow expects, with the caller's inputs written
   into the paths the flow reads. Reset any downstream fields to empty/null so a
   `persistent_variables` graph can't carry a previous run's values forward.
2. Poll `GET {apiUrl}sessions/{id}/get-updates/` until status is terminal
   (`end` / `error` / `stop` / `expired`).
3. `GET {apiUrl}graph-session-messages/?session_id={id}` — read the flow's outputs from the
   terminal state's `variables.…` (the paths the flow writes), or the per-node messages for a
   step-by-step result.

Auth from a browser or external app: `Authorization: ApiKey <key>` + `X-Organization-Id: <id>`
(both CORS-allowed; `X-Api-Key` is not).

Done when: the flow works AND its chosen wrapper (none / new app / integration) is delivered and
verified.
