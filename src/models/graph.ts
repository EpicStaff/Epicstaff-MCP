/**
 * Graph-level wire DTOs and the bulk-save payload type.
 *
 * Ported from the EpicStaff frontend:
 * - features/flows/models/graph.model.ts               (GraphDto, CreateGraphDtoRequest, UpdateGraphDtoRequest)
 * - visual-programming/core/models/node-metadata.model.ts (NodeDtoMetadata)
 * - visual-programming/utils/save/payload.ts            (bulk-save body shape)
 *
 * Intentionally excluded node types (never emitted by this module):
 * - llm_node_list        — legacy
 * - code_agent_node_list — deprecated
 * Their `deleted` id-list keys are kept (always empty) so the wire body shape
 * matches what the backend receives from the frontend byte-for-byte.
 */

import type { AgentNodeDto, AgentNodeWrite } from './nodes/agent-node.js';
import type { AudioToTextNodeDto, AudioToTextNodeWrite } from './nodes/audio-to-text-node.js';
import type {
  ClassificationDecisionTableNodeDto,
  ClassificationDecisionTableNodeWrite,
} from './nodes/classification-decision-table-node.js';
import type { ConditionalEdgeDto } from './nodes/conditional-edge.js';
import type { CrewNodeDto, CrewNodeWrite } from './nodes/crew-node.js';
import type { DecisionTableNodeDto, DecisionTableNodeWrite } from './nodes/decision-table-node.js';
import type { BulkEdgeCreate, BulkEdgeUpdate, EdgeDto } from './nodes/edge.js';
import type { EndNodeDto, EndNodeWrite } from './nodes/end-node.js';
import type { FileExtractorNodeDto, FileExtractorNodeWrite } from './nodes/file-extractor-node.js';
import type { GraphNoteDto, GraphNoteWrite } from './nodes/note-node.js';
import type { PythonNodeDto, PythonNodeWrite } from './nodes/python-node.js';
import type { ScheduleTriggerNodeDto, ScheduleTriggerNodeWrite } from './nodes/schedule-trigger-node.js';
import type { StartNodeDto, StartNodeWrite } from './nodes/start-node.js';
import type { SubGraphNodeDto, SubGraphNodeWrite } from './nodes/subgraph-node.js';
import type { TaskNodeDto, TaskNodeWrite } from './nodes/task-node.js';
import type { TelegramTriggerNodeDto, TelegramTriggerNodeWrite } from './nodes/telegram-trigger-node.js';
import type { WebhookTriggerNodeDto, WebhookTriggerNodeWrite } from './nodes/webhook-trigger-node.js';

/**
 * The shape of the `metadata` JSON field stored on every backend node.
 * Written FE→BE at save time, read back BE→FE at load time.
 */
export interface NodeDtoMetadata extends Record<string, unknown> {
  position: { x: number; y: number };
  color: string;
  icon: string;
  size: { width: number; height: number };
  nodeNumber?: number;
}

export interface SubflowLightDto {
  id: number;
  name: string;
  description: string;
  tags?: string[];
  label_ids?: number[];
  created_at?: string;
  updated_at?: string;
}

export interface GetGraphLightRequest {
  id: number;
  uuid: string;
  name: string;
  description: string;
  tags?: string[];
  epicchat_enabled?: boolean;
  label_ids?: number[];
  created_at?: string;
  updated_at?: string;
  subflows?: SubflowLightDto[];
  save_version?: number;
}

/**
 * Full graph as returned by `GET /graphs/:id/` and as the bulk-save response body.
 * `agent_node_list` is optional in the source frontend DTO (known drift) — kept optional here.
 */
export interface GraphDto extends GetGraphLightRequest {
  save_version: number;
  start_node_list: StartNodeDto[];
  crew_node_list: CrewNodeDto[];
  python_node_list: PythonNodeDto[];
  task_node_list: TaskNodeDto[];
  agent_node_list?: AgentNodeDto[];
  edge_list: EdgeDto[];
  conditional_edge_list: ConditionalEdgeDto[];
  file_extractor_node_list: FileExtractorNodeDto[];
  webhook_trigger_node_list: WebhookTriggerNodeDto[];
  telegram_trigger_node_list: TelegramTriggerNodeDto[];
  end_node_list: EndNodeDto[];
  subgraph_node_list: SubGraphNodeDto[];
  decision_table_node_list: DecisionTableNodeDto[];
  classification_decision_table_node_list: ClassificationDecisionTableNodeDto[];
  metadata: Record<string, unknown>;
  audio_transcription_node_list: AudioToTextNodeDto[];
  graph_note_list: GraphNoteDto[];
  schedule_trigger_node_list: ScheduleTriggerNodeDto[];
}

