/**
 * Graph-level wire DTOs and the bulk-save payload type.
 *
 * Ported from the EpicStaff frontend:
 * - features/flows/models/graph.model.ts               (GraphDto, CreateGraphDtoRequest, UpdateGraphDtoRequest)
 * - visual-programming/core/models/node-metadata.model.ts (NodeDtoMetadata)
 * - visual-programming/utils/save/payload.ts            (bulk-save body shape)
 *
 * Removed upstream and gone from the wire entirely: `llm_node_list` / `llm_node_ids`,
 * `conditional_edge_list` (conditional edges no longer exist), `crew_node_list` /
 * `crew_node_ids`, `code_agent_node_list` / `code_agent_node_ids`.
 */

import type { AuthorshipFields, UserSummary } from './authorship.js';
import type { AgentNodeDto, AgentNodeWrite } from './nodes/agent-node.js';
import type { AudioToTextNodeDto, AudioToTextNodeWrite } from './nodes/audio-to-text-node.js';
import type {
  ClassificationDecisionTableNodeDto,
  ClassificationDecisionTableNodeWrite,
} from './nodes/classification-decision-table-node.js';
import type { DecisionTableNodeDto, DecisionTableNodeWrite } from './nodes/decision-table-node.js';
import type { BulkEdgeCreate, BulkEdgeUpdate, EdgeDto } from './nodes/edge.js';
import type { EndNodeDto, EndNodeWrite } from './nodes/end-node.js';
import type { FileExtractorNodeDto, FileExtractorNodeWrite } from './nodes/file-extractor-node.js';
import type { GraphNoteDto, GraphNoteWrite } from './nodes/note-node.js';
import type { KeyValueNodeDto, KeyValueNodeWrite } from './nodes/key-value-node.js';
import type {
  KnowledgeRetrieverNodeDto,
  KnowledgeRetrieverNodeWrite,
} from './nodes/knowledge-retriever-node.js';
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
}

export interface SubflowLightDto {
  id: number;
  name: string;
  description: string;
  tags?: string[];
  label_ids?: number[];
  created_at?: string;
  updated_at?: string;
  save_version?: number;
}

/**
 * Author and last-edit fields are optional like created_at/updated_at: the frontend also builds
 * light graphs from SubflowLightDto, which carries no authorship.
 */
export interface GetGraphLightRequest extends Partial<AuthorshipFields> {
  id: number;
  uuid: string;
  name: string;
  description: string;
  tags?: string[];
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
  created_by: UserSummary | null;
  created_at: string;
  last_edited_by: UserSummary | null;
  last_edited_at: string | null;
  save_version: number;
  /**
   * Read-only: the highest node number the graph has issued. Never lowered, so a deleted node's
   * number is not given out again.
   */
  node_number_seq: number;
  start_node_list: StartNodeDto[];
  python_node_list: PythonNodeDto[];
  task_node_list: TaskNodeDto[];
  agent_node_list?: AgentNodeDto[];
  edge_list: EdgeDto[];
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
  knowledge_node_list: KnowledgeRetrieverNodeDto[];
  key_value_node_list: KeyValueNodeDto[];
}

export interface CreateGraphDtoRequest {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  start_node_list?: StartNodeDto[];
  python_node_list?: PythonNodeDto[];
  edge_list?: EdgeDto[];
  file_extractor_node_list?: FileExtractorNodeDto[];
  webhook_trigger_node_list?: WebhookTriggerNodeDto[];
  telegram_trigger_node_list?: TelegramTriggerNodeDto[];
  end_node_list?: EndNodeDto[];
  subgraph_node_list?: SubGraphNodeDto[];
  decision_table_node_list?: DecisionTableNodeDto[];
  schedule_trigger_node_list?: ScheduleTriggerNodeWrite[];
  knowledge_node_list?: KnowledgeRetrieverNodeDto[];
  key_value_node_list?: KeyValueNodeDto[];
}

export interface UpdateGraphDtoRequest {
  id: number;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  tags?: string[];
  save_version?: number;
}

/**
 * Body of `PATCH /graphs/{id}/`: only the writable graph metadata. The read-only author,
 * timestamps and last edit of a loaded graph are never sent back.
 */
export type PatchGraphDtoRequest = Partial<
  Pick<GraphDto, 'name' | 'description' | 'tags' | 'label_ids' | 'save_version'>
>;

// ── Bulk-save item shapes ────────────────────────────────────────────────────

/**
 * Identity keys of a node item the bulk save creates (`CreatedNodeItemKeys`). `node_number_hint`
 * is wire-only and sent for numbered node types alone. It is an ordering key: the server sorts
 * the save's new nodes by it and numbers them consecutively from the graph's counter.
 */
export interface CreatedNodeItemKeys {
  id: null;
  temp_id: string;
  node_number_hint?: number;
}

/** A node being created in a bulk save: `id: null`, the client-minted `temp_id`, and the write body. */
export type BulkCreateItem<TWrite> = CreatedNodeItemKeys & TWrite;

/** A node being updated in a bulk save: the backend primary key plus the full write body. */
export type BulkUpdateItem<TWrite> = { id: number } & TWrite;

export type BulkItem<TWrite> = BulkCreateItem<TWrite> | BulkUpdateItem<TWrite>;

/** The `deleted` block of the bulk-save body — backend ids to remove, keyed by type. */
export interface BulkDeletedBlock {
  start_node_ids: number[];
  python_node_ids: number[];
  task_node_ids: number[];
  agent_node_ids: number[];
  file_extractor_node_ids: number[];
  audio_transcription_node_ids: number[];
  end_node_ids: number[];
  subgraph_node_ids: number[];
  webhook_trigger_node_ids: number[];
  telegram_trigger_node_ids: number[];
  schedule_trigger_node_ids: number[];
  decision_table_node_ids: number[];
  graph_note_ids: number[];
  classification_decision_table_node_ids: number[];
  knowledge_node_ids: number[];
  key_value_node_ids: number[];
  edge_ids: number[];
}

/**
 * Body of `POST /graphs/:id/save/` — exactly what
 * `visual-programming/utils/save/payload.ts#buildBulkSavePayload` emits.
 */
export interface BulkSavePayload {
  save_version: number;
  start_node_list: BulkItem<StartNodeWrite>[];
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
  knowledge_node_list: BulkItem<KnowledgeRetrieverNodeWrite>[];
  key_value_node_list: BulkItem<KeyValueNodeWrite>[];
  edge_list: (BulkEdgeCreate | BulkEdgeUpdate)[];
  deleted: BulkDeletedBlock;
}
