/**
 * Node / connection diffing between the persisted (remote) graph state and the
 * desired local state. Faithful port of frontend `visual-programming/utils/save/diff.ts`
 * (minus the excluded legacy `llm` and deprecated `code-agent` node types).
 */

import { hasPersistedWaypoints, waypointsChanged } from './edge-waypoints.js';
import type {
  AgentGraphNode,
  AudioToTextGraphNode,
  CdtConditionGroupState,
  ClassificationDecisionTableGraphNode,
  CrewGraphNode,
  DecisionTableGraphNode,
  EndGraphNode,
  FileExtractorGraphNode,
  GraphEdgeState,
  GraphNode,
  GraphNodeType,
  GraphState,
  NoteGraphNode,
  PythonGraphNode,
  ScheduleTriggerGraphNode,
  StartGraphNode,
  SubgraphGraphNode,
  TaskGraphNode,
  TelegramTriggerGraphNode,
  WebhookTriggerGraphNode,
} from './graph-state.js';
import { toNodeMetadata } from './metadata.js';

export interface NodeDiff<T> {
  toCreate: T[];
  toUpdate: Array<{ previous: T; current: T }>;
  toDelete: T[];
}

export interface NodeDiffByType {
  startNodes: NodeDiff<StartGraphNode>;
  crewNodes: NodeDiff<CrewGraphNode>;
  pythonNodes: NodeDiff<PythonGraphNode>;
  taskNodes: NodeDiff<TaskGraphNode>;
  agentNodes: NodeDiff<AgentGraphNode>;
  fileExtractorNodes: NodeDiff<FileExtractorGraphNode>;
  audioToTextNodes: NodeDiff<AudioToTextGraphNode>;
  endNodes: NodeDiff<EndGraphNode>;
  subgraphNodes: NodeDiff<SubgraphGraphNode>;
  webhookNodes: NodeDiff<WebhookTriggerGraphNode>;
  telegramNodes: NodeDiff<TelegramTriggerGraphNode>;
  scheduleNodes: NodeDiff<ScheduleTriggerGraphNode>;
  decisionTableNodes: NodeDiff<DecisionTableGraphNode>;
  noteNodes: NodeDiff<NoteGraphNode>;
  classificationDecisionTableNodes: NodeDiff<ClassificationDecisionTableGraphNode>;
}

export interface ConnectionDiff {
  toCreate: GraphEdgeState[];
  toDelete: GraphEdgeState[];
  toUpdate: GraphEdgeState[];
}

function areEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildUuidToBackendIdMap(nodes: GraphNode[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const node of nodes) {
    if (node.backendId != null) map.set(node.id, node.backendId);
  }
  return map;
}

function nodesByType<T extends GraphNode>(nodes: GraphNode[], type: GraphNodeType): T[] {
  return nodes.filter((node) => node.type === type) as T[];
}

function diffNodesByBackendId<T extends { backendId: number | null }>(
  previous: T[],
  current: T[],
  toComparable: (node: T) => unknown
): NodeDiff<T> {
  const previousByBackendId = new Map<number, T>();
  for (const node of previous) {
    if (node.backendId != null) previousByBackendId.set(node.backendId, node);
  }

  const toCreate: T[] = [];
  const toUpdate: Array<{ previous: T; current: T }> = [];
  const matchedBackendIds = new Set<number>();

  for (const node of current) {
    if (node.backendId == null) {
      toCreate.push(node);
      continue;
    }
    const previousNode = previousByBackendId.get(node.backendId);
    if (!previousNode) {
      toCreate.push(node);
      continue;
    }

    matchedBackendIds.add(node.backendId);
    if (!areEqual(toComparable(previousNode), toComparable(node))) {
      toUpdate.push({ previous: previousNode, current: node });
    }
  }

  const toDelete: T[] = [];
  for (const [backendId, previousNode] of previousByBackendId) {
    if (!matchedBackendIds.has(backendId)) toDelete.push(previousNode);
  }

  return { toCreate, toUpdate, toDelete };
}

function toDecisionTableComparable(node: DecisionTableGraphNode, allNodes: GraphNode[]): unknown {
  const resolveComparableNodeRef = (uuid: string | null): number | `temp:${string}` | null => {
    if (!uuid) return null;
    const backendId = allNodes.find((candidate) => candidate.id === uuid)?.backendId ?? null;
    return backendId != null ? backendId : (`temp:${uuid}` as const);
  };

  return {
    node_name: node.node_name,
    condition_groups: node.data.table.condition_groups
      .filter((group) => group.valid !== false)
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
      .map((group, index) => ({
        group_name: group.group_name,
        group_type: group.group_type,
        expression: group.expression,
        conditions: group.conditions.map((condition) => ({
          condition_name: condition.condition_name,
          condition: condition.condition,
        })),
        manipulation: group.manipulation,
        next_node_id: resolveComparableNodeRef(group.next_node),
        order: typeof group.order === 'number' ? group.order : index + 1,
      })),
    default_next_node_id: resolveComparableNodeRef(node.data.table.default_next_node),
    next_error_node_id: resolveComparableNodeRef(node.data.table.next_error_node),
    metadata: toNodeMetadata(node),
  };
}

