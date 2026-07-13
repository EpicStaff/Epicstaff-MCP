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
import type { GraphState } from '../graph/graph-state.js';
import { buildBulkSavePayload } from '../graph/bulk-save.js';
import { buildRemoteState } from '../graph/remote-state.js';
import { applySaveResponse } from '../graph/temp-id.js';
import type { GraphDto } from '../models/graph.js';
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
  nodeActions: { created: number; updated: number; deleted: number };
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

    // 1. Resolve every entity reference inside the graph to backend ids.
    const desired = substituteRefs(artifact.graph, (refKey) => {
      const id = idMap.get(refKey);
      if (id === undefined) {
        throw new Error(`Graph references "${refKey}" which was not pushed — compiler ordering bug.`);
      }
      return id;
    }) as GraphState;

    // 2. Ensure the graph shell exists.
    let remoteDto: GraphDto;
    let createdGraph = false;
    if (currentLock.graphId === null) {
      remoteDto = await this.graphs.create({
        name: artifact.flowName,
        description: artifact.description ?? '',
        metadata: { nodes: [], connections: [] },
      });
      currentLock = { ...currentLock, graphId: remoteDto.id };
      createdGraph = true;
      logger.info(`Created graph "${artifact.flowName}" (#${remoteDto.id})`);
      // Persist the shell id immediately so a bulk-save failure below is recoverable
      // (the next push reuses this graph instead of colliding on the unique name).
      await options.persistLock?.(currentLock);
    } else {
      remoteDto = await this.graphs.get(currentLock.graphId);
      // 3. Optimistic-lock conflict check against the lockfile's last-known version.
      if (
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
    }

    // 4. Give desired nodes their known backend ids from the lockfile,
    //    dropping stale entries whose backend node no longer exists remotely.
    const remote = buildRemoteState(remoteDto);
    const remoteBackendIds = new Set(
      remote.nodes.map((node) => node.backendId).filter((id): id is number => id != null),
    );
    for (const node of desired.nodes) {
      const entry = getEntity(currentLock, NODE_SECTION, node.node_name);
      if (entry && remoteBackendIds.has(entry.backendId)) {
        node.backendId = entry.backendId;
      } else if (entry) {
        currentLock = removeEntity(currentLock, NODE_SECTION, node.node_name);
      }
    }

    // 5. Bulk-save.
    const payload = buildBulkSavePayload({
      graphId: remoteDto.id,
      desired,
      remote,
      saveVersion: remoteDto.save_version,
    });
    const response = await this.graphs.bulkSave(remoteDto.id, payload);

    // 6. Round-trip new backend ids into the lockfile.
    const mapping = applySaveResponse(desired, remote, response);
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

    const deleted =
      payload.deleted && typeof payload.deleted === 'object'
        ? Object.values(payload.deleted as unknown as Record<string, number[]>).reduce(
            (total, ids) => total + (Array.isArray(ids) ? ids.length : 0),
            0,
          )
        : 0;

    // 7. Conditional edges — dedicated endpoints, diffed via lockfile.
    currentLock = await this.pushConditionalEdges(artifact, remoteDto.id, desired, currentLock);

    // 8. Persist the new save_version.
    currentLock = { ...currentLock, saveVersion: response.save_version };

    return {
      graphId: remoteDto.id,
      saveVersion: response.save_version,
      lock: currentLock,
      createdGraph,
      nodeActions: { created, updated: desired.nodes.length - created, deleted },
    };
  }

  private async pushConditionalEdges(
    artifact: BuildArtifact,
    graphId: number,
    desired: GraphState,
    lock: FlowLock,
  ): Promise<FlowLock> {
    let currentLock = lock;
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
        logger.info(`Created conditional edge from "${plan.sourceNodeName}"`);
      } else if (isEntityDirty(currentLock, CONDITIONAL_EDGE_SECTION, lockName, hash)) {
        await this.graphs.updateConditionalEdge(entry.backendId, body);
        currentLock = setEntity(currentLock, CONDITIONAL_EDGE_SECTION, lockName, {
          backendId: entry.backendId,
          contentHash: hash,
        });
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
      }
    }

    return currentLock;
  }
}