export interface CreateGraphDtoRequest {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  start_node_list?: StartNodeDto[];
  crew_node_list?: CrewNodeDto[];
  python_node_list?: PythonNodeDto[];
  edge_list?: EdgeDto[];
  conditional_edge_list?: ConditionalEdgeDto[];
  file_extractor_node_list?: FileExtractorNodeDto[];
  webhook_trigger_node_list?: WebhookTriggerNodeDto[];
  telegram_trigger_node_list?: TelegramTriggerNodeDto[];
  end_node_list?: EndNodeDto[];
  subgraph_node_list?: SubGraphNodeDto[];
  decision_table_node_list?: DecisionTableNodeDto[];
  schedule_trigger_node_list?: ScheduleTriggerNodeWrite[];
}

export interface UpdateGraphDtoRequest {
  id: number;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  tags?: string[];
  save_version?: number;
}

// ── Bulk-save item shapes ────────────────────────────────────────────────────

/** A node being created in a bulk save: `id: null` plus the client-minted `temp_id`. */
export type BulkCreateItem<TWrite> = { id: null; temp_id: string } & TWrite;

/** A node being updated in a bulk save: the backend primary key plus the full write body. */
export type BulkUpdateItem<TWrite> = { id: number } & TWrite;

export type BulkItem<TWrite> = BulkCreateItem<TWrite> | BulkUpdateItem<TWrite>;

/**
 * The `deleted` block of the bulk-save body — backend ids to remove, keyed by type.
 * `llm_node_ids` / `code_agent_node_ids` are always empty (types not modelled here)
 * but kept so the body shape matches the frontend's exactly.
 */
export interface BulkDeletedBlock {
  start_node_ids: number[];
  crew_node_ids: number[];
  python_node_ids: number[];
  task_node_ids: number[];
  agent_node_ids: number[];
  llm_node_ids: number[];
  file_extractor_node_ids: number[];
  audio_transcription_node_ids: number[];
  end_node_ids: number[];
  subgraph_node_ids: number[];
  webhook_trigger_node_ids: number[];
  telegram_trigger_node_ids: number[];
  schedule_trigger_node_ids: number[];
  decision_table_node_ids: number[];
  graph_note_ids: number[];
  code_agent_node_ids: number[];
  classification_decision_table_node_ids: number[];
  edge_ids: number[];
}

/**
 * Body of `POST /graphs/:id/bulk-save/` — exactly what
 * `visual-programming/utils/save/payload.ts#buildBulkSavePayload` emits,
 * minus the excluded `llm_node_list` / `code_agent_node_list`.
 */
export interface BulkSavePayload {
  save_version: number;
  start_node_list: BulkItem<StartNodeWrite>[];
  crew_node_list: BulkItem<CrewNodeWrite>[];
  python_node_list: BulkItem<PythonNodeWrite>[];
  task_node_list: BulkItem<TaskNodeWrite>[];
  agent_node_list: BulkItem<AgentNodeWrite>[];
  file_extractor_node_list: BulkItem<FileExtractorNodeWrite>[];
  audio_transcription_node_list: BulkItem<AudioToTextNodeWrite>[];
  end_node_list: BulkItem<EndNodeWrite>[];
  subgraph_node_list: BulkItem<SubGraphNodeWrite>[];
  webhook_trigger_node_list: BulkItem<WebhookTriggerNodeWrite>[];
  telegram_trigger_node_list: BulkItem<TelegramTriggerNodeWrite>[];
  schedule_trigger_node_list: BulkItem<ScheduleTriggerNodeWrite>[];
  decision_table_node_list: BulkItem<DecisionTableNodeWrite>[];
  graph_note_list: BulkItem<GraphNoteWrite>[];
  classification_decision_table_node_list: BulkItem<ClassificationDecisionTableNodeWrite>[];
  edge_list: (BulkEdgeCreate | BulkEdgeUpdate)[];
  deleted: BulkDeletedBlock;
}
