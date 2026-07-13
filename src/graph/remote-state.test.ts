import { describe, expect, it } from 'vitest';

import type { GraphDto } from '../models/graph.js';
import { buildUuidToBackendIdMap, getConnectionDiff, getNodeDiff, type NodeDiffByType } from './diff.js';
import type { GraphNodeBase, GraphNodeType, GraphState, TaskGraphNode } from './graph-state.js';
import { buildRemoteState, remoteNodeUuid } from './remote-state.js';

interface FixtureMeta {
  position: { x: number; y: number };
  color: string;
  icon: string;
  size: { width: number; height: number };
  nodeNumber?: number;
}

function meta(x: number, y: number, nodeNumber?: number): FixtureMeta {
  return {
    position: { x, y },
    color: '#123456',
    icon: 'ti-node',
    size: { width: 200, height: 100 },
    ...(nodeNumber != null ? { nodeNumber } : {}),
  };
}

function desiredBase(type: GraphNodeType, backendId: number, nodeName: string, m: FixtureMeta): GraphNodeBase {
  return {
    id: remoteNodeUuid(type, backendId),
    backendId,
    node_name: nodeName,
    position: m.position,
    color: m.color,
    icon: m.icon,
    size: m.size,
    ...(m.nodeNumber != null ? { nodeNumber: m.nodeNumber } : {}),
    input_map: {},
    output_variable_path: null,
  };
}

function expectEmptyNodeDiff(nodeDiff: NodeDiffByType, except?: keyof NodeDiffByType): void {
  for (const [key, bucket] of Object.entries(nodeDiff)) {
    if (key === except) continue;
    expect(bucket.toCreate, `${key}.toCreate`).toStrictEqual([]);
    expect(bucket.toUpdate, `${key}.toUpdate`).toStrictEqual([]);
    expect(bucket.toDelete, `${key}.toDelete`).toStrictEqual([]);
  }
}

// ── Shared fixture: a fully persisted graph + the desired state a pusher would hold ─

const mStart = meta(0, 0);
const mPython = meta(100, 0);
const mNote = meta(600, 0);
const mTask = meta(400, 0);
const mAgent = meta(250, 120, 6);
const mDt = meta(250, -120);
const mCdt = meta(200, 200);
const mSchedule = meta(0, 300);
const mWebhook = meta(0, 400);
const mTelegram = meta(0, 500);
const mSubgraph = meta(0, 600);
const mFileExtractor = meta(0, 700);
const mAudio = meta(0, 800);
const mEnd = meta(900, 0);
const mCrew = meta(0, 900);

const uuidTask = remoteNodeUuid('task', 5);
const uuidAgent = remoteNodeUuid('agent', 6);

// Wire python_code objects carry `name` (echoed by the backend); canonical key order.
const transformCode = { id: 70, name: 'transform', libraries: [], code: 'def main(x): return x', entrypoint: 'main' };
const hookCode = { id: 80, name: 'hook', libraries: [], code: 'c', entrypoint: 'main' };
const hookTrigger = { path: 'hook', ngrok_webhook_config: null };
const crewStreamConfig = { stdout: true };
const endOutputMap = { context: 'variables.context' };
const waypoints = [{ x: 10, y: 20 }];

