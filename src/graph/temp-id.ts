/**
 * Temp-id minting and save-response reconciliation.
 *
 * `applySaveResponse` ports the frontend's
 * `visual-programming/utils/save/patch.ts#buildCreatedNodeIdMap`: the backend does not
 * echo `temp_id`s, so created nodes have to be matched to the response.
 *
 * Divergence: the frontend matches positionally — the i-th node sent for creation maps to the
 * i-th new node in the response list. But the backend serializes `<type>_node_list` from an
 * unordered queryset (no Meta.ordering on the node models), so Postgres may return rows in heap
 * order, which differs from insertion order once rows are rewritten (observed live at e310ee3:
 * python ids 1487..1491 came back as [1490, 1491, 1487, 1488, 1489] and the lockfile got every
 * python node's id rotated). Here a created node is matched by its node_name when exactly one new
 * response node carries it; the rest fall back to creation order = ascending id (the bulk save
 * inserts nodes in list order within one transaction).
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
    createdNodes: Array<{ id: string; node_name?: string }>,
    backendNodes: Array<{ id: number; node_name?: string | null }>,
    existingIds: Set<number>
  ): void => {
    const unclaimed = backendNodes
      .filter((backendNode) => !existingIds.has(backendNode.id))
      .sort((left, right) => left.id - right.id);
    const unmatched: Array<{ id: string }> = [];
    for (const node of createdNodes) {
      const name = node.node_name ?? '';
      const sameName = name === '' ? [] : unclaimed.filter((backendNode) => backendNode.node_name === name);
      const match = sameName.length === 1 ? sameName[0] : undefined;
      if (match) {
        mapping.set(node.id, match.id);
        unclaimed.splice(unclaimed.indexOf(match), 1);
      } else {
        unmatched.push(node);
      }
    }
    unmatched.forEach((node, index) => {
      const backendNode = unclaimed[index];
      if (backendNode) mapping.set(node.id, backendNode.id);
    });
  };

  const startCreated = nodeDiff.startNodes.toCreate;
  if (startCreated.length > 0) {
    const startExistingIds = existingIdsByType('start');
    const startCandidates = (response.start_node_list ?? [])
      .filter((node) => !startExistingIds.has(node.id))
      .sort((left, right) => left.id - right.id);
    if (startCandidates[0] && startCreated[0]) {
      mapping.set(startCreated[0].id, startCandidates[0].id);
    }
  }

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
  // Divergence: the frontend's buildCreatedNodeIdMap has no knowledge-retriever entry (it
  // reloads the graph after save); the pusher needs every created id for the lockfile.
  mapByNewIds(
    nodeDiff.knowledgeRetrieverNodes.toCreate,
    response.knowledge_node_list ?? [],
    existingIdsByType('knowledge-retriever')
  );

  return mapping;
}
