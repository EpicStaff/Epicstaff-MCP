import type { AppContext } from '../context.js';
import type { BuildArtifact } from '../compiler/artifact.js';
import { substituteRefs } from '../compiler/artifact.js';
import type { ConditionalEdgePlan } from '../compiler/emit.js';
import { GraphsApi } from '../api/graphs.js';
import {
  type FlowLock,
  contentHash,
  getEntity,
  isEntityDirty,
  removeEntity,
  setEntity,
} from '../flow-source/lockfile.js';
import type { GraphNode, GraphState } from '../graph/graph-state.js';
import type { AgentNodeTaskUi } from '../models/nodes/agent-node.js';
import { buildBulkSavePayload } from '../graph/bulk-save.js';
import { buildRemoteState, collectOrphanEdgeIds } from '../graph/remote-state.js';
import { applySaveResponse } from '../graph/temp-id.js';
import type { BulkSavePayload, GraphDto } from '../models/graph.js';
import { ApiError } from '../http/errors.js';
import { logger } from '../util/logger.js';

/**
 * Graph pusher — persists the desired GraphState via the bulk-save protocol
 * (save_version optimistic lock, temp_id round-trip), plus conditional edges
 * through their dedicated endpoints (they are NOT part of bulk-save, matching
 * the frontend). Node backend ids are tracked in the lockfile under the
 * `nodes.<node_name>` keys so a repush updates instead of duplicating.
 */
const NODE_SECTION = 'nodes';
const CONDITIONAL_EDGE_SECTION = 'conditional_edges';

export interface GraphPushResult {
  graphId: number;
  saveVersion: number;
  lock: FlowLock;
  createdGraph: boolean;
  /** False when the computed diff was empty and the bulk save was skipped (save_version unchanged). */
  changed: boolean;
  nodeActions: { created: number; updated: number; deleted: number; updatedNodes: string[] };
  warnings: string[];
}

/**
 * The graph a lockfile points at no longer exists (deleted in the editor, or the lockfile came
 * from another EpicStaff instance). Returns a lock that recreates it: no graph id, no node or
 * conditional-edge ids (they belonged to the dead graph), save_version reset. Entity entries
 * are kept here — the entity pusher re-verifies them (see EntityPusher `verifyLockedIds`).
 */
export function forgetMissingGraph(lock: FlowLock): FlowLock {
  const entities = Object.fromEntries(
    Object.entries(lock.entities).filter(
      ([key]) => !key.startsWith(`${NODE_SECTION}.`) && !key.startsWith(`${CONDITIONAL_EDGE_SECTION}.`),
    ),
  );
  return { ...lock, graphId: null, saveVersion: 0, entities };
}

export function missingGraphWarning(graphId: number, flowName: string): string {
  return (
    `Graph #${graphId} recorded in flow.lock.json no longer exists (deleted, or the lockfile comes from another ` +
    `EpicStaff instance) — created a new graph for "${flowName}" and re-verified the locked entity ids.`
  );
}

/**
 * Why the graph a lockfile points at may NOT be written by this flow source, or null when it may.
 * Only the remote graph's name proves ownership: it must equal the flow's current `meta.name`.
 * The lockfile's own `flowName` is NOT proof — a copied flow directory carries the original's
 * lockfile, and renaming `meta.name` there must not take over the original's graph. Anything else
 * is refused (even with force) unless the caller explicitly opts into a rename.
 */
export function lockedGraphMismatch(remote: { id: number; name: string }, flowName: string): string | null {
  if (remote.name === flowName) return null;
  return (
    `flow.lock.json points at graph #${remote.id} "${remote.name}", but this flow source is named "${flowName}". ` +
    'Refusing to overwrite that graph — the directory may be a copy of another flow (its lockfile included), or the ' +
    'lockfile may come from another instance. If this IS that flow and you renamed it, push again with ' +
    `rename: true to rename the remote graph to "${flowName}" (or set meta.name back to "${remote.name}"); if it is a ` +
    'different flow, delete flow.lock.json to push it as a new one.'
  );
}

/**
 * Check whether the lockfile's graph still exists and may be written by this flow source. Run by
 * push_flow BEFORE the entity push, so a stale lockfile also makes the entity pusher re-verify its
 * ids, and a lockfile pointing at another flow's graph stops the push before anything is written.
 * With `rename`, a graph whose name differs from meta.name is renamed (PATCH, optimistically locked)
 * and the lock adopts the new name — the explicit opt-in for renaming a flow.
 */