function toStartComparable(node: StartGraphNode): unknown {
  return { variables: node.data.initialState ?? {}, metadata: toNodeMetadata(node) };
}

function toCrewComparable(node: CrewGraphNode): unknown {
  return {
    node_name: node.node_name,
    crew_id: node.data.id,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    stream_config: node.stream_config ?? {},
    metadata: toNodeMetadata(node),
  };
}

function toPythonComparable(node: PythonGraphNode): unknown {
  return {
    node_name: node.node_name,
    python_code: node.data,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    stream_config: node.stream_config ?? {},
    test_input: node.test_input ?? {},
    metadata: toNodeMetadata(node),
  };
}

function toTaskComparable(node: TaskGraphNode): unknown {
  return {
    node_name: node.node_name,
    instructions: node.data.instructions,
    output_schema: node.data.output_schema ?? {},
    remember_output: node.data.remember_output ?? false,
    agent_definition: node.data.agent_definition ?? null,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    surface_list: node.data.surface_list ?? [],
    inline_surface: node.data.inline_surface ?? null,
    metadata: toNodeMetadata(node),
  };
}

function toAgentTaskComparableRef(ref: { id?: number; tempId?: string }): { id: number | null; tempId: string | null } {
  return ref.id != null ? { id: ref.id, tempId: null } : { id: null, tempId: ref.tempId ?? null };
}

function toAgentComparable(node: AgentGraphNode): unknown {
  return {
    node_name: node.node_name,
    agent_definition: node.data.agent_definition ?? null,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    surface_list: node.data.surface_list ?? [],
    inline_surface: node.data.inline_surface ?? null,
    // Array order is significant — index === task order. Do NOT sort this array.
    tasks: (node.data.tasks ?? []).map((task) => ({
      id: task.id ?? null,
      ...(task.id == null ? { tempId: task.tempId } : {}),
      name: task.name,
      instructions: task.instructions,
      output_schema: task.output_schema ?? {},
      contextRefs: (task.contextRefs ?? []).map(toAgentTaskComparableRef).sort((a, b) => {
        const aKey = a.id != null ? `id:${a.id}` : `tempId:${a.tempId}`;
        const bKey = b.id != null ? `id:${b.id}` : `tempId:${b.tempId}`;
        return aKey.localeCompare(bKey);
      }),
    })),
    metadata: toNodeMetadata(node),
  };
}

function toFileExtractorComparable(node: FileExtractorGraphNode): unknown {
  return {
    node_name: node.node_name,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    metadata: toNodeMetadata(node),
  };
}

function toAudioToTextComparable(node: AudioToTextGraphNode): unknown {
  return {
    node_name: node.node_name,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    metadata: toNodeMetadata(node),
  };
}

function toEndComparable(node: EndGraphNode): unknown {
  return {
    output_map: node.data.output_map ?? { context: 'variables.context' },
    metadata: toNodeMetadata(node),
  };
}

function toSubgraphComparable(node: SubgraphGraphNode): unknown {
  return {
    node_name: node.node_name,
    subgraph: node.data.id,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    metadata: toNodeMetadata(node),
  };
}

function toWebhookComparable(node: WebhookTriggerGraphNode): unknown {
  return {
    node_name: node.node_name,
    python_code: node.data.python_code,
    input_map: node.input_map || {},
    output_variable_path: node.output_variable_path || null,
    webhook_trigger_path: '',
    webhook_trigger: node.data.webhook_trigger,
    metadata: toNodeMetadata(node),
  };
}

function toTelegramComparable(node: TelegramTriggerGraphNode): unknown {
  return {
    node_name: node.node_name,
    telegram_bot_api_key: node.data.telegram_bot_api_key,
    webhook_trigger: node.data.webhook_trigger,
    fields: node.data.fields,
    metadata: toNodeMetadata(node),
  };
}

function toScheduleComparable(node: ScheduleTriggerGraphNode): unknown {
  return {
    node_name: node.node_name,
    isActive: node.data.isActive,
    runMode: node.data.runMode,
    startDateTime: node.data.startDateTime,
    intervalEvery: node.data.intervalEvery,
    intervalUnit: node.data.intervalUnit,
    weekdays: node.data.weekdays,
    endType: node.data.endType,
    endDateTime: node.data.endDateTime,
    maxRuns: node.data.maxRuns,
    timezone: node.data.timezone,
    // currentRuns is excluded: it is a read-only backend counter, not user-configurable.
    metadata: toNodeMetadata(node),
  };
}

