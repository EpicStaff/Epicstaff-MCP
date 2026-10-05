import { randomUUID } from 'node:crypto';

import { buildRemoteState } from '../graph/remote-state.js';
import type { GraphState } from '../graph/graph-state.js';
import type { GraphsApi } from '../api/graphs.js';
import type { GraphDto } from '../models/graph.js';

/**
 * Turn a `dump_graph` snapshot into a GraphState that can be bulk-saved into a NEW graph.
 *
 * Why this direction: fidelity is lost in `compiler/emit.ts` (flow source → state), NOT in
 * `buildRemoteState` (DTO → state). Going straight from a raw DTO therefore preserves the
 * settings flow source cannot express — end-node `output_map`, CDT `prompt_configs` and route
 * codes, python `test_input` and declared secrets, task `output_schema`, and error routes.
 *
 * Two transforms are required before the state can be written anywhere else:
 *
 *  1. **Detach node-owned rows.** A python node's `data` IS its CustomPythonCode row and an
 *     agent's sub-tasks carry their own ids. Reusing them would make the copy share rows with
 *     the source graph, so editing the copy would silently edit the original. Deliberately
 *     type-specific: a SUBGRAPH node's `data.id` is the referenced graph and must survive.
 *     Org-level references (agent_definition, llm_config, surface ids) are also kept — those
 *     are meant to be shared, not duplicated.
 *
 *  2. **Re-mint node uuids.** `buildRemoteState` derives deterministic ids like
 *     `remote-python-6` so it can match remote nodes when diffing. The backend rejects those
 *     as `temp_id` ("Must be a valid UUID"), so every uuid is swapped for a real one. The swap
 *     runs over the serialized state, longest id first, because a uuid also appears embedded
 *     in decision-table port ids (`<uuid>_decision-route-<slug>`); longest-first prevents a
 *     shorter id from clobbering a longer one that shares its prefix.
 */
/**
 * A conditional edge to recreate after the bulk save. Conditional edges are not part of
 * bulk-save; like push_flow (pusher/graph.ts) they go through `conditionaledges/`, addressed by
 * the NEW backend id of their source node — hence the source is carried as a node uuid.
 */
