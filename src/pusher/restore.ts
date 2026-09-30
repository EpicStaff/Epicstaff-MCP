import { randomUUID } from 'node:crypto';

import { buildRemoteState } from '../graph/remote-state.js';
import type { GraphState } from '../graph/graph-state.js';
import type { GraphDto } from '../models/graph.js';

/**
 * Turn a `dump_graph` snapshot into a GraphState that can be bulk-saved into a NEW graph.
 *
 * Why this direction: fidelity is lost in `compiler/emit.ts` (flow source → state), NOT in
 * `buildRemoteState` (DTO → state). Going straight from a raw DTO therefore preserves the
 * settings flow source cannot express — end-node `output_map`, CDT `prompt_configs` and route
 * codes, python `stream_config`/`test_input`, task `output_schema`, and error routes.
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
export interface RestorePreparation {
  state: GraphState;
  detached: { python_code_rows: number; agent_tasks: number };
  remappedUuids: number;
  warnings: string[];
}

export function prepareRestoreState(dto: GraphDto): RestorePreparation {
  const state = buildRemoteState(dto);
  const warnings: string[] = [];

  const conditionalEdges = Array.isArray(dto.conditional_edge_list) ? dto.conditional_edge_list.length : 0;
  if (conditionalEdges > 0) {
    warnings.push(
      `${conditionalEdges} conditional edge(s) were NOT restored — they use a dedicated endpoint that ` +
        'bulk-save does not cover. Recreate them by hand.',
    );
  }

  let pythonCodeRows = 0;
  let agentTasks = 0;
  for (const node of state.nodes) {
    node.backendId = null;
    const data = (node as { data?: Record<string, unknown> }).data;
    if (data == null) continue;

    if (node.type === 'python') {
      const code = data as { id?: number };
      if (code.id !== undefined) {
        delete code.id;
        pythonCodeRows += 1;
      }
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
    detached: { python_code_rows: pythonCodeRows, agent_tasks: agentTasks },
    remappedUuids: ordered.length,
    warnings,
  };
}