export async function reconcileLockedGraph(
  graphs: GraphsApi,
  lock: FlowLock,
  flowName: string,
  options: { rename?: boolean; force?: boolean } = {},
): Promise<{ lock: FlowLock; warning: string | null; graphMissing: boolean }> {
  if (lock.graphId === null) return { lock: { ...lock, flowName }, warning: null, graphMissing: false };
  let remote: GraphDto;
  try {
    remote = await graphs.get(lock.graphId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      logger.warn(`Locked graph #${lock.graphId} is gone — it will be recreated`);
      return { lock: { ...forgetMissingGraph(lock), flowName }, warning: missingGraphWarning(lock.graphId, flowName), graphMissing: true };
    }
    throw error;
  }
  const mismatch = lockedGraphMismatch(remote, flowName);
  if (mismatch === null) return { lock: { ...lock, flowName }, warning: null, graphMissing: false };
  if (!options.rename) throw new Error(mismatch);
  // rename only for a graph this lockfile demonstrably pushed: a lock with save_version 0 never
  // completed a push (or was written by hand), so it proves nothing about the graph it names.
  if (!options.force && lock.saveVersion === 0) {
    throw new Error(
      `Not renaming graph #${remote.id} "${remote.name}": flow.lock.json records no completed push (save_version 0), ` +
        'so it cannot prove this flow owns that graph. Delete flow.lock.json to push this source as a new flow, or ' +
        'pass force: true together with rename: true if you are certain it is this flow.',
    );
  }
  if (!options.force && remote.save_version !== lock.saveVersion) {
    throw new Error(
      `Not renaming graph #${remote.id}: it changed since the last push (remote save_version ${remote.save_version}, ` +
        `lockfile ${lock.saveVersion}). Pull the remote changes first, or push with force: true.`,
    );
  }
  const renamed = await graphs.rename(remote.id, flowName, remote.save_version);
  logger.info(`Renamed graph #${remote.id} "${remote.name}" → "${flowName}"`);
  return {
    // The rename itself bumps save_version; carry it so the graph push does not see a conflict.
    lock: { ...lock, flowName, saveVersion: lock.saveVersion > 0 ? renamed.save_version : lock.saveVersion },
    warning: `Renamed graph #${remote.id} from "${remote.name}" to "${flowName}" (rename: true).`,
    graphMissing: false,
  };
}

/** True when a bulk-save payload would change nothing: no node items, edges or deletions. */
export function isEmptyBulkSave(payload: BulkSavePayload): boolean {
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'deleted') {
      if (Object.values(value as Record<string, number[]>).some((ids) => ids.length > 0)) return false;
    } else if (Array.isArray(value) && value.length > 0) {
      return false;
    }
  }
  return true;
}

export class GraphPusher {
  private readonly graphs;

  constructor(private readonly context: AppContext) {
    this.graphs = new GraphsApi(context.client);
  }

