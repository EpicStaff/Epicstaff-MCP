import { describe, expect, it } from 'vitest';

import { buildBulkSavePayload } from './bulk-save.js';
import type {
  AgentGraphNode,
  ClassificationDecisionTableGraphNode,
  CrewGraphNode,
  DecisionTableGraphNode,
  GraphNodeBase,
  GraphState,
  NoteGraphNode,
  PythonGraphNode,
  StartGraphNode,
  TaskGraphNode,
} from './graph-state.js';

function baseNode(id: string, backendId: number | null, nodeName: string, x: number, y: number): GraphNodeBase {
  return {
    id,
    backendId,
    node_name: nodeName,
    position: { x, y },
    color: '#123456',
    icon: 'ti-node',
    size: { width: 200, height: 100 },
    input_map: {},
    output_variable_path: null,
  };
}

function metadataOf(node: GraphNodeBase): Record<string, unknown> {
  return {
    position: node.position,
    color: node.color,
    icon: node.icon,
    size: node.size,
    ...(node.nodeNumber != null ? { nodeNumber: node.nodeNumber } : {}),
  };
}

const emptyDeleted = {
  start_node_ids: [],
  crew_node_ids: [],
  python_node_ids: [],
  task_node_ids: [],
  agent_node_ids: [],
  llm_node_ids: [],
  file_extractor_node_ids: [],
  audio_transcription_node_ids: [],
  end_node_ids: [],
  subgraph_node_ids: [],
  webhook_trigger_node_ids: [],
  telegram_trigger_node_ids: [],
  schedule_trigger_node_ids: [],
  decision_table_node_ids: [],
  graph_note_ids: [],
  code_agent_node_ids: [],
  classification_decision_table_node_ids: [],
  edge_ids: [],
};

