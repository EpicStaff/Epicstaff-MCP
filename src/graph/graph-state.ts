/**
 * Client-side graph state — the input model for the bulk-save payload builder.
 *
 * Mirrors the EpicStaff frontend canvas model (`visual-programming/core/models/node.model.ts`
 * + `connection.model.ts`) closely enough that `buildBulkSavePayload` is a mechanical
 * port of `utils/save/{diff,payload}.ts`.
 *
 * Node `id` is a client-minted uuid (see `mintTempId`); `backendId` is the persisted
 * primary key (`null` for nodes not yet saved).
 */

import type { AgentNodeTaskUi } from '../models/nodes/agent-node.js';
import type { CustomPythonCode } from '../models/nodes/python-node.js';
import type { InlineSurface } from '../models/nodes/task-node.js';
import type { TelegramTriggerFieldWrite } from '../models/nodes/telegram-trigger-node.js';
import type {
  ScheduleEndType,
  ScheduleIntervalUnit,
  ScheduleRunMode,
  WeekdayCode,
} from '../models/nodes/schedule-trigger-node.js';
import type { WebhookTriggerModel } from '../models/nodes/webhook-trigger-node.js';

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphNodeBase {
  /** Client-side uuid. Doubles as the wire `temp_id` for unsaved nodes. */
  id: string;
  /** Backend primary key — set on load / after save, null for newly created nodes. */
  backendId: number | null;
  node_name: string;
  position: GraphPoint;
  color: string;
  icon: string;
  size: { width: number; height: number };
  /** Unique incrementing number per graph, displayed as the #N badge. */
  nodeNumber?: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
}

export interface StartGraphNode extends GraphNodeBase {
  type: 'start';
  data: { initialState: Record<string, unknown> };
}

/** Crew (project) node — deprecated but supported. `data.id` is the crew/project id. */
export interface CrewGraphNode extends GraphNodeBase {
  type: 'crew';
  data: { id: number };
  stream_config?: Record<string, boolean>;
}

export interface PythonGraphNode extends GraphNodeBase {
  type: 'python';
  data: CustomPythonCode;
  stream_config?: Record<string, boolean>;
  test_input: Record<string, string | number | boolean>;
}

export interface TaskGraphNodeData {
  name?: string;
  instructions: string;
  output_schema?: Record<string, unknown>;
  remember_output?: boolean;
  agent_definition: number | null;
  surface_list?: number[];
  inline_surface?: InlineSurface | null;
}

export interface TaskGraphNode extends GraphNodeBase {
  type: 'task';
  data: TaskGraphNodeData;
}

export interface AgentGraphNodeData {
  name?: string;
  agent_definition: number | null;
  surface_list?: number[];
  inline_surface?: InlineSurface | null;
  tasks?: AgentNodeTaskUi[];
}

export interface AgentGraphNode extends GraphNodeBase {
  type: 'agent';
  data: AgentGraphNodeData;
}

export interface EndGraphNode extends GraphNodeBase {
  type: 'end';
  data: { output_map?: Record<string, unknown> };
}

export interface NoteGraphNode extends GraphNodeBase {
  type: 'note';
  data: { content: string; backgroundColor?: string };
}

export interface FileExtractorGraphNode extends GraphNodeBase {
  type: 'file-extractor';
}

export interface AudioToTextGraphNode extends GraphNodeBase {
  type: 'audio-to-text';
}

/** `data.id` is the referenced subgraph's id. */
export interface SubgraphGraphNode extends GraphNodeBase {
  type: 'subgraph';
  data: { id: number };
}

export interface WebhookTriggerGraphNode extends GraphNodeBase {
  type: 'webhook-trigger';
  data: {
    webhook_trigger: WebhookTriggerModel | null;
    python_code: CustomPythonCode;
  };
}

export interface TelegramTriggerGraphNode extends GraphNodeBase {
  type: 'telegram-trigger';
  data: {
    telegram_bot_api_key: string;
    webhook_trigger: WebhookTriggerModel | null;
    fields: TelegramTriggerFieldWrite[];
  };
}

/** Mirrors the frontend's `ScheduleTriggerNodeData` draft state. */
export interface ScheduleTriggerGraphNodeData {
  isActive: boolean;
  runMode: ScheduleRunMode;
  /** Empty string means "draft" — the node saves with `schedule: null`, `is_active: false`. */
  startDateTime: string;
  intervalEvery: number | null;
  intervalUnit: ScheduleIntervalUnit | null;
  weekdays: WeekdayCode[];
  endType: ScheduleEndType;
  endDateTime: string | null;
  maxRuns: number | null;
  currentRuns?: number;
  timezone: string;
  nextRunDateTime?: string | null;
}

