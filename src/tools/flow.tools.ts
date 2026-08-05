import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import { GraphsApi } from '../api/graphs.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { LlmApi } from '../api/llm.js';
import { SurfacesApi } from '../api/surfaces.js';
import { ToolsApi } from '../api/tools.js';
import { compileFlow } from '../compiler/index.js';
import { decompileFlow } from '../flow-source/decompiler.js';
import { hasErrors } from '../flow-source/diagnostics.js';
import { createLock, getEntity, readLock, writeLock } from '../flow-source/lockfile.js';
import { buildBulkSavePayload } from '../graph/bulk-save.js';
import type { GraphState } from '../graph/graph-state.js';
import { buildRemoteState } from '../graph/remote-state.js';
import type { GraphDto } from '../models/graph.js';
import { EntityPusher } from '../pusher/entities.js';
import { resolveFlowRefs } from '../pusher/flow-refs.js';
import { GraphPusher } from '../pusher/graph.js';
import { prepareRestoreState } from '../pusher/restore.js';
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

export function registerFlowTools(server: McpServer, context: AppContext): void {
  server.registerTool(
    'init_flow',
    {
      title: 'Scaffold a new flow source',
      description:
        'Create a new flow-source directory with a starter flow.yaml. The flow is then edited as files ' +
        '(write), compiled locally (build_flow), and pushed to EpicStaff (push_flow).',
      inputSchema: {
        flow_dir: z.string().describe('Absolute path of the flow directory to create'),
      },
    },
    async ({ flow_dir }) =>
      runTool(async () => {
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
      }),
  );

  server.registerTool(
    'validate_flow',
    {
      title: 'Validate flow source',
      description:
        'Parse and validate a flow-source directory — schema, references, node rules, surface/RAG pairing. ' +
        'Pure local, no network. Returns compiler-style diagnostics with source locations.',
      inputSchema: {
        flow_dir: z.string().describe('Absolute path of the flow directory'),
      },
    },
    async ({ flow_dir }) => {
      const artifact = await compileFlow(flow_dir);
      const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      const warnings = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
      if (errors.length > 0) {
        return toContent(
          err(`${errors.length} error(s) in flow source`, {
            validationErrors: errors.map((diagnostic) => ({
              field: diagnostic.path,
              value: diagnostic.file ?? null,
              reason: diagnostic.message,
            })),
            hint: 'Fix the listed paths in the flow source files, then validate again.',
          }),
        );
      }
      return toContent(ok({ valid: true, warnings }));
    },
  );

  server.registerTool(
    'build_flow',
    {
      title: 'Build flow (compile + layout)',
      description:
        'Full local build: validate, resolve references, compute the deterministic auto-layout (same algorithm ' +
        'as the EpicStaff editor), and produce the push plan. Pure local, no network. ' +
        'Returns the build report: entities to create/update/reuse, nodes with computed positions, warnings.',
      inputSchema: {
        flow_dir: z.string().describe('Absolute path of the flow directory'),
      },
    },
    async ({ flow_dir }) =>
      runTool(async () => {
        const artifact = await compileFlow(flow_dir);
        if (hasErrors(artifact.diagnostics)) {
          throw new Error(
            `Build failed with ${artifact.diagnostics.filter((d) => d.severity === 'error').length} error(s) — run validate_flow for details.`,
          );
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
      }),
  );

  server.registerTool(
    'dump_graph',
    {
      title: 'Dump a graph\'s complete raw backend JSON (faithful backup)',
      description:
        "Write a graph's ENTIRE backend representation to a local .json file, verbatim. Unlike pull_flow — " +
        'which projects the graph through the flow-source compiler and silently discards every field flow ' +
        'source cannot express (end-node output_map, classification-decision-table prompt_configs and route ' +
        'codes, python stream_config/test_input, task output_schema, error routes) — this filters nothing. ' +
        'That makes it the only faithful snapshot of a graph, and the right thing to take before editing a ' +
        'production flow. Read-only against the backend: it never writes to EpicStaff. The output is an ' +
        'archival record for diffing and manual restore, not a pushable flow source.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the graph to dump'),
        output_path: z.string().describe('Absolute path of the .json file to write (parent dirs are created)'),
      },
    },
    async ({ graph_id, output_path }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();

        if (!isAbsolute(output_path)) {
          throw new Error('output_path must be an absolute path to a .json file.');
        }

        // The client returns the parsed response verbatim, so this object is the
        // complete backend payload — GraphDto is only a compile-time view of it.
        const dto = (await new GraphsApi(context.client).get(graph_id)) as unknown as Record<string, unknown>;

        const body = `${JSON.stringify(dto, null, 2)}\n`;
        mkdirSync(dirname(output_path), { recursive: true });
        writeFileSync(output_path, body, 'utf8');

        // Count nodes per *_node_list / *_list key so the caller can sanity-check coverage,
        // and report which normally-lossy settings this snapshot actually captured.
        const nodes: Record<string, number> = {};
        for (const [key, value] of Object.entries(dto)) {
          if (/_(node_)?list$/.test(key) && Array.isArray(value) && value.length > 0) {
            nodes[key] = value.length;
          }
        }

        const lossyFieldsCaptured: string[] = [];
        const seen = new Set<string>();
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
          }
          if (value === null || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (
              ['output_map', 'prompt_configs', 'stream_config', 'output_schema', 'test_input'].includes(key) &&
              child != null &&
              !(Array.isArray(child) && child.length === 0) &&
              !(typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0)
            ) {
              if (!seen.has(key)) {
                seen.add(key);
                lossyFieldsCaptured.push(key);
              }
            }
            walk(child);
          }
        };
        walk(dto);

        return {
          output_path,
          graph_id,
          graph_name: dto.name,
          save_version: dto.save_version,
          bytes: body.length,
          nodes,
          edges: Array.isArray(dto.edge_list) ? dto.edge_list.length : 0,
          conditional_edges: Array.isArray(dto.conditional_edge_list) ? dto.conditional_edge_list.length : 0,
          lossyFieldsCaptured: lossyFieldsCaptured.sort(),
          next:
            'Archival snapshot — restore by hand in the editor, or diff against a later dump. ' +
            'pull_flow remains the way to get an editable flow source (lossy by design).',
        };
      }),
  );

  server.registerTool(
    'restore_graph',
    {
      title: 'Restore a dump_graph JSON into a NEW graph (faithful copy)',
      description:
        'Materialize a dump_graph snapshot as a brand-new graph, preserving the settings flow source ' +
        'cannot express — end-node output_map, classification prompt_configs and route codes, python ' +
        'stream_config/test_input, task output_schema, and error routes. Use it to make a restorable ' +
        'backup, or to clone a flow when the backend copy/export endpoints mishandle classification and ' +
        'agent nodes. Always CREATES a new graph; it never overwrites an existing one, so it cannot ' +
        'damage the source. Org-level entities (agent definitions, llm configs, surfaces) are referenced, ' +
        'not duplicated — but node-owned rows (python code, agent sub-tasks) are detached so editing the ' +
        'copy can never change the original.',
      inputSchema: {
        dump_path: z.string().describe('Absolute path of a JSON file previously written by dump_graph'),
        name: z.string().optional().describe('Name for the new graph (required unless target_graph_id is given)'),
        description: z.string().optional().describe('Description for the new graph'),
        target_graph_id: z
          .number()
          .int()
          .optional()
          .describe(
            'OVERWRITE an existing graph instead of creating one: every current node/edge is deleted and ' +
              'replaced by the dump in a single bulk-save. Destructive — dump the target first.',
          ),
      },
    },
    async ({ dump_path, name, description, target_graph_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();

        if (!isAbsolute(dump_path)) throw new Error('dump_path must be an absolute path.');
        if (!existsSync(dump_path)) throw new Error(`No dump file at ${dump_path} — run dump_graph first.`);

        let dto: GraphDto;
        try {
          dto = JSON.parse(readFileSync(dump_path, 'utf8')) as GraphDto;
        } catch (error) {
          throw new Error(`${dump_path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
        }
        if (dto == null || typeof dto !== 'object' || !Array.isArray(dto.edge_list)) {
          throw new Error(`${dump_path} does not look like a dump_graph snapshot (no edge_list).`);
        }

        const { state, detached, remappedUuids, warnings } = prepareRestoreState(dto);

        const source = dto as unknown as { metadata?: Record<string, unknown>; tags?: string[]; label_ids?: number[] };
        const graphs = new GraphsApi(context.client);

        // Two modes. Creating starts from an empty `remote` so everything is a create.
        // Overwriting passes the target's CURRENT state as `remote`, so the differ marks
        // every existing node toDelete and every restored node toCreate — one atomic save.
        let targetId: number;
        let targetName: string;
        let baseSaveVersion: number;
        let remote: { nodes: GraphState['nodes']; edges: GraphState['edges'] };
        let createdGraph = false;
        let replaced = 0;

        if (target_graph_id != null) {
          const targetDto = await graphs.get(target_graph_id);
          remote = buildRemoteState(targetDto);
          targetId = target_graph_id;
          targetName = targetDto.name;
          baseSaveVersion = targetDto.save_version;
          replaced = remote.nodes.length;
          if (target_graph_id === dto.id) {
            warnings.push(`Target graph ${target_graph_id} IS the dump's source — this resets it to the snapshot.`);
          }
        } else {
          if (!name) throw new Error('name is required when target_graph_id is not given.');
          const shell = await graphs.create({
            name,
            description:
              description ?? `Faithful restore of "${dto.name}" (graph ${dto.id}) @ save_version ${dto.save_version}.`,
            // Carry the source's own graph-level metadata rather than a fresh scaffold,
            // so a dump of the restore diffs clean against the dump it came from.
            metadata: source.metadata ?? {},
            ...(source.tags && source.tags.length > 0 ? { tags: source.tags } : {}),
          });
          targetId = shell.id;
          targetName = name;
          baseSaveVersion = shell.save_version;
          remote = { nodes: [], edges: [] };
          createdGraph = true;
        }

        let saved;
        try {
          saved = await graphs.bulkSave(
            targetId,
            buildBulkSavePayload({ graphId: targetId, desired: state, remote, saveVersion: baseSaveVersion }),
          );
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(
            createdGraph
              ? `Graph shell #${targetId} ("${targetName}") was created but bulk-save failed, so it is empty — ` +
                `delete it and retry. Cause: ${cause}`
              : `Overwrite of graph #${targetId} ("${targetName}") failed; it is unchanged. Cause: ${cause}`,
          );
        }

        // Labels are not part of the create body, so they need a follow-up PATCH.
        // Non-fatal: the graph content is already correct without them.
        const labelIds = source.label_ids ?? [];
        let labelsCopied = false;
        if (labelIds.length > 0 && createdGraph) {
          try {
            // PATCH is optimistically locked like bulk-save — save_version is mandatory.
            await context.client.patch(`graphs/${targetId}/`, {
              body: { save_version: saved.save_version, label_ids: labelIds },
            });
            labelsCopied = true;
          } catch (error) {
            warnings.push(
              `Could not copy label_ids ${JSON.stringify(labelIds)}: ` +
                `${error instanceof Error ? error.message : String(error)}. Set them by hand if you need them.`,
            );
          }
        }

        return {
          graphId: targetId,
          name: targetName,
          mode: createdGraph ? 'created' : 'overwritten',
          replacedNodes: replaced,
          saveVersion: saved.save_version,
          labels: { source: labelIds, copied: labelsCopied },
          restoredFrom: { graph_id: dto.id, graph_name: dto.name, save_version: dto.save_version, dump_path },
          nodes: state.nodes.length,
          edges: state.edges.length,
          detached,
          remappedUuids,
          warnings,
          openInEditor: `${context.config.apiUrl.replace(/\/api\/$/, '')}/flows/${targetId}`,
          next: 'Verify with dump_graph on the new graph and diff it against the source dump.',
        };
      }),
  );

  server.registerTool(
    'diff_flow',
    {
      title: 'Diff flow vs remote (dry run)',
      description:
        'Show what push_flow would do without changing anything: which entities would be created, updated, ' +
        'reused, or resolved from existing remote ones, and whether the remote graph changed since the last push.',
      inputSchema: {
        flow_dir: z.string().describe('Absolute path of the flow directory'),
      },
    },
    async ({ flow_dir }) =>
      runTool(async () => {
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
          if (!entry) return { key: plan.key, kind: plan.kind, wouldDo: 'create' };
          if (plan.contentHash && entry.contentHash !== plan.contentHash) {
            return { key: plan.key, kind: plan.kind, wouldDo: 'update', backendId: entry.backendId };
          }
          return { key: plan.key, kind: plan.kind, wouldDo: 'reuse', backendId: entry.backendId };
        });

        let graphStatus: Record<string, unknown>;
        if (lock.graphId === null) {
          graphStatus = { wouldDo: 'create graph + all nodes/edges' };
        } else {
          const { GraphsApi } = await import('../api/graphs.js');
          const remoteDto = await new GraphsApi(context.client).get(lock.graphId);
          graphStatus = {
            graphId: lock.graphId,
            remoteSaveVersion: remoteDto.save_version,
            lockSaveVersion: lock.saveVersion,
            conflict:
              lock.saveVersion > 0 && remoteDto.save_version !== lock.saveVersion
                ? 'REMOTE CHANGED since last push — pull_flow first, or push with force'
                : null,
          };
        }

        return { entities: entityPlan, graph: graphStatus };
      }),
  );

  server.registerTool(
    'push_flow',
    {
      title: 'Push flow to EpicStaff',
      description:
        'Build the flow and materialize it on EpicStaff: upsert the entity dependency tree in order ' +
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
    },
    async ({ flow_dir, force }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();

        const artifact = await compileFlow(flow_dir);
        if (hasErrors(artifact.diagnostics)) {
          const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          throw new Error(
            `Flow source has ${errors.length} error(s) — first: ${errors[0]!.path}: ${errors[0]!.message}`,
          );
        }

        let lock = (await readLock(flow_dir)) ?? createLock(artifact.flowName);

        const entityPusher = new EntityPusher(context);
        const entityResult = await entityPusher.push(artifact, lock);
        lock = entityResult.lock;
        // Persist entity progress immediately — a later graph failure must not orphan created entities.
        await writeLock(flow_dir, lock);

        // Subgraph refs carry no EntityPlan, so the entity pusher never saw them. Resolve
        // them against the backend graph list / sibling lockfiles before substitution.
        const flowRefs = await resolveFlowRefs(artifact, flow_dir, context);
        for (const [refKey, graphId] of flowRefs) {
          entityResult.idMap.set(refKey, graphId);
        }

        const graphPusher = new GraphPusher(context);
        const graphResult = await graphPusher.push(artifact, lock, entityResult.idMap, {
          force,
          persistLock: (partial) => writeLock(flow_dir, partial),
        });
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
      }),
  );

  server.registerTool(
    'provision_knowledge',
    {
      title: 'Provision knowledge collections early (start indexing ahead of push)',
      description:
        'Materialize ONLY the flow\'s knowledge collections (and the llm-configs they depend on) and kick off ' +
        'RAG indexing — without touching the graph or the rest of the entity tree. Indexing is slow and async, ' +
        'so run this as soon as the flow\'s knowledge section is authored and frozen, then keep building the ' +
        'flow in parallel. The later push_flow reuses these collections (identical content hash → not re-indexed), ' +
        'and wait_for_collections joins on the indexing you started here. Uses the same lockfile as push_flow.',
      inputSchema: {
        flow_dir: z.string().describe('Absolute path of the flow directory'),
      },
    },
    async ({ flow_dir }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();

        const artifact = await compileFlow(flow_dir);
        if (hasErrors(artifact.diagnostics)) {
          const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          throw new Error(
            `Flow source has ${errors.length} error(s) — first: ${errors[0]!.path}: ${errors[0]!.message}`,
          );
        }

        let lock = (await readLock(flow_dir)) ?? createLock(artifact.flowName);

        const entityResult = await new EntityPusher(context).push(artifact, lock, {
          sections: ['llm_configs', 'knowledge'],
        });
        lock = entityResult.lock;
        await writeLock(flow_dir, lock);

        const collections = entityResult.actions
          .filter((action) => action.kind === 'knowledge_collection')
          .map((action) => {
            const plan = artifact.entities.find((entity) => entity.key === action.key);
            const ragEntry = plan ? getEntity(lock, plan.section, `${plan.name}#rag`) : undefined;
            return {
              name: plan?.name ?? action.key,
              collectionId: action.backendId,
              ragId: ragEntry?.backendId ?? null,
              ragType: plan?.rag?.strategy ?? null,
            };
          });

        return {
          collections,
          indexingStarted: true,
          next: 'Author/build the rest of the flow, then push_flow (these collections will be reused, not re-indexed), then wait_for_collections before running.',
        };
      }),
  );

  server.registerTool(
    'pull_flow',
    {
      title: 'Pull a remote flow into local flow source',
      description:
        'Import an existing EpicStaff flow (graph) into a local flow-source directory so it can be edited and ' +
        'repushed: writes flow.yaml with every node, edge and pinned canvas position, plus a seeded flow.lock.json ' +
        'so push_flow updates the same graph in place. Referenced entities (agents, surfaces, llm configs, tools, ' +
        'knowledge collections) are written as {existing: "<name>"} references — they stay owned by the backend. ' +
        'Refuses to overwrite an existing flow source.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the graph to pull (see list output of graph-light)'),
        target_dir: z
          .string()
          .describe('Absolute path of the flow directory to create — must not already contain a flow source'),
      },
    },
    async ({ graph_id, target_dir }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();

        const { files, warnings } = await decompileFlow(
          {
            graphs: new GraphsApi(context.client),
            agentDefinitions: new AgentDefinitionsApi(context.client),
            surfaces: new SurfacesApi(context.client),
            llm: new LlmApi(context.client),
            tools: new ToolsApi(context.client),
            knowledge: new KnowledgeApi(context.client),
          },
          graph_id,
          target_dir,
        );

        return {
          files,
          warnings,
          next: 'Run diff_flow to verify a no-op baseline, then edit with es-write-flow.',
        };
      }),
  );
}
