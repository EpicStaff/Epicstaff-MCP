/**
 * Semantic validation pass — rules beyond loading (schema/rule pass) and
 * resolution (symbol table). Runs after `resolveFlow` succeeded, so every
 * reference position either resolved or already produced an error.
 *
 * Mirrors the backend `SurfaceValidator`
 * (src/django_app/tables/validators/surface_validator.py) for the checks that
 * are decidable locally:
 *  - no duplicate tool / knowledge-collection references within one surface;
 *  - a knowledge search config must match the collection's RAG strategy
 *    (naive_config ⇒ naive, graph_* configs ⇒ graph) — verifiable only for
 *    local collections, `existing:` collections get a warning;
 *  - an `owner_agent` surface may only be attached to its owning agent.
 *
 * Plus flow-topology rules the backend enforces at run time (start/trigger
 * presence, no edges out of `end` / into `start` or triggers, no self-loops)
 * and hygiene warnings (unused local entities).
 *
 * Exact duplicate node names cannot occur here (nodes are a YAML map and the
 * loader errors on cross-file duplicates), but case-insensitive collisions can
 * — they are reported as errors because backend `node_name` lookups are not
 * guaranteed to be case-sensitive.
 */
import { makeError, makeWarning } from '../flow-source/diagnostics.js';
/** Node types that can begin a flow run. */
export const TRIGGER_NODE_TYPES = new Set([
    'start',
    'webhook-trigger',
    'telegram-trigger',
    'schedule-trigger',
]);
export function validateFlow(source, resolved) {
    const diagnostics = [];
    validateSurfaceBodies(source, diagnostics);
    validateOwnerAgentAttachments(source, diagnostics);
    validateTopology(source, diagnostics);
    validateUnusedEntities(source, resolved, diagnostics);
    return diagnostics;
}
// ---------------------------------------------------------------------------
// Surface rules (backend SurfaceValidator mirror)
// ---------------------------------------------------------------------------
/** Stable identity of a reference for duplicate detection. */
function refIdentity(ref) {
    return typeof ref === 'string' ? `local:${ref}` : `existing:${ref.existing}`;
}
function describeRef(ref) {
    return typeof ref === 'string' ? `'${ref}'` : `existing '${ref.existing}'`;
}
function validateSurfaceBodies(source, diagnostics) {
    for (const [surfaceName, surface] of Object.entries(source.surfaces)) {
        validateSurfaceBody(source, surface, `surfaces.${surfaceName}`, diagnostics);
    }
    for (const [nodeName, node] of Object.entries(source.flow.nodes)) {
        if ((node.type === 'agent' || node.type === 'task') && node.inline_surface !== undefined) {
            validateSurfaceBody(source, node.inline_surface, `flow.nodes.${nodeName}.inline_surface`, diagnostics);
        }
        // Runtime contract: an AgentNode without tasks fails at execution with
        // "AgentNode '<name>' has no tasks to execute" — catch it at build time.
        if (node.type === 'agent' && node.tasks.length === 0) {
            diagnostics.push(makeError(`flow.nodes.${nodeName}.tasks`, `agent node '${nodeName}' has no tasks — the runtime requires at least one. ` +
                `Add a tasks: list (instructions), or use a 'task' node instead.`));
        }
    }
}
function validateSurfaceBody(source, surface, basePath, diagnostics) {
    reportDuplicates(surface.python_tools.map((entry) => entry.tool), `${basePath}.python_tools`, 'tool', diagnostics);
    reportDuplicates(surface.mcp_tools.map((entry) => entry.tool), `${basePath}.mcp_tools`, 'tool', diagnostics);
    reportDuplicates(surface.knowledge.map((entry) => entry.collection), `${basePath}.knowledge`, 'knowledge collection', diagnostics);
    surface.knowledge.forEach((entry, index) => {
        const entryPath = `${basePath}.knowledge[${index}]`;
        const configuredStrategy = entry.naive_config !== undefined
            ? { field: 'naive_config', expects: 'naive' }
            : entry.graph_basic_config !== undefined
                ? { field: 'graph_basic_config', expects: 'graph' }
                : entry.graph_local_search_config !== undefined
                    ? { field: 'graph_local_search_config', expects: 'graph' }
                    : undefined;
        if (configuredStrategy === undefined) {
            return;
        }
        if (typeof entry.collection !== 'string') {
            diagnostics.push(makeWarning(`${entryPath}.${configuredStrategy.field}`, `cannot verify locally that existing collection '${entry.collection.existing}' uses ` +
                `${configuredStrategy.expects} RAG — the backend will reject the surface if it does not`));
            return;
        }
        const collection = source.knowledge[entry.collection];
        if (collection === undefined) {
            return; // unresolved reference — already an error from the resolver
        }
        if (collection.rag.strategy !== configuredStrategy.expects) {
            diagnostics.push(makeError(`${entryPath}.${configuredStrategy.field}`, `${configuredStrategy.field} requires ${configuredStrategy.expects} RAG, but collection ` +
                `'${entry.collection}' uses the '${collection.rag.strategy}' strategy`));
        }
    });
}
function reportDuplicates(refs, basePath, noun, diagnostics) {
    const seen = new Map();
    refs.forEach((ref, index) => {
        const identity = refIdentity(ref);
        const firstIndex = seen.get(identity);
        if (firstIndex !== undefined) {
            diagnostics.push(makeError(`${basePath}[${index}]`, `duplicate ${noun} ${describeRef(ref)} in this surface (first at ${basePath}[${firstIndex}])`));
            return;
        }
        seen.set(identity, index);
    });
}
// ---------------------------------------------------------------------------
// owner_agent attachment rule
// ---------------------------------------------------------------------------
function validateOwnerAgentAttachments(source, diagnostics) {
    for (const [surfaceName, surface] of Object.entries(source.surfaces)) {
        if (surface.owner_agent === undefined) {
            continue;
        }
        const owner = surface.owner_agent;
        // Attachments via agents.<name>.default_surfaces
        for (const [agentName, agent] of Object.entries(source.agents)) {
            agent.default_surfaces.forEach((entry, index) => {
                if (entry.surface !== surfaceName) {
                    return; // only local references to THIS surface matter here
                }
                const attachPath = `agents.${agentName}.default_surfaces[${index}].surface`;
                if (typeof owner !== 'string') {
                    diagnostics.push(makeWarning(attachPath, `surface '${surfaceName}' is owned by existing agent '${owner.existing}' — ` +
                        `cannot verify locally that '${agentName}' is that agent`));
                }
                else if (agentName !== owner) {
                    diagnostics.push(makeError(attachPath, `surface '${surfaceName}' is owned by agent '${owner}' and can only be attached to that agent`));
                }
            });
        }
        // Attachments via agent/task node surface lists
        for (const [nodeName, node] of Object.entries(source.flow.nodes)) {
            if (node.type !== 'agent' && node.type !== 'task') {
                continue;
            }
            node.surfaces.forEach((ref, index) => {
                if (ref !== surfaceName) {
                    return;
                }
                const attachPath = `flow.nodes.${nodeName}.surfaces[${index}]`;
                if (typeof owner !== 'string') {
                    diagnostics.push(makeWarning(attachPath, `surface '${surfaceName}' is owned by existing agent '${owner.existing}' — ` +
                        `cannot verify locally that node '${nodeName}' runs that agent`));
                }
                else if (typeof node.agent !== 'string') {
                    diagnostics.push(makeWarning(attachPath, `surface '${surfaceName}' is owned by agent '${owner}' — cannot verify locally ` +
                        `that existing agent '${node.agent.existing}' is that agent`));
                }
                else if (node.agent !== owner) {
                    diagnostics.push(makeError(attachPath, `surface '${surfaceName}' is owned by agent '${owner}', but node '${nodeName}' ` +
                        `runs agent '${node.agent}'`));
                }
            });
        }
    }
}
// ---------------------------------------------------------------------------
// Flow topology
// ---------------------------------------------------------------------------
function validateTopology(source, diagnostics) {
    const nodes = source.flow.nodes;
    // Case-insensitive node-name collisions (exact duplicates cannot survive loading).
    const namesByLowercase = new Map();
    for (const nodeName of Object.keys(nodes)) {
        const lower = nodeName.toLowerCase();
        const first = namesByLowercase.get(lower);
        if (first !== undefined) {
            diagnostics.push(makeError(`flow.nodes.${nodeName}`, `node name '${nodeName}' collides with '${first}' (node names must be unique ignoring case)`));
            continue;
        }
        namesByLowercase.set(lower, nodeName);
    }
    const hasTrigger = Object.values(nodes).some((node) => TRIGGER_NODE_TYPES.has(node.type));
    if (!hasTrigger) {
        diagnostics.push(makeWarning('flow.nodes', 'flow has no start or trigger node (start / webhook-trigger / telegram-trigger / schedule-trigger) — it can never run'));
    }
    source.flow.edges.forEach((edge, index) => {
        const edgePath = `flow.edges[${index}]`;
        const fromNode = nodes[edge.from];
        if (fromNode !== undefined) {
            if (fromNode.type === 'end') {
                diagnostics.push(makeError(`${edgePath}.from`, `'${edge.from}' is an end node — end nodes have no outgoing edges`));
            }
            else if (fromNode.type === 'note') {
                diagnostics.push(makeError(`${edgePath}.from`, `'${edge.from}' is a note — notes are not connectable`));
            }
        }
        if (edge.to === undefined) {
            return; // conditional edge — target is decided by its Python code at run time
        }
        if (edge.to === edge.from) {
            diagnostics.push(makeError(`${edgePath}.to`, `self-loop: edge from '${edge.from}' to itself`));
        }
        const toNode = nodes[edge.to];
        if (toNode !== undefined) {
            if (TRIGGER_NODE_TYPES.has(toNode.type)) {
                diagnostics.push(makeError(`${edgePath}.to`, `'${edge.to}' is a ${toNode.type} node — start and trigger nodes have no incoming edges`));
            }
            else if (toNode.type === 'note') {
                diagnostics.push(makeError(`${edgePath}.to`, `'${edge.to}' is a note — notes are not connectable`));
            }
        }
    });
    for (const [nodeName, node] of Object.entries(nodes)) {
        const nodePath = `flow.nodes.${nodeName}`;
        if (node.type === 'task' && node.task.trim() === '') {
            diagnostics.push(makeError(`${nodePath}.task`, 'task text must not be blank'));
        }
        if (node.type === 'crew' && node.crew === undefined) {
            diagnostics.push(makeError(`${nodePath}.crew`, 'crew node needs a crew reference ({existing: "<remote crew name>"}) — there is nothing to run without one'));
        }
        if (node.type === 'decision-table') {
            node.rules.forEach((rule, index) => {
                if (rule.next_node === nodeName) {
                    diagnostics.push(makeError(`${nodePath}.rules[${index}].next_node`, `self-loop: rule routes back to '${nodeName}'`));
                }
            });
            if (node.default_next_node === nodeName) {
                diagnostics.push(makeError(`${nodePath}.default_next_node`, `self-loop: default route back to '${nodeName}'`));
            }
        }
        if (node.type === 'classification-decision-table') {
            node.categories.forEach((category, index) => {
                if (category.next_node === nodeName) {
                    diagnostics.push(makeError(`${nodePath}.categories[${index}].next_node`, `self-loop: category routes back to '${nodeName}'`));
                }
            });
            if (node.default_next_node === nodeName) {
                diagnostics.push(makeError(`${nodePath}.default_next_node`, `self-loop: default route back to '${nodeName}'`));
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Unused local entities
// ---------------------------------------------------------------------------
/** Sections whose local definitions must be referenced from somewhere to be useful. */
const REFERENCEABLE_SECTIONS = [
    'llm_configs',
    'tools.tool_configs',
    'tools.python_code_tools',
    'tools.mcp_tools',
    'knowledge',
    'surfaces',
    'agents',
];
function validateUnusedEntities(source, resolved, diagnostics) {
    const used = new Set();
    for (const reference of resolved.references) {
        if (reference.ref.kind === 'local') {
            used.add(`${reference.section}.${reference.ref.name}`);
        }
    }
    for (const section of REFERENCEABLE_SECTIONS) {
        for (const name of resolved.symbols[section]) {
            if (!used.has(`${section}.${name}`)) {
                diagnostics.push(makeWarning(`${section}.${name}`, `'${section}.${name}' is defined but never referenced`));
            }
        }
    }
}
