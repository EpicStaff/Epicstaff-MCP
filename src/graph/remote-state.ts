/**
 * Remote-baseline converter: `GraphDto` (wire read shape) → `GraphState`.
 *
 * Inverse of the per-type `mapPayload` emission in `bulk-save.ts`, so a pusher can
 * diff a desired local state against what the backend currently holds. The projection
 * is faithful to the comparables in `diff.ts`: for an unchanged graph,
 * `getNodeDiff(buildRemoteState(dto), desired)` reports zero updates — provided the
 * desired state shares this module's uuid space (use `remoteNodeUuid`), because
 * decision-table / CDT branch refs and edges are matched by node uuid.
 *
 * Branch links of decision-table / classification-decision-table nodes live in node
 * state (`next_node` / `default_next_node` / `next_error_node` as uuids), NOT in
 * `edges` — mirroring how `getPlainConnections` excludes them from `edge_list`.
 *
 * Known projection caveats (all diff-safe for data written by `buildBulkSavePayload`):
 * - Comparables JSON-compare objects verbatim, so pass-through objects (`input_map`,
 *   `python_code`, `metadata` sub-objects) round-trip only when the backend echoes
 *   key order — true for JSONFields persisted from our own payloads. `python_code`
 *   is rebuilt in canonical `{id, name, libraries, code, entrypoint}` order; `name`
 *   falls back to `node_name` when the read shape omits it.
 * - Backend node ids are assumed unique across node types when resolving branch
 *   refs (`next_node_id` carries no type); on collision the first registered list wins.
 * - A repeat schedule saved with a non-weekday unit loses its `weekdays` on the wire
 *   (same info-loss exists in the frontend).
 */

import type { GraphDto } from '../models/graph.js';
import type { AgentNodeDto, AgentNodeTaskUi } from '../models/nodes/agent-node.js';
import type { ClassificationDecisionTableNodeDto } from '../models/nodes/classification-decision-table-node.js';
import type { DecisionTableNodeDto } from '../models/nodes/decision-table-node.js';
import type { CustomPythonCode, GetPythonCodeDto } from '../models/nodes/python-node.js';
import type { ScheduleTriggerNodeDto } from '../models/nodes/schedule-trigger-node.js';
import type {
  CdtTableState,
  DecisionTableState,
  GraphEdgeState,
  GraphNode,
  GraphNodeBase,
  GraphNodeType,
  GraphPoint,
  GraphState,
  ScheduleTriggerGraphNodeData,
} from './graph-state.js';

/** Stable synthetic uuid for a backend node — never collides with `mintTempId()` uuids. */
export function remoteNodeUuid(type: GraphNodeType, backendId: number): string {
  return `remote-${type}-${backendId}`;
}

interface ExtractedMetadata {
  position: GraphPoint;
  color: string;
  icon: string;
  size: { width: number; height: number };
  nodeNumber?: number;
}

function extractNodeMetadata(metadata: unknown): ExtractedMetadata {
  const record = (metadata ?? {}) as Record<string, unknown>;
  const position = (record['position'] as GraphPoint | undefined) ?? { x: 0, y: 0 };
  const size = (record['size'] as { width: number; height: number } | undefined) ?? { width: 0, height: 0 };
  const color = typeof record['color'] === 'string' ? record['color'] : '';
  const icon = typeof record['icon'] === 'string' ? record['icon'] : '';
  const nodeNumber = typeof record['nodeNumber'] === 'number' ? record['nodeNumber'] : undefined;
  return { position, color, icon, size, ...(nodeNumber !== undefined ? { nodeNumber } : {}) };
}

interface BaseDtoFields {
  id: number;
  node_name?: string;
  input_map?: Record<string, unknown>;
  output_variable_path?: string | null;
  metadata?: unknown;
}

function baseNode(type: GraphNodeType, dto: BaseDtoFields): GraphNodeBase {
  return {
    id: remoteNodeUuid(type, dto.id),
    backendId: dto.id,
    node_name: dto.node_name ?? '',
    ...extractNodeMetadata(dto.metadata),
    input_map: dto.input_map ?? {},
    output_variable_path: dto.output_variable_path ?? null,
  };
}

/** Rebuild `CustomPythonCode` in canonical key order; `name` is absent from the read shape. */
function toCustomPythonCode(code: GetPythonCodeDto, fallbackName: string): CustomPythonCode {
  const withName = code as GetPythonCodeDto & { name?: string };
  return {
    ...(withName.id !== undefined ? { id: withName.id } : {}),
    name: withName.name ?? fallbackName,
    libraries: withName.libraries,
    code: withName.code,
    entrypoint: withName.entrypoint,
  };
}

function crewIdOf(crew: unknown): number {
  if (typeof crew === 'number') return crew;
  if (typeof crew === 'object' && crew !== null && typeof (crew as { id?: unknown }).id === 'number') {
    return (crew as { id: number }).id;
  }
  return 0;
}