function makeDto(): GraphDto {
  return {
    id: 42,
    uuid: 'graph-uuid',
    name: 'graph',
    description: '',
    save_version: 8,
    metadata: {},
    conditional_edge_list: [],
    start_node_list: [{ id: 1, graph: 42, node_name: '__start__', variables: { topic: 'ai' }, metadata: mStart }],
    crew_node_list: [
      {
        id: 16,
        node_name: 'Crew',
        graph: 42,
        crew: { id: 9, name: 'My crew' },
        input_map: {},
        output_variable_path: null,
        stream_config: crewStreamConfig,
        metadata: mCrew,
      },
    ],
    python_node_list: [
      {
        id: 2,
        node_name: 'Transform',
        graph: 42,
        python_code: transformCode,
        input_map: {},
        test_input: {},
        output_variable_path: null,
        metadata: mPython,
      },
    ],
    task_node_list: [
      {
        id: 5,
        created_at: '',
        updated_at: '',
        metadata: mTask,
        node_name: 'Summarize',
        graph: 42,
        input_map: {},
        output_variable_path: null,
        instructions: 'Summarize the input',
        output_schema: {},
        remember_output: false,
        agent_definition: 7,
        surface_list: [],
        inline_surface: null,
      },
    ],
    agent_node_list: [
      {
        id: 6,
        metadata: mAgent,
        node_name: 'Agent',
        graph: 42,
        input_map: { query: 'variables.topic' },
        output_variable_path: 'variables.agent_out',
        agent_definition: 10,
        surface_list: [3],
        inline_surface: null,
        tasks: [
          { id: 101, name: 'Research', order: 0, instructions: 'Research the topic', output_schema: {}, context_tasks: [] },
          {
            id: 102,
            name: 'Write',
            order: 1,
            instructions: 'Write the report',
            output_schema: { report: 'string' },
            context_tasks: [101],
          },
        ],
      },
    ],
    graph_note_list: [
      { id: 3, node_name: 'Note', graph: 42, content: 'hello', metadata: { ...mNote, backgroundColor: '#222222' } },
    ],
    decision_table_node_list: [
      {
        id: 7,
        graph: 42,
        node_name: 'Router',
        condition_groups: [
          {
            id: 200,
            decision_table_node: 7,
            group_name: 'first',
            group_type: 'complex',
            expression: 'a and b',
            conditions: [],
            manipulation: 'x = 1',
            next_node_id: 5,
            order: 1,
          },
          {
            id: 201,
            decision_table_node: 7,
            group_name: 'to-agent',
            group_type: 'simple',
            expression: null,
            conditions: [{ id: 300, condition_group: 201, condition_name: 'c1', condition: 'x > 1' }],
            manipulation: null,
            next_node_id: 6,
            order: 2,
          },
        ],
        default_next_node_id: 5,
        next_error_node_id: null,
        metadata: mDt,
      },
    ],
    classification_decision_table_node_list: [
      {
        id: 8,
        graph: 42,
        node_name: 'Classifier',
        pre_python_code: {
          code: 'def main():\n    return 1',
          libraries: ['requests'],
          entrypoint: 'main',
          global_kwargs: {},
        },
        pre_input_map: { a: 'variables.a' },
        pre_output_variable_path: 'variables.pre',
        post_python_code: null,
        post_input_map: {},
        post_output_variable_path: null,
        prompt_configs: [
          {
            id: 400,
            prompt_key: 'p1',
            prompt_text: 'Classify the input',
            llm_config: 11,
            output_schema: {},
            result_variable: 'cls',
            variable_mappings: {},
          },
        ],
        default_llm_config: 11,
        default_next_node_id: 5,
        next_error_node_id: null,
        condition_groups: [
          {
            id: 500,
            classification_decision_table_node: 8,
            group_name: 'yes',
            order: 1,
            expression: null,
            prompt_id: 'p1',
            manipulation: null,
            continue_flag: true,
            route_code: 'Yes',
            dock_visible: true,
            field_expressions: { status: '== "ok"', count: '5' },
            field_manipulations: { x: 'x + 1' },
            next_node_id: 5,
            section: null,
          },
        ],
        metadata: mCdt,
      },
    ],
    schedule_trigger_node_list: [
      {
        id: 9,
        node_name: 'Repeat schedule',
        graph: 42,
        is_active: true,
        metadata: mSchedule,
        content_hash: '',
        created_at: '',
        updated_at: '',
        current_runs: 0,
        schedule: {
          run_mode: 'repeat',
          timezone: 'Europe/Kyiv',
          start_date_time: '2026-07-14T09:00:00Z',
          next_run_date_time: null,
          interval: { every: 2, unit: 'days', weekdays: ['mon', 'fri'] },
          end: { type: 'after_n_runs', date_time: null, max_runs: 10 },
        },
      },
    ],
    webhook_trigger_node_list: [
      {
        id: 10,
        node_name: 'Hook',
        graph: 42,
        python_code: hookCode,
        input_map: {},
        output_variable_path: null,
        webhook_trigger_path: 'wh/abc',
        metadata: mWebhook,
        webhook_trigger: hookTrigger,
      },
    ],
    telegram_trigger_node_list: [
      {
        id: 11,
        node_name: 'Bot',
        graph: 42,
        telegram_bot_api_key: 'key',
        fields: [{ id: 90, parent: 'message', field_name: 'text', variable_path: 'variables.text' }],
        metadata: mTelegram,
        webhook_trigger: null,
      },
    ],
    subgraph_node_list: [
      {
        id: 12,
        node_name: 'Sub',
        graph: 42,
        subgraph: 55,
        input_map: {},
        output_variable_path: null,
        metadata: mSubgraph,
      },
    ],
    file_extractor_node_list: [
      { id: 13, node_name: 'Extract', graph: 42, input_map: {}, output_variable_path: null, metadata: mFileExtractor },
    ],
    audio_transcription_node_list: [
      { id: 14, node_name: 'Transcribe', graph: 42, input_map: {}, output_variable_path: null, metadata: mAudio },
    ],
    end_node_list: [{ id: 15, graph: 42, output_map: endOutputMap, metadata: mEnd, node_name: '__end_node__' }],
    edge_list: [
      { id: 100, start_node_id: 1, end_node_id: 2, graph: 42, metadata: {} },
      { id: 101, start_node_id: 2, end_node_id: 5, graph: 42, metadata: { waypoints } },
    ],
  };
}

