import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { compileFlow } from '../compiler/index.js';
import { hasErrors } from '../flow-source/diagnostics.js';
import { createLock, getEntity, readLock, writeLock } from '../flow-source/lockfile.js';
import { EntityPusher } from '../pusher/entities.js';
import { GraphPusher } from '../pusher/graph.js';
import { err, ok, toContent } from '../util/result.js';
import { runTool } from './auth-org.tools.js';
/**
 * Flow lifecycle tools — the write → build → test loop:
 * init_flow (scaffold) → validate_flow / build_flow (pure local compile) →
 * diff_flow (dry run) → push_flow (materialize on EpicStaff).
 */
const FLOW_TEMPLATE = `# EpicStaff flow source — edit and push with push_flow.
# Reuse-first: check list_agents / list_surfaces / list_llm_configs before
# defining new entities; reference remote ones with { existing: "<name>" }.

meta:
  name: my-flow
  description: Describe what this flow does.

llm_configs:
  default:
    model: gpt-4o

agents:
  assistant:
    instructions: You are a helpful assistant.
    llm_config: default

flow:
  nodes:
    start:
      type: start
    work:
      type: agent
      agent: assistant
    finish:
      type: end
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`;
export function registerFlowTools(server, context) {
    server.registerTool('init_flow', {
        title: 'Scaffold a new flow source',
        description: 'Create a new flow-source directory with a starter flow.yaml. The flow is then edited as files ' +
            '(write), compiled locally (build_flow), and pushed to EpicStaff (push_flow).',
        inputSchema: {
            flow_dir: z.string().describe('Absolute path of the flow directory to create'),
        },
    }, async ({ flow_dir }) => runTool(async () => {
        const flowFile = join(flow_dir, 'flow.yaml');
        if (existsSync(flowFile)) {
            throw new Error(`${flowFile} already exists — edit it directly or pick another directory.`);
        }
        mkdirSync(flow_dir, { recursive: true });
        writeFileSync(flowFile, FLOW_TEMPLATE);
        return {
            created: flowFile,
            next: 'Edit flow.yaml (see the schema docs), then validate_flow → push_flow.',
        };
    }));
    server.registerTool('validate_flow', {
        title: 'Validate flow source',
        description: 'Parse and validate a flow-source directory — schema, references, node rules, surface/RAG pairing. ' +
            'Pure local, no network. Returns compiler-style diagnostics with source locations.',
        inputSchema: {
            flow_dir: z.string().describe('Absolute path of the flow directory'),
        },
    }, async ({ flow_dir }) => {
        const artifact = await compileFlow(flow_dir);
        const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        const warnings = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
        if (errors.length > 0) {
            return toContent(err(`${errors.length} error(s) in flow source`, {
                validationErrors: errors.map((diagnostic) => ({
                    field: diagnostic.path,
                    value: diagnostic.file ?? null,
                    reason: diagnostic.message,
                })),
                hint: 'Fix the listed paths in the flow source files, then validate again.',
            }));
        }
        return toContent(ok({ valid: true, warnings }));
    });
    server.registerTool('build_flow', {
        title: 'Build flow (compile + layout)',
        description: 'Full local build: validate, resolve references, compute the deterministic auto-layout (same algorithm ' +
            'as the EpicStaff editor), and produce the push plan. Pure local, no network. ' +
            'Returns the build report: entities to create/update/reuse, nodes with computed positions, warnings.',
        inputSchema: {
            flow_dir: z.string().describe('Absolute path of the flow directory'),
        },
    }, async ({ flow_dir }) => runTool(async () => {
        const artifact = await compileFlow(flow_dir);
        if (hasErrors(artifact.diagnostics)) {
            throw new Error(`Build failed with ${artifact.diagnostics.filter((d) => d.severity === 'error').length} error(s) — run validate_flow for details.`);
        }
        return {
            flowName: artifact.flowName,
            summary: artifact.summary,
            entities: artifact.entities.map((plan) => ({ key: plan.key, kind: plan.kind, action: plan.action })),
            nodes: artifact.graph.nodes.map((node) => ({
                name: node.node_name,
                type: node.type,
                position: node.position,
            })),
            edges: artifact.graph.edges.length,
            diagnostics: artifact.diagnostics,
        };
    }));
    server.registerTool('diff_flow', {
        title: 'Diff flow vs remote (dry run)',
        description: 'Show what push_flow would do without changing anything: which entities would be created, updated, ' +
            'reused, or resolved from existing remote ones, and whether the remote graph changed since the last push.',
        inputSchema: {
            flow_dir: z.string().describe('Absolute path of the flow directory'),
        },
    }, async ({ flow_dir }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const artifact = await compileFlow(flow_dir);
        if (hasErrors(artifact.diagnostics)) {
            throw new Error('Flow source has errors — run validate_flow first.');
        }
        const lock = (await readLock(flow_dir)) ?? createLock(artifact.flowName);
        const entityPlan = artifact.entities.map((plan) => {
            if (plan.action === 'resolve-existing') {
                return { key: plan.key, kind: plan.kind, wouldDo: 'resolve-existing', remoteName: plan.remoteName };
            }
            const entry = getEntity(lock, plan.section, plan.name);
            if (!entry)
                return { key: plan.key, kind: plan.kind, wouldDo: 'create' };
            if (plan.contentHash && entry.contentHash !== plan.contentHash) {
                return { key: plan.key, kind: plan.kind, wouldDo: 'update', backendId: entry.backendId };
            }
            return { key: plan.key, kind: plan.kind, wouldDo: 'reuse', backendId: entry.backendId };
        });
        let graphStatus;
        if (lock.graphId === null) {
            graphStatus = { wouldDo: 'create graph + all nodes/edges' };
        }
        else {
            const { GraphsApi } = await import('../api/graphs.js');
            const remoteDto = await new GraphsApi(context.client).get(lock.graphId);
            graphStatus = {
                graphId: lock.graphId,
                remoteSaveVersion: remoteDto.save_version,
                lockSaveVersion: lock.saveVersion,
                conflict: lock.saveVersion > 0 && remoteDto.save_version !== lock.saveVersion
                    ? 'REMOTE CHANGED since last push — pull_flow first, or push with force'
                    : null,
            };
        }
        return { entities: entityPlan, graph: graphStatus };
    }));
    server.registerTool('push_flow', {
        title: 'Push flow to EpicStaff',
        description: 'Build the flow and materialize it on EpicStaff: upsert the entity dependency tree in order ' +
            '(llm-configs → tools → knowledge+documents+RAG → surfaces → agent-definitions), then create/update the ' +
            'graph via bulk-save with the computed layout. Repush updates in place (lockfile identity mapping) — ' +
            'never duplicates. Fails on remote save_version conflict unless force is set.',
        inputSchema: {
            flow_dir: z.string().describe('Absolute path of the flow directory'),
            force: z
                .boolean()
                .optional()
                .describe('Overwrite remote graph changes on save_version conflict (default false)'),
        },
    }, async ({ flow_dir, force }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const artifact = await compileFlow(flow_dir);
        if (hasErrors(artifact.diagnostics)) {
            const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
            throw new Error(`Flow source has ${errors.length} error(s) — first: ${errors[0].path}: ${errors[0].message}`);
        }
        let lock = (await readLock(flow_dir)) ?? createLock(artifact.flowName);
        const entityPusher = new EntityPusher(context);
        const entityResult = await entityPusher.push(artifact, lock);
        lock = entityResult.lock;
        // Persist entity progress immediately — a later graph failure must not orphan created entities.
        await writeLock(flow_dir, lock);
        const graphPusher = new GraphPusher(context);
        const graphResult = await graphPusher.push(artifact, lock, entityResult.idMap, { force });
        lock = graphResult.lock;
        await writeLock(flow_dir, lock);
        return {
            graphId: graphResult.graphId,
            saveVersion: graphResult.saveVersion,
            createdGraph: graphResult.createdGraph,
            entities: entityResult.actions,
            nodes: graphResult.nodeActions,
            openInEditor: `${context.config.apiUrl.replace(/\/api\/$/, '')}/flows/${graphResult.graphId}`,
            next: 'Open the flow in the EpicStaff editor to inspect it, or run_flow to execute it.',
        };
    }));
}