function toAgentTasks(dto: AgentNodeDto): AgentNodeTaskUi[] {
  return [...(dto.tasks ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((task) => ({
      id: task.id,
      tempId: `remote-agent-task-${task.id}`,
      name: task.name,
      instructions: task.instructions,
      output_schema: task.output_schema ?? {},
      contextRefs: (task.context_tasks ?? []).map((contextTaskId) => ({ id: contextTaskId })),
    }));
}

function toScheduleData(dto: ScheduleTriggerNodeDto): ScheduleTriggerGraphNodeData {
  const schedule = dto.schedule;
  if (!schedule) {
    return {
      isActive: dto.is_active,
      runMode: 'once',
      startDateTime: '',
      intervalEvery: null,
      intervalUnit: null,
      weekdays: [],
      endType: 'never',
      endDateTime: null,
      maxRuns: null,
      currentRuns: dto.current_runs,
      timezone: 'UTC',
      nextRunDateTime: null,
    };
  }
  return {
    isActive: dto.is_active,
    runMode: schedule.run_mode ?? 'once',
    startDateTime: schedule.start_date_time ?? '',
    intervalEvery: schedule.interval?.every ?? null,
    intervalUnit: schedule.interval?.unit ?? null,
    weekdays: schedule.interval?.weekdays ?? [],
    endType: schedule.end.type ?? 'never',
    endDateTime: schedule.end.date_time ?? null,
    maxRuns: schedule.end.max_runs ?? null,
    currentRuns: dto.current_runs,
    timezone: schedule.timezone,
    nextRunDateTime: schedule.next_run_date_time ?? null,
  };
}

type UuidResolver = (backendId: number | null | undefined) => string | null;

function toDecisionTableState(dto: DecisionTableNodeDto, uuidOf: UuidResolver): DecisionTableState {
  return {
    condition_groups: (dto.condition_groups ?? []).map((group) => ({
      group_name: group.group_name,
      group_type: group.group_type,
      expression: group.expression,
      conditions: (group.conditions ?? []).map((condition) => ({
        condition_name: condition.condition_name,
        condition: condition.condition,
      })),
      manipulation: group.manipulation,
      next_node: uuidOf(group.next_node_id),
      order: group.order,
    })),
    default_next_node: uuidOf(dto.default_next_node_id),
    next_error_node: uuidOf(dto.next_error_node_id),
  };
}

function toCdtTableState(dto: ClassificationDecisionTableNodeDto, uuidOf: UuidResolver): CdtTableState {
  const prompts: CdtTableState['prompts'] = {};
  for (const config of dto.prompt_configs ?? []) {
    prompts[config.prompt_key] = {
      prompt_text: config.prompt_text,
      llm_config: config.llm_config,
      output_schema: config.output_schema,
      result_variable: config.result_variable,
      variable_mappings: config.variable_mappings,
    };
  }

  return {
    condition_groups: (dto.condition_groups ?? []).map((group) => ({
      group_name: group.group_name,
      order: group.order,
      expression: group.expression,
      prompt_id: group.prompt_id,
      manipulation: group.manipulation,
      continue_flag: group.continue_flag,
      route_code: group.route_code,
      next_node: uuidOf(group.next_node_id),
      dock_visible: group.dock_visible,
      field_expressions: group.field_expressions ?? {},
      field_manipulations: group.field_manipulations ?? {},
      section: group.section ?? null,
    })),
    prompts,
    default_llm_config: dto.default_llm_config,
    default_next_node: uuidOf(dto.default_next_node_id),
    next_error_node: uuidOf(dto.next_error_node_id),
    pre_computation: {
      code: dto.pre_python_code?.code ?? '',
      libraries: dto.pre_python_code?.libraries ?? [],
      input_map: dto.pre_input_map ?? {},
      output_variable_path: dto.pre_output_variable_path ?? null,
    },
    post_computation: {
      code: dto.post_python_code?.code ?? '',
      libraries: dto.post_python_code?.libraries ?? [],
      input_map: dto.post_input_map ?? {},
      output_variable_path: dto.post_output_variable_path ?? null,
    },
  };
}

export function buildRemoteState(dto: GraphDto): GraphState {
  const uuidByBackendId = new Map<number, string>();
  const register = (type: GraphNodeType, items: Array<{ id: number }> | undefined): void => {
    for (const item of items ?? []) {
      if (!uuidByBackendId.has(item.id)) uuidByBackendId.set(item.id, remoteNodeUuid(type, item.id));
    }
  };

  register('start', dto.start_node_list);
  register('crew', dto.crew_node_list);
  register('python', dto.python_node_list);
  register('task', dto.task_node_list);
  register('agent', dto.agent_node_list);
  register('file-extractor', dto.file_extractor_node_list);
  register('audio-to-text', dto.audio_transcription_node_list);
  register('end', dto.end_node_list);
  register('subgraph', dto.subgraph_node_list);
  register('webhook-trigger', dto.webhook_trigger_node_list);
  register('telegram-trigger', dto.telegram_trigger_node_list);
  register('schedule-trigger', dto.schedule_trigger_node_list);
  register('decision-table', dto.decision_table_node_list);
  register('note', dto.graph_note_list);
  register('classification-decision-table', dto.classification_decision_table_node_list);

  const uuidOf: UuidResolver = (backendId) => (backendId != null ? (uuidByBackendId.get(backendId) ?? null) : null);

  const nodes: GraphNode[] = [
    ...(dto.start_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('start', node),
        type: 'start',
        data: { initialState: node.variables ?? {} },
      })
    ),
    ...(dto.crew_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('crew', node),
        type: 'crew',
        data: { id: crewIdOf(node.crew) },
        ...(node.stream_config !== undefined ? { stream_config: node.stream_config } : {}),
      })
    ),
    ...(dto.python_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('python', node),
        type: 'python',
        data: {
          ...toCustomPythonCode(node.python_code, node.node_name),
          ...(node.use_storage !== undefined ? { use_storage: node.use_storage } : {}),
        },
        ...(node.stream_config !== undefined ? { stream_config: node.stream_config } : {}),
        test_input: node.test_input ?? {},
      })
    ),
    ...(dto.task_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('task', node),
        type: 'task',
        data: {
          instructions: node.instructions,
          output_schema: node.output_schema ?? {},
          remember_output: node.remember_output ?? false,
          agent_definition: node.agent_definition ?? null,
          surface_list: node.surface_list ?? [],
          inline_surface: node.inline_surface ?? null,
        },
      })
    ),
    ...(dto.agent_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('agent', node),
        type: 'agent',
        data: {
          agent_definition: node.agent_definition ?? null,
          surface_list: node.surface_list ?? [],
          inline_surface: node.inline_surface ?? null,
          tasks: toAgentTasks(node),
        },
      })
    ),
    ...(dto.file_extractor_node_list ?? []).map(
      (node): GraphNode => ({ ...baseNode('file-extractor', node), type: 'file-extractor' })
    ),
    ...(dto.audio_transcription_node_list ?? []).map(
      (node): GraphNode => ({ ...baseNode('audio-to-text', node), type: 'audio-to-text' })
    ),
    ...(dto.end_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('end', node),
        type: 'end',
        data: { output_map: node.output_map ?? {} },
      })
    ),
    ...(dto.subgraph_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('subgraph', node),
        type: 'subgraph',
        data: { id: node.subgraph },
      })
    ),
    ...(dto.webhook_trigger_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('webhook-trigger', node),
        type: 'webhook-trigger',
        data: {
          webhook_trigger: node.webhook_trigger ?? null,
          python_code: toCustomPythonCode(node.python_code, node.node_name),
        },
      })
    ),
    ...(dto.telegram_trigger_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('telegram-trigger', node),
        type: 'telegram-trigger',
        data: {
          telegram_bot_api_key: node.telegram_bot_api_key,
          webhook_trigger: node.webhook_trigger ?? null,
          fields: (node.fields ?? []).map((field) => ({
            ...(field.id !== undefined ? { id: field.id } : {}),
            parent: field.parent,
            field_name: field.field_name,
            variable_path: field.variable_path,
          })),
        },
      })
    ),
    ...(dto.schedule_trigger_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('schedule-trigger', node),
        type: 'schedule-trigger',
        data: toScheduleData(node),
      })
    ),
    ...(dto.decision_table_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('decision-table', node),
        type: 'decision-table',
        data: { table: toDecisionTableState(node, uuidOf) },
      })
    ),
    ...(dto.graph_note_list ?? []).map((node): GraphNode => {
      const metadata = (node.metadata ?? {}) as Record<string, unknown>;
      const backgroundColor = typeof metadata['backgroundColor'] === 'string' ? metadata['backgroundColor'] : undefined;
      return {
        ...baseNode('note', node),
        type: 'note',
        data: {
          content: node.content,
          ...(backgroundColor !== undefined ? { backgroundColor } : {}),
        },
      };
    }),
    ...(dto.classification_decision_table_node_list ?? []).map(
      (node): GraphNode => ({
        ...baseNode('classification-decision-table', node),
        type: 'classification-decision-table',
        data: { table: toCdtTableState(node, uuidOf) },
      })
    ),
  ];

  const edges: GraphEdgeState[] = [];
  for (const edge of dto.edge_list ?? []) {
    const sourceNodeId = uuidOf(edge.start_node_id);
    const targetNodeId = uuidOf(edge.end_node_id);
    if (sourceNodeId == null || targetNodeId == null) continue;

    const metadata = edge.metadata ?? {};
    const rawWaypoints = (metadata as Record<string, unknown>)['waypoints'];
    const waypoints = Array.isArray(rawWaypoints) ? (rawWaypoints as GraphPoint[]) : undefined;

    edges.push({
      sourceNodeId,
      targetNodeId,
      backendId: edge.id,
      metadata,
      ...(waypoints && waypoints.length > 0 ? { waypoints, userAdjustedWaypoints: true } : {}),
    });
  }

  return { nodes, edges };
}