/** The state a pusher holds for the same content, in the remote uuid space. */
function makeDesired(): GraphState {
  return {
    nodes: [
      { ...desiredBase('start', 1, '__start__', mStart), type: 'start', data: { initialState: { topic: 'ai' } } },
      {
        ...desiredBase('crew', 16, 'Crew', mCrew),
        type: 'crew',
        data: { id: 9 },
        stream_config: crewStreamConfig,
      },
      {
        ...desiredBase('python', 2, 'Transform', mPython),
        type: 'python',
        data: { ...transformCode },
        test_input: {},
      },
      {
        ...desiredBase('task', 5, 'Summarize', mTask),
        type: 'task',
        data: {
          instructions: 'Summarize the input',
          output_schema: {},
          remember_output: false,
          agent_definition: 7,
          surface_list: [],
          inline_surface: null,
        },
      },
      {
        ...desiredBase('agent', 6, 'Agent', mAgent),
        input_map: { query: 'variables.topic' },
        output_variable_path: 'variables.agent_out',
        type: 'agent',
        data: {
          agent_definition: 10,
          surface_list: [3],
          inline_surface: null,
          tasks: [
            {
              id: 101,
              tempId: 't-1',
              name: 'Research',
              instructions: 'Research the topic',
              output_schema: {},
              contextRefs: [],
            },
            {
              id: 102,
              tempId: 't-2',
              name: 'Write',
              instructions: 'Write the report',
              output_schema: { report: 'string' },
              contextRefs: [{ id: 101 }],
            },
          ],
        },
      },
      {
        ...desiredBase('note', 3, 'Note', mNote),
        type: 'note',
        data: { content: 'hello', backgroundColor: '#222222' },
      },
      {
        ...desiredBase('decision-table', 7, 'Router', mDt),
        type: 'decision-table',
        data: {
          table: {
            condition_groups: [
              {
                group_name: 'first',
                group_type: 'complex',
                expression: 'a and b',
                conditions: [],
                manipulation: 'x = 1',
                next_node: uuidTask,
                order: 1,
              },
              {
                group_name: 'to-agent',
                group_type: 'simple',
                expression: null,
                conditions: [{ condition_name: 'c1', condition: 'x > 1' }],
                manipulation: null,
                next_node: uuidAgent,
                order: 2,
              },
            ],
            default_next_node: uuidTask,
            next_error_node: null,
          },
        },
      },
      {
        ...desiredBase('classification-decision-table', 8, 'Classifier', mCdt),
        type: 'classification-decision-table',
        data: {
          table: {
            condition_groups: [
              {
                group_name: 'yes',
                order: 1,
                expression: null,
                prompt_id: 'p1',
                manipulation: null,
                continue_flag: true,
                route_code: 'Yes',
                next_node: uuidTask,
                dock_visible: true,
                field_expressions: { status: '== "ok"', count: '5' },
                field_manipulations: { x: 'x + 1' },
                section: null,
              },
            ],
            prompts: {
              p1: {
                prompt_text: 'Classify the input',
                llm_config: 11,
                output_schema: {},
                result_variable: 'cls',
                variable_mappings: {},
              },
            },
            default_llm_config: 11,
            default_next_node: uuidTask,
            next_error_node: null,
            pre_computation: {
              code: 'def main():\n    return 1',
              libraries: ['requests'],
              input_map: { a: 'variables.a' },
              output_variable_path: 'variables.pre',
            },
            post_computation: { code: '', libraries: [], input_map: {}, output_variable_path: null },
          },
        },
      },
      {
        ...desiredBase('schedule-trigger', 9, 'Repeat schedule', mSchedule),
        type: 'schedule-trigger',
        data: {
          isActive: true,
          runMode: 'repeat',
          startDateTime: '2026-07-14T09:00:00Z',
          intervalEvery: 2,
          intervalUnit: 'days',
          weekdays: ['mon', 'fri'],
          endType: 'after_n_runs',
          endDateTime: null,
          maxRuns: 10,
          timezone: 'Europe/Kyiv',
        },
      },
      {
        ...desiredBase('webhook-trigger', 10, 'Hook', mWebhook),
        type: 'webhook-trigger',
        data: { webhook_trigger: hookTrigger, python_code: { ...hookCode } },
      },
      {
        ...desiredBase('telegram-trigger', 11, 'Bot', mTelegram),
        type: 'telegram-trigger',
        data: {
          telegram_bot_api_key: 'key',
          webhook_trigger: null,
          fields: [{ id: 90, parent: 'message', field_name: 'text', variable_path: 'variables.text' }],
        },
      },
      { ...desiredBase('subgraph', 12, 'Sub', mSubgraph), type: 'subgraph', data: { id: 55 } },
      { ...desiredBase('file-extractor', 13, 'Extract', mFileExtractor), type: 'file-extractor' },
      { ...desiredBase('audio-to-text', 14, 'Transcribe', mAudio), type: 'audio-to-text' },
      { ...desiredBase('end', 15, '__end__', mEnd), type: 'end', data: { output_map: endOutputMap } },
    ],
    edges: [
      {
        sourceNodeId: remoteNodeUuid('start', 1),
        targetNodeId: remoteNodeUuid('python', 2),
        backendId: 100,
        metadata: {},
      },
      {
        sourceNodeId: remoteNodeUuid('python', 2),
        targetNodeId: uuidTask,
        backendId: 101,
        metadata: { waypoints },
        waypoints,
        userAdjustedWaypoints: true,
      },
    ],
  };
}