function toNoteComparable(node: NoteGraphNode): unknown {
  return {
    node_name: node.node_name,
    content: node.data.content,
    metadata: { ...toNodeMetadata(node), backgroundColor: node.data.backgroundColor ?? null },
  };
}

function toCdtComparable(node: ClassificationDecisionTableGraphNode, allNodes: GraphNode[]): unknown {
  const tableData = node.data?.table;
  const resolveRef = (uuid: string | null): number | `temp:${string}` | null => {
    if (!uuid) return null;
    const backendId = allNodes.find((candidate) => candidate.id === uuid)?.backendId ?? null;
    return backendId != null ? backendId : (`temp:${uuid}` as const);
  };

  const preCode = tableData?.pre_computation?.code || tableData?.pre_computation_code || null;
  const postCode = tableData?.post_computation?.code || tableData?.post_computation_code || null;

  return {
    node_name: node.node_name,
    pre_computation_code: preCode,
    condition_groups: [...(tableData?.condition_groups || [])]
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
      .map((group: CdtConditionGroupState, index) => ({
        group_name: group.group_name,
        order: typeof group.order === 'number' ? group.order : index + 1,
        expression: group.expression || null,
        prompt_id: group.prompt_id || null,
        manipulation: group.manipulation || null,
        continue_flag: !!(group.continue_flag ?? group.continue),
        route_code: group.route_code || null,
        section: group.section ?? null,
        next_node_id: resolveRef(group.next_node ?? null),
        dock_visible: group.dock_visible !== false,
        field_expressions: group.field_expressions || {},
        field_manipulations: (group.field_manipulations || {}) as Record<string, string>,
      })),
    prompt_configs: Object.entries(tableData?.prompts || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, config]) => ({
        prompt_key: key,
        prompt_text: config.prompt_text ?? '',
        llm_config: config.llm_config ?? null,
        output_schema: config.output_schema ?? null,
        result_variable: config.result_variable ?? '',
        variable_mappings: config.variable_mappings ?? {},
      })),
    default_llm_config: tableData?.default_llm_config ?? null,
    default_next_node: tableData?.default_next_node || null,
    next_error_node: tableData?.next_error_node || null,
    pre_input_map: tableData?.pre_computation?.input_map || tableData?.pre_input_map || {},
    pre_output_variable_path:
      tableData?.pre_computation?.output_variable_path || tableData?.pre_output_variable_path || null,
    post_computation_code: postCode,
    post_input_map: tableData?.post_computation?.input_map || tableData?.post_input_map || {},
    post_output_variable_path:
      tableData?.post_computation?.output_variable_path || tableData?.post_output_variable_path || null,
    pre_libraries: tableData?.pre_computation?.libraries || [],
    post_libraries: tableData?.post_computation?.libraries || [],
    metadata: toNodeMetadata(node),
  };
}

