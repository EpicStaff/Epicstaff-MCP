/**
 * Flow compiler — pure and local. Pipeline:
 *
 *   loadFlowDirectory (parse + schema + language rules)
 *     → resolveFlow    (symbol table + reference resolution)
 *     → validateFlow   (semantic rules — validate.ts)
 *     → emitFlow       (entity plans + laid-out graph state — emit.ts)
 *
 * Every stage reports problems as diagnostics; the pipeline stops at the first
 * stage that produced ERRORS and returns a diagnostics-only artifact (empty
 * entity list, empty graph). Warnings never stop the build.
 */
import path from 'node:path';
import { hasErrors } from '../flow-source/diagnostics.js';
import { loadFlowDirectory } from '../flow-source/loader.js';
import { resolveFlow } from '../flow-source/resolver.js';
import { validateDataflow } from './dataflow.js';
import { emitFlow } from './emit.js';
import { validateFlow } from './validate.js';
export * from './artifact.js';
export * from './layout.js';
export * from './template-refs.js';
export { validateFlow, TRIGGER_NODE_TYPES } from './validate.js';
export { emitFlow } from './emit.js';
function diagnosticsOnlyArtifact(flowName, diagnostics, description) {
    return {
        flowName,
        ...(description !== undefined ? { description } : {}),
        diagnostics,
        entities: [],
        graph: { nodes: [], edges: [] },
        summary: { stoppedOnErrors: true },
    };
}
/**
 * Compile a flow directory into a {@link BuildArtifact}. Never throws for
 * content problems — check `hasErrors(artifact.diagnostics)` before pushing.
 */
export async function compileFlow(flowDir) {
    const loaded = await loadFlowDirectory(flowDir);
    const diagnostics = [...loaded.diagnostics];
    const flowName = loaded.source?.meta.name ?? path.basename(flowDir);
    const description = loaded.source?.meta.description;
    if (loaded.source === null || hasErrors(diagnostics)) {
        return diagnosticsOnlyArtifact(flowName, diagnostics, description);
    }
    const resolved = resolveFlow(loaded.source);
    diagnostics.push(...resolved.diagnostics);
    if (hasErrors(diagnostics)) {
        return diagnosticsOnlyArtifact(flowName, diagnostics, description);
    }
    diagnostics.push(...validateFlow(loaded.source, resolved));
    diagnostics.push(...validateDataflow(loaded.source));
    if (hasErrors(diagnostics)) {
        return diagnosticsOnlyArtifact(flowName, diagnostics, description);
    }
    const emitted = await emitFlow(loaded.source, flowDir);
    diagnostics.push(...emitted.diagnostics);
    return {
        flowName,
        ...(description !== undefined ? { description } : {}),
        diagnostics,
        entities: emitted.entities,
        graph: emitted.graph,
        summary: emitted.summary,
    };
}