  async push(
    artifact: BuildArtifact,
    lock: FlowLock,
    idMap: Map<string, number>,
    options: {
      force?: boolean;
      /**
       * Persist the lockfile the moment the graph shell is created, before bulk-save.
       * Without it, a bulk-save failure orphans the shell (its id is lost and the next
       * push hits a name-uniqueness conflict). Supplied by the push_flow tool.
       */
      persistLock?: (lock: FlowLock) => Promise<void>;
    } = {},
  ): Promise<GraphPushResult> {
    let currentLock = lock;
    const warnings: string[] = [];

    // 1. Resolve every entity reference inside the graph to backend ids.
    const desired = substituteRefs(artifact.graph, (refKey) => {
      const id = idMap.get(refKey);
      if (id === undefined) {
        if (refKey.startsWith('flows.')) {
          throw new Error(
            `Graph references subgraph "${refKey}" which was not resolved — the caller must merge ` +
              `resolveFlowRefs() into the idMap before pushing the graph (see pusher/flow-refs.ts).`,
          );
        }
        throw new Error(`Graph references "${refKey}" which was not pushed — compiler ordering bug.`);
      }
      return id;
    }) as GraphState;

    // 2. Ensure the graph shell exists. A locked graph that is gone (404) is recreated rather
    //    than failing the push with a bare HTTP error.
    let remoteDto: GraphDto | null = null;
    let createdGraph = false;
    if (currentLock.graphId !== null) {
      try {
        remoteDto = await this.graphs.get(currentLock.graphId);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
        warnings.push(missingGraphWarning(currentLock.graphId, artifact.flowName));
        logger.warn(`Locked graph #${currentLock.graphId} is gone — recreating it`);
        currentLock = forgetMissingGraph(currentLock);
      }
      // Never bulk-save over a graph that is not this flow's — force does not override this.
      const mismatch = remoteDto ? lockedGraphMismatch(remoteDto, artifact.flowName) : null;
      if (mismatch !== null) throw new Error(mismatch);
    }
    if (remoteDto === null) {
      remoteDto = await this.createGraphShell(artifact);
      currentLock = { ...currentLock, graphId: remoteDto.id };
      createdGraph = true;
      logger.info(`Created graph "${artifact.flowName}" (#${remoteDto.id})`);
      // Persist the shell id immediately so a bulk-save failure below is recoverable
      // (the next push reuses this graph instead of colliding on the unique name).
      await options.persistLock?.(currentLock);
    } else if (
      // 3. Optimistic-lock conflict check against the lockfile's last-known version.
      !options.force &&
      currentLock.saveVersion > 0 &&
      remoteDto.save_version !== currentLock.saveVersion
    ) {
      throw new Error(
        `Remote graph #${remoteDto.id} changed since the last push ` +
          `(remote save_version ${remoteDto.save_version}, lockfile ${currentLock.saveVersion}). ` +
          'Someone edited it in the EpicStaff editor. Use pull_flow to import the remote changes, ' +
          'or push again with force: true to overwrite them.',
      );
    }

    // 4. Give desired nodes their known backend ids from the lockfile, dropping
    //    stale entries whose backend node no longer exists remotely — or whose
    //    TYPE changed.
    //
    //    The type check matters: nodes are diffed per type group (see graph/diff.ts),
    //    so changing a node's type is a delete+create on the backend, not an update.
    //    Inheriting the old id here would make step 6 below take the `node.backendId ??`
    //    branch and record the DEAD id in the lockfile, leaving the graph wired to a
    //    node that no longer exists.
    const remote = buildRemoteState(remoteDto);
    const remoteTypeByBackendId = new Map<number, string>();
    for (const node of remote.nodes) {
      if (node.backendId != null) remoteTypeByBackendId.set(node.backendId, node.type);
    }
    // Remote nodes per (type, node_name). Notes carry no name on the backend, and start/end
    // nodes have fixed names, so only uniquely named nodes take part in name matching.
    const remoteIdsByTypeAndName = new Map<string, number[]>();
    for (const node of remote.nodes) {
      if (node.backendId == null || node.node_name === '') continue;
      const key = `${node.type}\u0000${node.node_name}`;
      remoteIdsByTypeAndName.set(key, [...(remoteIdsByTypeAndName.get(key) ?? []), node.backendId]);
    }
    const duplicateNames = [...remoteIdsByTypeAndName.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([key, ids]) => `${key.split('\u0000')[1]} (${ids.length}×)`);
    if (duplicateNames.length > 0) {
      warnings.push(
        `Remote graph #${remoteDto.id} holds several nodes with the same name: ${duplicateNames.join(', ')}. ` +
          'The copy flow.lock.json points at is kept and updated; the other copies are deleted by this push.',
      );
    }
    const remoteNameById = new Map<number, string>();
    for (const node of remote.nodes) if (node.backendId != null) remoteNameById.set(node.backendId, node.node_name);

    // Resolve each source node's backend id in two passes so no backend node is ever bound to two
    // source nodes.
    //  1. Repair: a lockfile whose ids were scrambled (older pushes mapped created nodes
    //     positionally, see applySaveResponse) — when the locked id names another node and exactly
    //     one remote node of this type carries this node's name, that node is the right one. These
    //     name-proven bindings claim their ids first.
    //  2. Plain lock bindings claim what is left. One whose id is already claimed, or that points at
    //     a remote node carrying ANOTHER source node's name, is dropped: the node is created anew.
    const sourceNodeNames = new Set(desired.nodes.map((node) => node.node_name));
    const bindings = new Map<GraphNode, { backendId: number; byName: boolean }>();
    for (const node of desired.nodes) {
      const entry = getEntity(currentLock, NODE_SECTION, node.node_name);
      if (!entry) continue;
      const lockedName = remoteNameById.get(entry.backendId);
      const sameName = remoteIdsByTypeAndName.get(`${node.type}\u0000${node.node_name}`) ?? [];
      if (lockedName !== undefined && lockedName !== '' && lockedName !== node.node_name && sameName.length === 1) {
        logger.warn(`flow.lock.json mapped node "${node.node_name}" to #${entry.backendId} ("${lockedName}") — remapped to #${sameName[0]}`);
        bindings.set(node, { backendId: sameName[0]!, byName: true });
      } else {
        bindings.set(node, { backendId: entry.backendId, byName: false });
      }
    }
    const claimed = new Map<number, string>();
    for (const [node, binding] of bindings) {
      if (binding.byName) claimed.set(binding.backendId, node.node_name);
    }
    const dropped: string[] = [];
    for (const [node, binding] of bindings) {
      if (binding.byName) continue;
      const remoteName = remoteNameById.get(binding.backendId);
      const claimedBy = claimed.get(binding.backendId);
      const belongsToAnother =
        remoteName !== undefined && remoteName !== '' && remoteName !== node.node_name && sourceNodeNames.has(remoteName);
      if (claimedBy !== undefined || belongsToAnother) {
        dropped.push(`${node.node_name} (locked #${binding.backendId} is ${claimedBy ? `"${claimedBy}"` : `"${remoteName}"`})`);
        bindings.delete(node);
        continue;
      }
      claimed.set(binding.backendId, node.node_name);
    }
    if (dropped.length > 0) {
      warnings.push(
        `flow.lock.json bound several nodes to the same backend node; recreated instead of overwriting: ${dropped.join(', ')}.`,
      );
    }

    for (const node of desired.nodes) {
      const binding = bindings.get(node);
      if (!binding) {
        currentLock = removeEntity(currentLock, NODE_SECTION, node.node_name);
        continue;
      }
      const entry = getEntity(currentLock, NODE_SECTION, node.node_name)!;
      if (remoteTypeByBackendId.get(binding.backendId) === node.type) {
        node.backendId = binding.backendId;
        if (binding.backendId !== entry.backendId) {
          currentLock = setEntity(currentLock, NODE_SECTION, node.node_name, { ...entry, backendId: binding.backendId });
        }
      } else {
        if (remoteTypeByBackendId.has(binding.backendId)) {
          logger.info(
            `Node "${node.node_name}" changed type ` +
              `(${remoteTypeByBackendId.get(binding.backendId)} -> ${node.type}) — ` +
              'it will be recreated and the lockfile remapped to the new backend id.',
          );
        }
        currentLock = removeEntity(currentLock, NODE_SECTION, node.node_name);
      }
    }

    inheritUnrepresentableFields(desired, remote);

    // 5. Bulk-save.
    const payload = buildBulkSavePayload({
      graphId: remoteDto.id,
      desired,
      remote,
      saveVersion: remoteDto.save_version,
    });

    // Reap edges whose endpoints no longer resolve to a node. buildRemoteState cannot
    // represent them, so the edge differ never sees them and they would otherwise stay
    // on the graph forever (see collectOrphanEdgeIds).
    const orphanEdgeIds = collectOrphanEdgeIds(remoteDto);
    if (orphanEdgeIds.length > 0) {
      const alreadyDeleting = new Set(payload.deleted.edge_ids);
      const extra = orphanEdgeIds.filter((id) => !alreadyDeleting.has(id));
      if (extra.length > 0) {
        payload.deleted.edge_ids.push(...extra);
        logger.info(`Reaping ${extra.length} orphaned edge(s) pointing at deleted nodes: ${extra.join(', ')}`);
      }
    }

    // Divergence from the frontend (which saves whenever the user clicks Save): an empty diff
    // skips the bulk save, so a no-op push does not bump save_version or churn the graph.
    const changed = !isEmptyBulkSave(payload);
    const response = changed ? await this.graphs.bulkSave(remoteDto.id, payload) : remoteDto;
    if (!changed) logger.info(`Graph #${remoteDto.id} is up to date — bulk save skipped`);

    // 6. Round-trip new backend ids into the lockfile.
    const mapping = changed ? applySaveResponse(desired, remote, response) : new Map<string, number>();
    let created = 0;
    for (const node of desired.nodes) {
      const backendId = node.backendId ?? mapping.get(node.id);
      if (backendId != null) {
        currentLock = setEntity(currentLock, NODE_SECTION, node.node_name, {
          backendId,
          contentHash: contentHash({}),
        });
        if (node.backendId == null) created += 1;
        node.backendId = backendId;
      }
    }
    // Lock entries for nodes no longer in the source are gone from desired — drop them.
    const desiredNames = new Set(desired.nodes.map((node) => node.node_name));
    for (const key of Object.keys(currentLock.entities)) {
      if (key.startsWith(`${NODE_SECTION}.`) && !desiredNames.has(key.slice(NODE_SECTION.length + 1))) {
        const [, ...nameParts] = key.split('.');
        currentLock = removeEntity(currentLock, NODE_SECTION, nameParts.join('.'));
      }
    }

    // Node deletions only (edge deletions are not node actions).
    const deleted = Object.entries(payload.deleted as unknown as Record<string, number[]>)
      .filter(([key]) => key !== 'edge_ids')
      .reduce((total, [, ids]) => total + (Array.isArray(ids) ? ids.length : 0), 0);

    // 7. Conditional edges — dedicated endpoints, diffed via lockfile.
    const conditional = await this.pushConditionalEdges(artifact, remoteDto.id, desired, currentLock);
    currentLock = conditional.lock;

    // 8. Persist the new save_version.
    currentLock = { ...currentLock, saveVersion: response.save_version };

    // Names of the persisted nodes this save rewrote (start/end nodes have no node_name on the wire).
    const updatedNodes: string[] = [];
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'edge_list' || key === 'deleted' || !Array.isArray(value)) continue;
      for (const item of value as Array<{ id?: number | null; node_name?: string }>) {
        if (item.id != null) updatedNodes.push(item.node_name ?? key.replace(/_node_list$|_list$/, ''));
      }
    }
    const updated = updatedNodes.length;
    if (updated > 0 && !createdGraph) logger.info(`Updating ${updated} node(s) in place: ${updatedNodes.join(', ')}`);

    return {
      graphId: remoteDto.id,
      saveVersion: response.save_version,
      lock: currentLock,
      createdGraph,
      changed: changed || conditional.changes > 0,
      nodeActions: { created, updated, deleted, updatedNodes },
      warnings,
    };
  }

  private async createGraphShell(artifact: BuildArtifact): Promise<GraphDto> {
    try {
      return await this.graphs.create({
        name: artifact.flowName,
        description: artifact.description ?? '',
        metadata: { nodes: [], connections: [] },
      });
    } catch (error) {
      // Graph names are unique per organization (GraphSerializer). Without a usable lock entry the
      // pusher must not silently take over a same-named graph — it may belong to someone else.
      if (error instanceof ApiError && error.status === 400 && /already exists/i.test(error.bodyExcerpt ?? error.message)) {
        throw new Error(
          `A flow named "${artifact.flowName}" already exists in this organization, and flow.lock.json does not ` +
            'point at it. To edit that flow, pull_flow it into a new directory; to push this source as a separate ' +
            'flow, change meta.name.',
        );
      }
      throw error;
    }
  }

  private async pushConditionalEdges(
    artifact: BuildArtifact,
    graphId: number,
    desired: GraphState,
    lock: FlowLock,
  ): Promise<{ lock: FlowLock; changes: number }> {
    let currentLock = lock;
    let changes = 0;
    const plans = (artifact.summary.conditionalEdges as ConditionalEdgePlan[] | undefined) ?? [];
    const nodeIdByUuid = new Map(
      desired.nodes.filter((node) => node.backendId != null).map((node) => [node.id, node.backendId as number]),
    );

    const seenKeys = new Set<string>();
    for (const plan of plans) {
      const sourceNodeId = nodeIdByUuid.get(plan.sourceNode);
      if (sourceNodeId === undefined) {
        throw new Error(`Conditional edge source node "${plan.sourceNodeName}" has no backend id after save.`);
      }
      const body = {
        graph: graphId,
        source_node_id: sourceNodeId,
        python_code: plan.python_code,
        input_map: plan.input_map,
      };
      const hash = contentHash(body);
      const lockName = plan.sourceNodeName;
      seenKeys.add(lockName);
      const entry = getEntity(currentLock, CONDITIONAL_EDGE_SECTION, lockName);
      if (!entry) {
        const createdEdge = await this.graphs.createConditionalEdge(body);
        currentLock = setEntity(currentLock, CONDITIONAL_EDGE_SECTION, lockName, {
          backendId: createdEdge.id as number,
          contentHash: hash,
        });
        changes += 1;
        logger.info(`Created conditional edge from "${plan.sourceNodeName}"`);
      } else if (isEntityDirty(currentLock, CONDITIONAL_EDGE_SECTION, lockName, hash)) {
        await this.graphs.updateConditionalEdge(entry.backendId, body);
        currentLock = setEntity(currentLock, CONDITIONAL_EDGE_SECTION, lockName, {
          backendId: entry.backendId,
          contentHash: hash,
        });
        changes += 1;
        logger.info(`Updated conditional edge from "${plan.sourceNodeName}"`);
      }
    }

    // Delete conditional edges removed from the source.
    for (const key of Object.keys(lock.entities)) {
      if (!key.startsWith(`${CONDITIONAL_EDGE_SECTION}.`)) continue;
      const name = key.slice(CONDITIONAL_EDGE_SECTION.length + 1);
      if (!seenKeys.has(name)) {
        const entry = lock.entities[key];
        if (entry) {
          await this.graphs.deleteConditionalEdge(entry.backendId).catch((error) => {
            logger.warn(`Failed to delete conditional edge #${entry.backendId}`, error);
          });
        }
        currentLock = removeEntity(currentLock, CONDITIONAL_EDGE_SECTION, name);
        changes += 1;
      }
    }

    return { lock: currentLock, changes };
  }
}

