/**
 * Temp-id minting and save-response reconciliation.
 *
 * `applySaveResponse` ports the frontend's
 * `visual-programming/utils/save/patch.ts#buildCreatedNodeIdMap`: the backend does not
 * echo `temp_id`s, so created nodes are matched positionally — for each node type, the
 * i-th node sent for creation maps to the i-th response node whose id was not present
 * in the remote (pre-save) state.
 */

import { randomUUID } from 'node:crypto';

import type { GraphDto } from '../models/graph.js';
import { getNodeDiff } from './diff.js';
import type { GraphNodeType, GraphState } from './graph-state.js';

/** Mint a client-side node/task temp id (uuid v4). */
export function mintTempId(): string {
  return randomUUID();
}

/**
 * Map client uuids (`temp_id`s) of newly created nodes to their backend ids,
 * using the `GraphDto` returned by the bulk-save endpoint.
 *
 * @param desired the state that was sent (same object passed to `buildBulkSavePayload`)
 * @param remote  the pre-save persisted state (same diff baseline)
 * @param response the bulk-save response graph
 */
export function applySaveResponse(
  desired: GraphState,
  remote: GraphState,
  response: GraphDto
): Map<string, number> {
  const mapping = new Map<string, number>();
  const nodeDiff = getNodeDiff(remote, desired);

  const existingIdsByType = (type: GraphNodeType): Set<number> =>
    new Set(
      remote.nodes
        .filter((node) => node.type === type && node.backendId != null)
        .map((node) => node.backendId!)
    );

  const mapByNewIds = (
    createdNodes: Array<{ id: string }>,
    backendNodes: Array<{ id: number }>,
    existingIds: Set<number>
  ): void => {
    const newlyCreatedBackendNodes = backendNodes.filter((backendNode) => !existingIds.has(backendNode.id));
    createdNodes.forEach((node, index) => {
      const backendNode = newlyCreatedBackendNodes[index];
      if (backendNode) {
        mapping.set(node.id, backendNode.id);
      }
    });
  };

  const startCreated = nodeDiff.startNodes.toCreate;
  if (startCreated.length > 0) {
    const startExistingIds = existingIdsByType('start');
    const startCandidates = (response.start_node_list ?? []).filter((node) => !startExistingIds.has(node.id));
    if (startCandidates[0] && startCreated[0]) {
      mapping.set(startCreated[0].id, startCandidates[0].id);
    }
  }

  mapByNewIds(nodeDiff.crewNodes.toCreate, response.crew_node_list ?? [], existingIdsByType('crew'));
  mapByNewIds(nodeDiff.pythonNodes.toCreate, response.python_node_list ?? [], existingIdsByType('python'));
  mapByNewIds(nodeDiff.taskNodes.toCreate, response.task_node_list ?? [], existingIdsByType('task'));
  mapByNewIds(nodeDiff.agentNodes.toCreate, response.agent_node_list ?? [], existingIdsByType('agent'));
  mapByNewIds(
    nodeDiff.fileExtractorNodes.toCreate,
    response.file_extractor_node_list ?? [],
    existingIdsByType('file-extractor')
  );
  mapByNewIds(
    nodeDiff.audioToTextNodes.toCreate,
    response.audio_transcription_node_list ?? [],
    existingIdsByType('audio-to-text')
  );
  mapByNewIds(nodeDiff.subgraphNodes.toCreate, response.subgraph_node_list ?? [], existingIdsByType('subgraph'));
  mapByNewIds(
    nodeDiff.webhookNodes.toCreate,
    response.webhook_trigger_node_list ?? [],
    existingIdsByType('webhook-trigger')
  );
  mapByNewIds(
    nodeDiff.telegramNodes.toCreate,
    response.telegram_trigger_node_list ?? [],
    existingIdsByType('telegram-trigger')
  );
  mapByNewIds(
    nodeDiff.decisionTableNodes.toCreate,
    response.decision_table_node_list ?? [],
    existingIdsByType('decision-table')
  );
  mapByNewIds(nodeDiff.endNodes.toCreate, response.end_node_list ?? [], existingIdsByType('end'));
  mapByNewIds(nodeDiff.noteNodes.toCreate, response.graph_note_list ?? [], existingIdsByType('note'));
  mapByNewIds(
    nodeDiff.scheduleNodes.toCreate,
    response.schedule_trigger_node_list ?? [],
    existingIdsByType('schedule-trigger')
  );
  mapByNewIds(
    nodeDiff.classificationDecisionTableNodes.toCreate,
    response.classification_decision_table_node_list ?? [],
    existingIdsByType('classification-decision-table')
  );

  return mapping;
}
