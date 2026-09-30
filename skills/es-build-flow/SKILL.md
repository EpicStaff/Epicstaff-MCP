---
name: es-build-flow
description: Compile a local flow source — validate, resolve references, compute layout — and interpret the build report. Use to check a flow before pushing, or to debug validation errors.
---

# Build a flow (local compile)

One responsibility: a clean local build and an understood build report. No network, no push.

1. Call `build_flow` with the flow directory.
2. On errors: run `validate_flow` for the located diagnostics, fix the flow source at each
   reported `path`/`file`, and rebuild. Typical errors:
   - unresolved reference → typo in a symbolic name, or the entity should be `{ existing: ... }`
   - RAG-type mismatch → the surface's search config doesn't match the collection's `rag.strategy`
   - forbidden node type → `llm`/`code-agent` are not allowed; model the intent differently
3. On success, read the report to the user: entities by action (create/update/reuse/existing),
   node count with computed positions, edge count, warnings.
4. Treat warnings seriously: `defined but unused` usually means a wiring mistake;
   `crew deprecated` means consider agent/task nodes instead.

Done when: `build_flow` succeeds and the push plan matches the user's intent.