export interface ScheduleTriggerGraphNode extends GraphNodeBase {
  type: 'schedule-trigger';
  data: ScheduleTriggerGraphNodeData;
}

export interface DecisionTableConditionState {
  condition_name: string;
  condition: string;
}

export interface DecisionTableConditionGroupState {
  group_name: string;
  group_type: string;
  expression: string | null;
  conditions: DecisionTableConditionState[];
  manipulation: string | null;
  /** Client uuid of the branch target node, or null. */
  next_node: string | null;
  order?: number;
  /** Groups with `valid: false` are skipped at save time. */
  valid?: boolean;
}

export interface DecisionTableState {
  condition_groups: DecisionTableConditionGroupState[];
  /** Client uuid of the default branch target, or null. */
  default_next_node: string | null;
  /** Client uuid of the error branch target, or null. */
  next_error_node: string | null;
}

export interface DecisionTableGraphNode extends GraphNodeBase {
  type: 'decision-table';
  data: { name?: string; table: DecisionTableState };
}

export interface CdtComputationState {
  code?: string;
  libraries?: string[];
  input_map?: Record<string, string>;
  output_variable_path?: string | null;
}

export interface CdtPromptConfigState {
  prompt_text?: string;
  llm_config?: number | null;
  output_schema?: Record<string, unknown> | string | null;
  result_variable?: string;
  variable_mappings?: Record<string, string>;
}

export interface CdtConditionGroupState {
  group_name: string;
  order?: number;
  expression?: string | null;
  prompt_id?: string | null;
  manipulation?: string | null;
  continue_flag?: boolean;
  continue?: boolean;
  route_code?: string | null;
  /** Client uuid of the route target node (falls back to route-port edge lookup). */
  next_node?: string | null;
  dock_visible?: boolean;
  field_expressions?: Record<string, unknown>;
  field_manipulations?: Record<string, unknown>;
  section?: string | null;
}

export interface CdtTableState {
  condition_groups?: CdtConditionGroupState[];
  prompts?: Record<string, CdtPromptConfigState>;
  default_llm_config?: number | null;
  /** Client uuid of the default branch target (falls back to default-port edge lookup). */
  default_next_node?: string | null;
  /** Client uuid of the error branch target (falls back to error-port edge lookup). */
  next_error_node?: string | null;
  pre_computation?: CdtComputationState;
  post_computation?: CdtComputationState;
  /** Legacy flat fields — read as fallbacks, mirroring the frontend. */
  pre_computation_code?: string;
  post_computation_code?: string;
  pre_input_map?: Record<string, string>;
  pre_output_variable_path?: string | null;
  post_input_map?: Record<string, string>;
  post_output_variable_path?: string | null;
}

export interface ClassificationDecisionTableGraphNode extends GraphNodeBase {
  type: 'classification-decision-table';
  data: { name?: string; table: CdtTableState };
}

export type GraphNode =
  | StartGraphNode
  | CrewGraphNode
  | PythonGraphNode
  | TaskGraphNode
  | AgentGraphNode
  | EndGraphNode
  | NoteGraphNode
  | FileExtractorGraphNode
  | AudioToTextGraphNode
  | SubgraphGraphNode
  | WebhookTriggerGraphNode
  | TelegramTriggerGraphNode
  | ScheduleTriggerGraphNode
  | DecisionTableGraphNode
  | ClassificationDecisionTableGraphNode;

export type GraphNodeType = GraphNode['type'];

/**
 * A connection between two nodes, referenced by client uuid.
 * `backendId`/`metadata` come from the persisted edge (when loaded from the backend).
 */
export interface GraphEdgeState {
  sourceNodeId: string;
  targetNodeId: string;
  /**
   * Source port id — only meaningful for decision-table / classification-decision-table
   * branch connections (`<nodeUuid>_decision-route-<slug>` / `_decision-default` / `_decision-error`).
   */
  sourcePortId?: string;
  /** Persisted edge primary key, when the edge exists on the backend. */
  backendId?: number | null;
  /** Persisted edge metadata, when the edge exists on the backend. */
  metadata?: Record<string, unknown>;
  waypoints?: GraphPoint[];
  /** Waypoints are persisted only when the user manually adjusted them. */
  userAdjustedWaypoints?: boolean;
}

export interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdgeState[];
}
