/**
 * Compiler-style diagnostics for the flow-source language.
 *
 * Every problem found while loading or resolving a flow source is reported as a
 * `Diagnostic` — never thrown — so callers (MCP tools, tests) can show the full
 * list of problems at once, like a compiler would.
 */

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Dot path into the flow source, e.g. `agents.researcher.llm_config` or `flow.edges[2].to`. */
  path: string;
  /** Source file the offending section came from, when known (basename relative to the flow dir). */
  file?: string;
  message: string;
}

export function makeDiagnostic(
  severity: DiagnosticSeverity,
  path: string,
  message: string,
  file?: string,
): Diagnostic {
  const diagnostic: Diagnostic = { severity, path, message };
  if (file !== undefined) {
    diagnostic.file = file;
  }
  return diagnostic;
}

export function makeError(path: string, message: string, file?: string): Diagnostic {
  return makeDiagnostic('error', path, message, file);
}

export function makeWarning(path: string, message: string, file?: string): Diagnostic {
  return makeDiagnostic('warning', path, message, file);
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/**
 * Join zod-style path segments into the canonical diagnostic path form:
 * strings become dot segments, numbers become `[n]` index accessors.
 * `['flow','edges',2,'to']` → `"flow.edges[2].to"`.
 */
export function joinPath(segments: ReadonlyArray<string | number>): string {
  let joined = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      joined += `[${segment}]`;
    } else {
      joined += joined === '' ? segment : `.${segment}`;
    }
  }
  return joined;
}

/** Render a diagnostic as a single human-readable line. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.file !== undefined ? ` (${diagnostic.file})` : '';
  const at = diagnostic.path === '' ? '' : ` at ${diagnostic.path}`;
  return `${diagnostic.severity}${at}${location}: ${diagnostic.message}`;
}