describe('buildBulkSavePayload', () => {
  it('emits the exact wire payload for a mixed create/update/delete graph', () => {
    const startNode: StartGraphNode = {
      ...baseNode('start-1', 1, '__start__', 0, 0),
      type: 'start',
      data: { initialState: { topic: 'ai' } },
    };
    const pythonNode: PythonGraphNode = {
      ...baseNode('py-1', 2, 'Transform', 100, 0),
      type: 'python',
      data: { name: 'transform', libraries: [], code: 'def main(x): return x', entrypoint: 'main' },
      test_input: {},
    };
    const taskNode: TaskGraphNode = {
      ...baseNode('task-legacy', 5, 'Summarize', 400, 0),
      type: 'task',
      data: {
        name: 'Summarize',
        instructions: 'Summarize the input',
        output_schema: {},
        remember_output: false,
        agent_definition: 7,
        surface_list: [],
        inline_surface: null,
      },
    };
    const remoteNote: NoteGraphNode = {
      ...baseNode('note-1', 3, 'Note', 600, 0),
      type: 'note',
      data: { content: 'hello', backgroundColor: '#111111' },
    };
    const desiredNote: NoteGraphNode = {
      ...remoteNote,
      data: { content: 'hello', backgroundColor: '#222222' },
    };
    const crewNode: CrewGraphNode = {
      ...baseNode('crew-1', 4, 'Old Crew', 800, 0),
      type: 'crew',
      data: { id: 9 },
    };
    const agentNode: AgentGraphNode = {
      ...baseNode('agent-temp-1', null, 'Agent', 250, 120),
      nodeNumber: 6,
      input_map: { query: 'variables.topic' },
      output_variable_path: 'variables.agent_out',
      type: 'agent',
      data: {
        agent_definition: 10,
        surface_list: [3],
        inline_surface: null,
        tasks: [
          { tempId: 't-1', name: 'Research', instructions: 'Research the topic', output_schema: {}, contextRefs: [] },
          {
            tempId: 't-2',
            name: 'Write',
            instructions: 'Write the report',
            output_schema: { report: 'string' },
            contextRefs: [{ tempId: 't-1' }],
          },
        ],
      },
    };
    const decisionTableNode: DecisionTableGraphNode = {
      ...baseNode('dt-temp-1', null, 'Router', 250, -120),
      type: 'decision-table',
      data: {
        name: 'Router',
        table: {
          condition_groups: [
            {
              group_name: 'to-agent',
              group_type: 'simple',
              expression: null,
              conditions: [{ condition_name: 'c1', condition: 'x > 1' }],
              manipulation: null,
              next_node: 'agent-temp-1',
              order: 2,
            },
            {
              group_name: 'invalid',
              group_type: 'simple',
              expression: null,
              conditions: [],
              manipulation: null,
              next_node: null,
              valid: false,
            },
            {
              group_name: 'first',
              group_type: 'complex',
              expression: 'a and b',
              conditions: [],
              manipulation: 'x = 1',
              next_node: 'task-legacy',
              order: 1,
            },
          ],
          default_next_node: 'task-legacy',
          next_error_node: null,
        },
      },
    };

    const remote: GraphState = {
      nodes: [startNode, pythonNode, taskNode, remoteNote, crewNode],
      edges: [
        { sourceNodeId: 'start-1', targetNodeId: 'py-1', backendId: 100, metadata: {} },
        { sourceNodeId: 'py-1', targetNodeId: 'crew-1', backendId: 101, metadata: {} },
      ],
    };
    const desired: GraphState = {
      nodes: [startNode, pythonNode, taskNode, desiredNote, agentNode, decisionTableNode],
      edges: [
        { sourceNodeId: 'start-1', targetNodeId: 'py-1', backendId: 100, metadata: {} },
        { sourceNodeId: 'py-1', targetNodeId: 'agent-temp-1' },
        {
          sourceNodeId: 'agent-temp-1',
          targetNodeId: 'task-legacy',
          waypoints: [{ x: 10, y: 20 }],
          userAdjustedWaypoints: true,
        },
      ],
    };

    const payload = buildBulkSavePayload({ graphId: 42, desired, remote, saveVersion: 7 });

    expect(payload).toStrictEqual({
      save_version: 7,
      start_node_list: [],
      crew_node_list: [],
      python_node_list: [],
      task_node_list: [],
      agent_node_list: [
        {
          id: null,
          temp_id: 'agent-temp-1',
          node_name: 'Agent',
          graph: 42,
          agent_definition: 10,
          input_map: { query: 'variables.topic' },
          output_variable_path: 'variables.agent_out',
          surface_list: [3],
          inline_surface: null,
          tasks: [
            {
              temp_id: 't-1',
              name: 'Research',
              order: 0,
              instructions: 'Research the topic',
              output_schema: {},
              context_task_ids: [],
              context_task_temp_ids: [],
            },
            {
              temp_id: 't-2',
              name: 'Write',
              order: 1,
              instructions: 'Write the report',
              output_schema: { report: 'string' },
              context_task_ids: [],
              context_task_temp_ids: ['t-1'],
            },
          ],
          metadata: metadataOf(agentNode),
        },
      ],
      file_extractor_node_list: [],
      audio_transcription_node_list: [],
      end_node_list: [],
      subgraph_node_list: [],
      webhook_trigger_node_list: [],
      telegram_trigger_node_list: [],
      schedule_trigger_node_list: [],
      decision_table_node_list: [
        {
          id: null,
          temp_id: 'dt-temp-1',
          graph: 42,
          node_name: 'Router',
          condition_groups: [
            {
              group_name: 'first',
              group_type: 'complex',
              expression: 'a and b',
              conditions: [],
              manipulation: 'x = 1',
              next_node_id: 5,
              order: 1,
            },
            {
              group_name: 'to-agent',
              group_type: 'simple',
              expression: null,
              conditions: [{ condition_name: 'c1', condition: 'x > 1' }],
              manipulation: null,
              next_node_id: null,
              next_node_temp_id: 'agent-temp-1',
              order: 2,
            },
          ],
          default_next_node_id: 5,
          next_error_node_id: null,
          metadata: metadataOf(decisionTableNode),
        },
      ],
      graph_note_list: [
        {
          id: 3,
          node_name: 'Note',
          graph: 42,
          content: 'hello',
          metadata: { ...metadataOf(desiredNote), backgroundColor: '#222222' },
        },
      ],
      classification_decision_table_node_list: [],
      edge_list: [
        { graph: 42, start_node_id: 2, end_temp_id: 'agent-temp-1' },
        { graph: 42, start_temp_id: 'agent-temp-1', end_node_id: 5, metadata: { waypoints: [{ x: 10, y: 20 }] } },
      ],
      deleted: { ...emptyDeleted, crew_node_ids: [4], edge_ids: [101] },
    });
  });

  it('builds classification-decision-table items with route/default port fallbacks and code blocks', () => {
    const taskNode: TaskGraphNode = {
      ...baseNode('task-legacy', 5, 'Summarize', 400, 0),
      type: 'task',
      data: {
        instructions: 'Summarize the input',
        agent_definition: null,
        surface_list: [],
        inline_surface: null,
      },
    };
    const cdtNode: ClassificationDecisionTableGraphNode = {
      ...baseNode('cdt-1', null, 'Classifier', 200, 200),
      type: 'classification-decision-table',
      data: {
        table: {
          condition_groups: [
            {
              group_name: 'yes',
              order: 1,
              prompt_id: 'p1',
              route_code: 'Yes',
              continue: true,
              field_expressions: {
                status: { field: 'status', operator: '==', value: 'ok' },
                count: 5,
              },
              field_manipulations: { x: 'x + 1' },
            },
          ],
          prompts: {
            p1: { prompt_text: 'Classify the input', llm_config: 11, result_variable: 'cls' },
          },
          default_llm_config: 11,
          pre_computation: {
            code: 'def main():\n    return 1',
            libraries: ['requests'],
            input_map: { a: 'variables.a' },
            output_variable_path: 'variables.pre',
          },
          post_computation: { code: '', libraries: [] },
        },
      },
    };

    const remote: GraphState = { nodes: [taskNode], edges: [] };
    const desired: GraphState = {
      nodes: [taskNode, cdtNode],
      edges: [
        { sourceNodeId: 'cdt-1', targetNodeId: 'task-legacy', sourcePortId: 'cdt-1_decision-route-yes' },
        { sourceNodeId: 'cdt-1', targetNodeId: 'task-legacy', sourcePortId: 'cdt-1_decision-default' },
      ],
    };

    const payload = buildBulkSavePayload({ graphId: 42, desired, remote, saveVersion: 3 });

    // Branch connections from decision tables are refs, never wire edges.
    expect(payload.edge_list).toStrictEqual([]);
    expect(payload.classification_decision_table_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'cdt-1',
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
        condition_groups: [
          {
            group_name: 'yes',
            order: 1,
            expression: null,
            prompt_id: 'p1',
            manipulation: null,
            continue_flag: true,
            route_code: 'Yes',
            section: null,
            next_node_id: 5,
            dock_visible: true,
            field_expressions: { status: '== "ok"', count: '5' },
            field_manipulations: { x: 'x + 1' },
          },
        ],
        metadata: metadataOf(cdtNode),
      },
    ]);
    expect(payload.deleted).toStrictEqual(emptyDeleted);
  });

  it('emits create items for every remaining node type with the exact per-type field set', () => {
    const nodes = {
      python: {
        ...baseNode('py-new', null, 'Py', 0, 0),
        type: 'python',
        data: { id: 77, name: 'code', libraries: ['numpy'], code: 'def main(): pass', entrypoint: 'main', use_storage: true },
        stream_config: { stdout: true },
        test_input: { n: 1 },
      },
      end: { ...baseNode('end-new', null, '__end__', 0, 1), type: 'end', data: {} },
      subgraph: { ...baseNode('sub-new', null, 'Sub', 0, 2), type: 'subgraph', data: { id: 55 } },
      webhook: {
        ...baseNode('wh-new', null, 'Hook', 0, 3),
        type: 'webhook-trigger',
        data: {
          webhook_trigger: { path: 'hook', ngrok_webhook_config: null },
          python_code: { name: 'hook', libraries: [], code: 'c', entrypoint: 'main' },
        },
      },
      telegram: {
        ...baseNode('tg-new', null, 'Bot', 0, 4),
        type: 'telegram-trigger',
        data: {
          telegram_bot_api_key: 'key',
          webhook_trigger: null,
          fields: [{ parent: 'message', field_name: 'text', variable_path: 'variables.text' }],
        },
      },
      fileExtractor: { ...baseNode('fx-new', null, 'Extract', 0, 5), type: 'file-extractor' },
      audio: { ...baseNode('au-new', null, 'Transcribe', 0, 6), type: 'audio-to-text' },
      crew: { ...baseNode('crew-new', null, 'Crew', 0, 7), type: 'crew', data: { id: 9 } },
      scheduleDraft: {
        ...baseNode('sched-draft', null, 'Draft schedule', 0, 8),
        type: 'schedule-trigger',
        data: {
          isActive: true,
          runMode: 'once',
          startDateTime: '',
          intervalEvery: null,
          intervalUnit: null,
          weekdays: [],
          endType: 'never',
          endDateTime: null,
          maxRuns: null,
          timezone: 'UTC',
        },
      },
      scheduleRepeat: {
        ...baseNode('sched-repeat', null, 'Repeat schedule', 0, 9),
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
    } as const satisfies Record<string, GraphState['nodes'][number]>;

    const desired: GraphState = { nodes: Object.values(nodes), edges: [] };
    const payload = buildBulkSavePayload({
      graphId: 42,
      desired,
      remote: { nodes: [], edges: [] },
      saveVersion: 1,
    });

    expect(payload.python_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'py-new',
        node_name: 'Py',
        graph: 42,
        python_code: { id: 77, name: 'code', libraries: ['numpy'], code: 'def main(): pass', entrypoint: 'main' },
        input_map: {},
        output_variable_path: null,
        stream_config: { stdout: true },
        use_storage: true,
        test_input: { n: 1 },
        metadata: metadataOf(nodes.python),
      },
    ]);
    expect(payload.end_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'end-new',
        graph: 42,
        output_map: { context: 'variables.context' },
        metadata: metadataOf(nodes.end),
      },
    ]);
    expect(payload.subgraph_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'sub-new',
        node_name: 'Sub',
        graph: 42,
        subgraph: 55,
        input_map: {},
        output_variable_path: null,
        metadata: metadataOf(nodes.subgraph),
      },
    ]);
    expect(payload.webhook_trigger_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'wh-new',
        node_name: 'Hook',
        graph: 42,
        python_code: { name: 'hook', libraries: [], code: 'c', entrypoint: 'main' },
        input_map: {},
        output_variable_path: null,
        webhook_trigger_path: '',
        webhook_trigger: { path: 'hook', ngrok_webhook_config: null },
        metadata: metadataOf(nodes.webhook),
      },
    ]);
    expect(payload.telegram_trigger_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'tg-new',
        node_name: 'Bot',
        graph: 42,
        telegram_bot_api_key: 'key',
        webhook_trigger: null,
        fields: [{ parent: 'message', field_name: 'text', variable_path: 'variables.text' }],
        metadata: metadataOf(nodes.telegram),
      },
    ]);
    expect(payload.file_extractor_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'fx-new',
        node_name: 'Extract',
        graph: 42,
        input_map: {},
        output_variable_path: null,
        metadata: metadataOf(nodes.fileExtractor),
      },
    ]);
    expect(payload.audio_transcription_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'au-new',
        node_name: 'Transcribe',
        graph: 42,
        input_map: {},
        output_variable_path: null,
        metadata: metadataOf(nodes.audio),
      },
    ]);
    expect(payload.crew_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'crew-new',
        node_name: 'Crew',
        graph: 42,
        crew_id: 9,
        input_map: {},
        output_variable_path: null,
        stream_config: {},
        metadata: metadataOf(nodes.crew),
      },
    ]);
    expect(payload.schedule_trigger_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'sched-draft',
        node_name: 'Draft schedule',
        graph: 42,
        is_active: false,
        metadata: metadataOf(nodes.scheduleDraft),
        schedule: null,
      },
      {
        id: null,
        temp_id: 'sched-repeat',
        node_name: 'Repeat schedule',
        graph: 42,
        is_active: true,
        metadata: metadataOf(nodes.scheduleRepeat),
        schedule: {
          run_mode: 'repeat',
          start_date_time: '2026-07-14T09:00:00Z',
          interval: { every: 2, unit: 'days', weekdays: ['mon', 'fri'] },
          end: { type: 'after_n_runs', date_time: null, max_runs: 10 },
          timezone: 'Europe/Kyiv',
        },
      },
    ]);
  });
});
