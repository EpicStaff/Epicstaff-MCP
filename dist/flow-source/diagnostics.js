/**
 * Compiler-style diagnostics for the flow-source language.
 *
 * Every problem found while loading or resolving a flow source is reported as a
 * `Diagnostic` — never thrown — so callers (MCP tools, tests) can show the full
 * list of problems at once, like a compiler would.
 */
export function makeDiagnostic(severity, path, message, file) {
    const diagnostic = { severity, path, message };
    if (file !== undefined) {
        diagnostic.file = file;
    }
    return diagnostic;
}
export function makeError(path, message, file) {
    return makeDiagnostic('error', path, message, file);
}
export function makeWarning(path, message, file) {
    return makeDiagnostic('warning', path, message, file);
}
export function hasErrors(diagnostics) {
    return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
/**
 * Join zod-style path segments into the canonical diagnostic path form:
 * strings become dot segments, numbers become `[n]` index accessors.
 * `['flow','edges',2,'to']` → `"flow.edges[2].to"`.
 */
export function joinPath(segments) {
    let joined = '';
    for (const segment of segments) {
        if (typeof segment === 'number') {
            joined += `[${segment}]`;
        }
        else {
            joined += joined === '' ? segment : `.${segment}`;
        }
    }
    return joined;
}
/** Render a diagnostic as a single human-readable line. */
export function formatDiagnostic(diagnostic) {
    const location = diagnostic.file !== undefined ? ` (${diagnostic.file})` : '';
    const at = diagnostic.path === '' ? '' : ` at ${diagnostic.path}`;
    return `${diagnostic.severity}${at}${location}: ${diagnostic.message}`;
}