/**
 * Keep node settings flow source cannot express, so a repush does not wipe what a user
 * attached in the EpicStaff editor: a trigger node's `webhook_trigger` (path / provider
 * live in `webhook-triggers/`), a telegram node's bot-token secret when the source sets
 * no `bot_token_env`, and the secrets a python node's code may read. Only nodes matched
 * to a persisted node (same backend id and type) inherit; the source still wins wherever
 * it states a value.
 *
 * It also carries over the backend identities the compiler cannot know, so an unchanged node
 * diffs clean and an edited one is updated in place instead of re-created: the python code row
 * id, agent sub-task ids (by position) and — because the backend stores no note name — a note's
 * name. Without this every repush rewrote every python, agent and note node.
 */
export function inheritUnrepresentableFields(desired: GraphState, remote: GraphState): void {
  const remoteById = new Map<number, GraphNode>();
  for (const node of remote.nodes) {
    if (node.backendId != null) remoteById.set(node.backendId, node);
  }
  for (const node of desired.nodes) {
    const previous = node.backendId != null ? remoteById.get(node.backendId) : undefined;
    if (previous === undefined || previous.type !== node.type) continue;

    if (node.type === 'webhook-trigger' && previous.type === 'webhook-trigger') {
      node.data.webhook_trigger ??= previous.data.webhook_trigger;
      node.data.python_code.secret_ids ??= previous.data.python_code.secret_ids;
      node.data.python_code.id ??= previous.data.python_code.id;
    } else if (node.type === 'telegram-trigger' && previous.type === 'telegram-trigger') {
      node.data.webhook_trigger ??= previous.data.webhook_trigger;
      node.data.telegram_bot_api_key_secret_id ??= previous.data.telegram_bot_api_key_secret_id;
    } else if (node.type === 'python' && previous.type === 'python') {
      node.data.secret_ids ??= previous.data.secret_ids;
      node.data.id ??= previous.data.id;
      // Flow source cannot set use_storage; the wire default is false (bulk-save `?? false`).
      node.data.use_storage ??= false;
    } else if (node.type === 'agent' && previous.type === 'agent') {
      inheritAgentTaskIds(node.data.tasks ?? [], previous.data.tasks ?? []);
    } else if (node.type === 'note' && previous.type === 'note') {
      // GraphNote has no node_name column — the name lives only in flow source / the lockfile.
      previous.node_name = node.node_name;
    }
  }
}

/** Give compiled sub-tasks the ids of the persisted tasks at the same position. */
function inheritAgentTaskIds(tasks: AgentNodeTaskUi[], previousTasks: AgentNodeTaskUi[]): void {
  tasks.forEach((task, index) => {
    const previousTask = previousTasks[index];
    if (task.id == null && previousTask?.id != null) task.id = previousTask.id;
  });
  const idByTempId = new Map<string, number>();
  for (const task of tasks) if (task.id != null) idByTempId.set(task.tempId, task.id);
  for (const task of tasks) {
    task.contextRefs = (task.contextRefs ?? []).map((ref) => {
      const id = ref.id ?? (ref.tempId !== undefined ? idByTempId.get(ref.tempId) : undefined);
      return id !== undefined ? { id } : ref;
    });
  }
}