describe('buildRemoteState', () => {
  it('round-trips: an unchanged graph diffs clean against the remote baseline', () => {
    const remote = buildRemoteState(makeDto());
    const desired = makeDesired();

    expect(remote.nodes).toHaveLength(desired.nodes.length);
    expect(remote.edges).toHaveLength(2);

    const nodeDiff = getNodeDiff(remote, desired);
    expectEmptyNodeDiff(nodeDiff);

    const connectionDiff = getConnectionDiff(remote, desired, buildUuidToBackendIdMap(desired.nodes));
    expect(connectionDiff.toCreate).toStrictEqual([]);
    expect(connectionDiff.toDelete).toStrictEqual([]);
    expect(connectionDiff.toUpdate).toStrictEqual([]);
  });

  it('reconstructs branch refs in node state, never as edges', () => {
    const remote = buildRemoteState(makeDto());

    const decisionTable = remote.nodes.find((node) => node.type === 'decision-table');
    expect(decisionTable?.type).toBe('decision-table');
    if (decisionTable?.type !== 'decision-table') return;
    expect(decisionTable.data.table.default_next_node).toBe(uuidTask);
    expect(decisionTable.data.table.next_error_node).toBeNull();
    expect(decisionTable.data.table.condition_groups.map((group) => group.next_node)).toStrictEqual([
      uuidTask,
      uuidAgent,
    ]);

    const cdt = remote.nodes.find((node) => node.type === 'classification-decision-table');
    if (cdt?.type !== 'classification-decision-table') {
      expect.unreachable('classification-decision-table node missing');
      return;
    }
    expect(cdt.data.table.default_next_node).toBe(uuidTask);
    expect(cdt.data.table.condition_groups?.[0]?.next_node).toBe(uuidTask);

    // Only the two plain edges exist — no synthetic branch edges.
    expect(remote.edges.map((edge) => edge.backendId)).toStrictEqual([100, 101]);
    const waypointEdge = remote.edges[1]!;
    expect(waypointEdge.waypoints).toStrictEqual(waypoints);
    expect(waypointEdge.userAdjustedWaypoints).toBe(true);
  });

  it('detects exactly one update when a single field changes', () => {
    const remote = buildRemoteState(makeDto());
    const desired = makeDesired();

    const taskNode = desired.nodes.find((node) => node.type === 'task') as TaskGraphNode;
    taskNode.data.instructions = 'Summarize the input in French';

    const nodeDiff = getNodeDiff(remote, desired);
    expectEmptyNodeDiff(nodeDiff, 'taskNodes');
    expect(nodeDiff.taskNodes.toCreate).toStrictEqual([]);
    expect(nodeDiff.taskNodes.toDelete).toStrictEqual([]);
    expect(nodeDiff.taskNodes.toUpdate).toHaveLength(1);
    expect(nodeDiff.taskNodes.toUpdate[0]!.current.backendId).toBe(5);
    expect((nodeDiff.taskNodes.toUpdate[0]!.current as TaskGraphNode).data.instructions).toBe(
      'Summarize the input in French'
    );

    const connectionDiff = getConnectionDiff(remote, desired, buildUuidToBackendIdMap(desired.nodes));
    expect(connectionDiff.toCreate).toStrictEqual([]);
    expect(connectionDiff.toDelete).toStrictEqual([]);
    expect(connectionDiff.toUpdate).toStrictEqual([]);
  });
});