export function getNodeDiff(previous: GraphState, current: GraphState): NodeDiffByType {
  return {
    startNodes: diffNodesByBackendId(
      nodesByType<StartGraphNode>(previous.nodes, 'start'),
      nodesByType<StartGraphNode>(current.nodes, 'start'),
      toStartComparable
    ),
    crewNodes: diffNodesByBackendId(
      nodesByType<CrewGraphNode>(previous.nodes, 'crew'),
      nodesByType<CrewGraphNode>(current.nodes, 'crew'),
      toCrewComparable
    ),
    pythonNodes: diffNodesByBackendId(
      nodesByType<PythonGraphNode>(previous.nodes, 'python'),
      nodesByType<PythonGraphNode>(current.nodes, 'python'),
      toPythonComparable
    ),
    taskNodes: diffNodesByBackendId(
      nodesByType<TaskGraphNode>(previous.nodes, 'task'),
      nodesByType<TaskGraphNode>(current.nodes, 'task'),
      toTaskComparable
    ),
    agentNodes: diffNodesByBackendId(
      nodesByType<AgentGraphNode>(previous.nodes, 'agent'),
      nodesByType<AgentGraphNode>(current.nodes, 'agent'),
      toAgentComparable
    ),
    fileExtractorNodes: diffNodesByBackendId(
      nodesByType<FileExtractorGraphNode>(previous.nodes, 'file-extractor'),
      nodesByType<FileExtractorGraphNode>(current.nodes, 'file-extractor'),
      toFileExtractorComparable
    ),
    audioToTextNodes: diffNodesByBackendId(
      nodesByType<AudioToTextGraphNode>(previous.nodes, 'audio-to-text'),
      nodesByType<AudioToTextGraphNode>(current.nodes, 'audio-to-text'),
      toAudioToTextComparable
    ),
    endNodes: diffNodesByBackendId(
      nodesByType<EndGraphNode>(previous.nodes, 'end'),
      nodesByType<EndGraphNode>(current.nodes, 'end'),
      toEndComparable
    ),
    subgraphNodes: diffNodesByBackendId(
      nodesByType<SubgraphGraphNode>(previous.nodes, 'subgraph'),
      nodesByType<SubgraphGraphNode>(current.nodes, 'subgraph'),
      toSubgraphComparable
    ),
    webhookNodes: diffNodesByBackendId(
      nodesByType<WebhookTriggerGraphNode>(previous.nodes, 'webhook-trigger'),
      nodesByType<WebhookTriggerGraphNode>(current.nodes, 'webhook-trigger'),
      toWebhookComparable
    ),
    telegramNodes: diffNodesByBackendId(
      nodesByType<TelegramTriggerGraphNode>(previous.nodes, 'telegram-trigger'),
      nodesByType<TelegramTriggerGraphNode>(current.nodes, 'telegram-trigger'),
      toTelegramComparable
    ),
    scheduleNodes: diffNodesByBackendId(
      nodesByType<ScheduleTriggerGraphNode>(previous.nodes, 'schedule-trigger'),
      nodesByType<ScheduleTriggerGraphNode>(current.nodes, 'schedule-trigger'),
      toScheduleComparable
    ),
    decisionTableNodes: diffNodesByBackendId(
      nodesByType<DecisionTableGraphNode>(previous.nodes, 'decision-table'),
      nodesByType<DecisionTableGraphNode>(current.nodes, 'decision-table'),
      (node) => toDecisionTableComparable(node, current.nodes)
    ),
    noteNodes: diffNodesByBackendId(
      nodesByType<NoteGraphNode>(previous.nodes, 'note'),
      nodesByType<NoteGraphNode>(current.nodes, 'note'),
      toNoteComparable
    ),
    classificationDecisionTableNodes: diffNodesByBackendId(
      nodesByType<ClassificationDecisionTableGraphNode>(previous.nodes, 'classification-decision-table'),
      nodesByType<ClassificationDecisionTableGraphNode>(current.nodes, 'classification-decision-table'),
      (node) => toCdtComparable(node, current.nodes)
    ),
  };
}

/**
 * Plain (persistable) connections: both endpoints must exist, and branch connections
 * originating from decision-table / classification-decision-table nodes are excluded —
 * those are persisted as `next_node_id` / `next_node_temp_id` refs, not edges.
 */
function getPlainConnections(state: GraphState): GraphEdgeState[] {
  const nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  return state.edges.filter((edge) => {
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);
    if (!source || !target) return false;
    if (source.type === 'decision-table' || source.type === 'classification-decision-table') return false;
    return true;
  });
}

export function getConnectionDiff(
  previous: GraphState,
  current: GraphState,
  idMap: Map<string, number>
): ConnectionDiff {
  const previousEdges = getPlainConnections(previous);
  const currentEdges = getPlainConnections(current);
  const previousNodeIdMap = buildUuidToBackendIdMap(previous.nodes);
  const toNodeRefKey = (backendId: number | undefined, nodeUuid: string): string =>
    backendId != null ? String(backendId) : nodeUuid;

  const previousByKey = new Map<string, GraphEdgeState>();
  for (const edge of previousEdges) {
    const source = previousNodeIdMap.get(edge.sourceNodeId);
    const target = previousNodeIdMap.get(edge.targetNodeId);
    if (source != null && target != null) {
      previousByKey.set(`${toNodeRefKey(source, edge.sourceNodeId)}__${toNodeRefKey(target, edge.targetNodeId)}`, edge);
    }
  }

  const currentByKey = new Map<string, GraphEdgeState>();
  for (const edge of currentEdges) {
    const source = idMap.get(edge.sourceNodeId);
    const target = idMap.get(edge.targetNodeId);
    currentByKey.set(`${toNodeRefKey(source, edge.sourceNodeId)}__${toNodeRefKey(target, edge.targetNodeId)}`, edge);
  }

  const toDelete: GraphEdgeState[] = [];
  for (const [key, edge] of previousByKey) {
    if (!currentByKey.has(key)) toDelete.push(edge);
  }

  const toCreate: GraphEdgeState[] = [];
  for (const [key, edge] of currentByKey) {
    if (!previousByKey.has(key)) toCreate.push(edge);
  }

  const toUpdate: GraphEdgeState[] = [];
  for (const [key, currentEdge] of currentByKey) {
    const previousEdge = previousByKey.get(key);
    if (!previousEdge || currentEdge.backendId == null) continue;
    if (!hasPersistedWaypoints(currentEdge) && !hasPersistedWaypoints(previousEdge)) continue;
    if (waypointsChanged(previousEdge.waypoints, currentEdge.waypoints)) {
      toUpdate.push(currentEdge);
    }
  }

  return { toCreate, toDelete, toUpdate };
}