export interface RestoredConditionalEdgePlan {
  /** Re-minted uuid of the source node in `state` (resolved to a backend id after the save). */
  sourceNode: string;
  /** Source node id in the dumped graph — for messages only. */
  dumpedSourceNodeId: number;
  /** Write shape of the edge's PythonCode row (`PythonCodeSerializer`): a fresh row, never shared. */
  python_code: {
    code: string;
    entrypoint: string;
    libraries: string[];
    global_kwargs?: unknown;
    secret_ids?: number[];
  };
  input_map: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface RestorePreparation {
  state: GraphState;
  conditionalEdges: RestoredConditionalEdgePlan[];
  detached: { python_code_rows: number; agent_tasks: number };
  remappedUuids: number;
  warnings: string[];
}

export function prepareRestoreState(dto: GraphDto): RestorePreparation {
  const state = buildRemoteState(dto);
  const warnings: string[] = [];

  // Capture conditional-edge sources while the nodes still carry their dumped backend ids.
  const uuidByDumpedId = new Map<number, string>();
  for (const node of state.nodes) if (node.backendId != null) uuidByDumpedId.set(node.backendId, node.id);
  const conditionalEdges: RestoredConditionalEdgePlan[] = [];
  for (const edge of dto.conditional_edge_list ?? []) {
    const sourceUuid = uuidByDumpedId.get(edge.source_node_id);
    if (sourceUuid === undefined) {
      warnings.push(
        `Conditional edge #${edge.id} starts at node #${edge.source_node_id}, which is not part of the dump — skipped.`,
      );
      continue;
    }
    const code = edge.python_code as GraphDto['conditional_edge_list'][number]['python_code'] & { global_kwargs?: unknown };
    conditionalEdges.push({
      sourceNode: sourceUuid,
      dumpedSourceNodeId: edge.source_node_id,
      python_code: {
        code: code.code,
        entrypoint: code.entrypoint,
        libraries: code.libraries ?? [],
        ...(code.global_kwargs !== undefined && code.global_kwargs !== null ? { global_kwargs: code.global_kwargs } : {}),
        ...(code.secrets?.length ? { secret_ids: code.secrets.map((secret) => secret.id) } : {}),
      },
      input_map: edge.input_map ?? {},
      metadata: edge.metadata ?? {},
    });
  }

  let pythonCodeRows = 0;
  let agentTasks = 0;
  for (const node of state.nodes) {
    node.backendId = null;
    const data = (node as { data?: Record<string, unknown> }).data;
    if (data == null) continue;

    // A webhook trigger's python_code is a node-owned row exactly like a python node's.
    const code = (
      node.type === 'python' ? data : node.type === 'webhook-trigger' ? data['python_code'] : undefined
    ) as { id?: number } | undefined;
    if (code?.id !== undefined) {
      delete code.id;
      pythonCodeRows += 1;
    }
    if (node.type === 'agent') {
      const tasks = data.tasks as Array<{ id?: number | null }> | undefined;
      if (Array.isArray(tasks)) {
        for (const task of tasks) {
          if (task.id != null) {
            delete task.id;
            agentTasks += 1;
          }
        }
      }
    }
  }
  for (const edge of state.edges) edge.backendId = null;

  // A webhook trigger (its public path) belongs to the node that serves it — sharing it
  // would make the copy fire on the original's webhook. Detach it; re-attach in the UI.
  const detachedTriggers = state.nodes.filter(
    (node) =>
      (node.type === 'webhook-trigger' || node.type === 'telegram-trigger') && node.data.webhook_trigger != null,
  );
  for (const node of detachedTriggers) {
    if (node.type === 'webhook-trigger' || node.type === 'telegram-trigger') node.data.webhook_trigger = null;
  }
  if (detachedTriggers.length > 0) {
    warnings.push(
      `${detachedTriggers.length} trigger node(s) had a webhook trigger attached; it was NOT copied (sharing it would make ` +
        'the copy fire on the original webhook). Attach a webhook trigger to the restored node(s) in the EpicStaff editor.',
    );
  }

  const ids = new Set<string>();
  for (const node of state.nodes) {
    ids.add(node.id);
    const tasks = (node as { data?: { tasks?: Array<{ tempId?: string }> } }).data?.tasks;
    if (Array.isArray(tasks)) {
      for (const task of tasks) if (task.tempId) ids.add(task.tempId);
    }
  }

  const ordered = [...ids].sort((left, right) => right.length - left.length);
  const fresh = new Map(ordered.map((old) => [old, randomUUID()]));
  let json = JSON.stringify(state);
  for (const old of ordered) json = json.split(old).join(fresh.get(old)!);

  return {
    state: JSON.parse(json) as GraphState,
    conditionalEdges: conditionalEdges.map((edge) => ({ ...edge, sourceNode: fresh.get(edge.sourceNode) ?? edge.sourceNode })),
    detached: { python_code_rows: pythonCodeRows, agent_tasks: agentTasks },
    remappedUuids: ordered.length,
    warnings,
  };
}

/**
 * Recreate the dump's conditional edges on the restored graph through `conditionaledges/` — the
 * endpoint push_flow uses — so the copy routes exactly like the original. `nodeIdByUuid` maps the
 * restored state's node uuids to their new backend ids (applySaveResponse).
 */
export async function restoreConditionalEdges(
  graphs: GraphsApi,
  graphId: number,
  plans: RestoredConditionalEdgePlan[],
  nodeIdByUuid: Map<string, number>,
): Promise<number> {
  let created = 0;
  for (const plan of plans) {
    const sourceNodeId = nodeIdByUuid.get(plan.sourceNode);
    if (sourceNodeId === undefined) {
      throw new Error(
        `Conditional edge from dumped node #${plan.dumpedSourceNodeId} could not be restored: its node has no ` +
          `backend id in graph #${graphId} after the save.`,
      );
    }
    await graphs.createConditionalEdge({
      graph: graphId,
      source_node_id: sourceNodeId,
      python_code: plan.python_code,
      input_map: plan.input_map,
      metadata: plan.metadata,
    });
    created += 1;
  }
  return created;
}
