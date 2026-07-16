---
name: epicstaff-solution
description: Front door for ANY "build something with EpicStaff" request. Classifies the request as ES-only (deliverable lives entirely inside EpicStaff) vs app-shaped (EpicStaff is the backend + a UI users interact with), then dispatches. Use BEFORE epicstaff-flow whenever a user wants to build. Trigger phrases include "build a bot", "build an app", "build an assistant", "build a tool", "build a chatbot", "build a system", "build me", "I want users/customers to be able to", plus "build a flow" / "flow for" (which route to the ES-only path).
---

# EpicStaff Solution — Front Door (classify before you build)

**Core principle: EpicStaff is a *component*, not always the whole deliverable.** The common
failure is tunnel vision — treating every request as "build a flow and stop" when the user
actually wanted a working product with a UI. This skill exists to stop that at the door.

Before building anything, decide the **shape** of what's being asked. Do not skip this.

Companion skills:
- `epicstaff-flow` — builds the EpicStaff backend (flow / agents / RAG). The ES-only path.
- `epicstaff-app` — builds a custom UI shell wired to EpicStaff over REST. The app-shaped add-on.

---

## Phase 0 — Classify the request (ALWAYS do this first)

Two shapes:

| Shape | Deliverable | Path |
|---|---|---|
| **ES-only** | Lives entirely inside EpicStaff. No end-user UI. | `epicstaff-flow` |
| **App-shaped** | Something users *interact with*: EpicStaff is the backend **+** a UI. | `epicstaff-flow` (backend) **then** `epicstaff-app` (UI) |

### The rule: audience first, ask only when ambiguous (A + C)

**A — decide by audience (default, covers most cases):**
- Request names an end-user who **interacts** with it — "customers", "users", "a bot they
  talk to", "so people can…", "let clients…" → **app-shaped**.
- Request names only **work / outcomes** — "a team of agents that does X", "a flow that
  processes Y", "automate Z", "modify this node", "why did this flow fail" → **ES-only**.

**C — ask only when A is genuinely ambiguous:**
- If the audience signal is truly unclear, ask exactly one question:
  *"Should this include a UI that people use, or just the EpicStaff backend?"*
- **Do not ask when A already answers it.** C is a safety net, not a reflex — asking on every
  request re-introduces the friction we're removing.

### Worked examples

| Request | Shape | Why |
|---|---|---|
| "Build a bot to help customers calculate a price" | **app-shaped** | "customers" interact → needs a UI. *(This is the canonical case the old flow-only pipeline got wrong.)* |
| "Make a team of agents that researches competitors and writes a report" | ES-only | outcome/work, no interacting audience |
| "Build a flow that processes incoming webhooks" | ES-only | explicit flow, no UI |
| "I want a chat assistant our support team can use" | app-shaped | "team can use" → interacting audience |
| "Change the pricing node in flow 16" | ES-only | modify/operate existing flow |
| "Build something to handle quotes" | ambiguous → **ask (C)** | no audience signal either way |

### Dispatch

- **ES-only** → invoke `epicstaff-flow`. Done when its runnable gate (Step 9) passes.
- **App-shaped** → **two deliverables, one job:**
  1. `epicstaff-flow` — build the EpicStaff backend (flow / agents / RAG / persistence).
  2. `epicstaff-app` — build the UI shell wired to that backend over REST.
  Not done until **both** exist and run end-to-end. A flow with no UI is an unfinished
  app-shaped request.

---

## Personas (who drives via MCP)

- **Builder** (primary) — builds solutions with Claude + MCP (this front door).
- **Operator** (secondary) — runs / inspects / debugs existing flows via MCP; doesn't author.
- **Management** and **end-users** are **not** MCP personas — they consume what the Builder
  ships. Never assume the requester is the end-user of the thing being built.

---

## Non-negotiable build principle (applies to BOTH paths)

**Deterministic computation goes in a `pythonnode`, never an LLM/agent.** Math, pricing,
parsing, formatting, business rules — real code. Agents *decide* and *converse*; python
*computes*. The pallet A/B failure was partly an agent doing arithmetic and getting it wrong;
the correct build does the math in a `pythonnode` (0 LLM) — see `apps/pallet-quote-chat`'s
`Price` node. If deterministic output is worse under EpicStaff, that's a **defect to fix
inside the flow**, not a reason to move logic into the UI.

---

## Definition of done

- **ES-only:** `epicstaff-flow`'s runnable gate passes (`smoke_test_flow` → `runnable: true`).
- **App-shaped:** backend runnable gate passes **AND** the UI runs against the live backend
  end-to-end (a real user input produces the flow's rendered result).

## Testing is session-budgeted (both paths)

Every `run-session` / `run_session_and_wait` call is a full live execution that leaves a
session behind. Keep sessions to the genuine floor:

- **Build iteration** is bounded by `epicstaff-flow` Step 9 — iterate with
  `smoke_test_flow(execute=False)` (no session), then **one** live gate run. Not a run per edit.
- **Acceptance testing** is bounded by `epicstaff-app`'s "session-thrifty" rules — enumerate
  distinct scenarios, run each **once** against a single coverage checklist, validate
  deterministic logic offline (0 sessions), reuse sessions for sub-checks, and guard any test
  harness so `import` never re-fires live calls.

Report the session count when you hand off. A build that produces dozens of sessions is a
process failure (duplicate runs, an unguarded harness, or re-proving green scenarios), not
thoroughness.
