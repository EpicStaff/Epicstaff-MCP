import { describe, expect, it } from 'vitest';

import type { GraphDto } from '../models/graph.js';
import type { GraphNodeBase, GraphState, NoteGraphNode, PythonGraphNode, StartGraphNode } from './graph-state.js';
import { applySaveResponse, mintTempId } from './temp-id.js';

function baseNode(id: string, backendId: number | null, nodeName: string): GraphNodeBase {
  return {
    id,
    backendId,
    node_name: nodeName,
    position: { x: 0, y: 0 },
    color: '#123456',
    icon: 'ti-node',
    size: { width: 200, height: 100 },
    input_map: {},
    output_variable_path: null,
  };
}

function pythonNode(id: string, backendId: number | null): PythonGraphNode {
  return {
    ...baseNode(id, backendId, `py ${id}`),
    type: 'python',
    data: { name: 'code', libraries: [], code: 'def main(): pass', entrypoint: 'main' },
    test_input: {},
  };
}

function pythonDto(id: number): GraphDto['python_node_list'][number] {
  return {
    id,
    node_name: `py ${id}`,
    graph: 42,
    python_code: { id: id * 10, libraries: [], code: 'def main(): pass', entrypoint: 'main' },
    input_map: {},
    test_input: {},
    output_variable_path: null,
    metadata: {},
  };
}

function makeGraphDto(partial: Partial<GraphDto>): GraphDto {
  return {
    id: 42,
    uuid: 'graph-uuid',
    name: 'graph',
    description: '',
    save_version: 8,
    start_node_list: [],
    crew_node_list: [],
    python_node_list: [],
    task_node_list: [],
    edge_list: [],
    conditional_edge_list: [],
    file_extractor_node_list: [],
    webhook_trigger_node_list: [],
    telegram_trigger_node_list: [],
    end_node_list: [],
    subgraph_node_list: [],
    decision_table_node_list: [],
    classification_decision_table_node_list: [],
    metadata: {},
    audio_transcription_node_list: [],
    graph_note_list: [],
    schedule_trigger_node_list: [],
    ...partial,
  };
}

describe('mintTempId', () => {
  it('mints unique uuid-format temp ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintTempId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe('applySaveResponse', () => {
  it('maps created nodes to newly appeared backend ids, per type and in order', () => {
    const existingPython = pythonNode('py-old', 2);
    const newPythonA = pythonNode('py-a', null);
    const newPythonB = pythonNode('py-b', null);
    const newNote: NoteGraphNode = {
      ...baseNode('note-a', null, 'Note'),
      type: 'note',
      data: { content: 'hi' },
    };
    const newStart: StartGraphNode = {
      ...baseNode('start-a', null, '__start__'),
      type: 'start',
      data: { initialState: {} },
    };

    const remote: GraphState = { nodes: [existingPython], edges: [] };
    const desired: GraphState = {
      nodes: [existingPython, newPythonA, newPythonB, newNote, newStart],
      edges: [],
    };

    const response = makeGraphDto({
      start_node_list: [{ id: 50, graph: 42, node_name: '__start__', variables: {}, metadata: {} }],
      python_node_list: [pythonDto(2), pythonDto(30), pythonDto(31)],
      graph_note_list: [{ id: 40, node_name: 'Note', graph: 42, content: 'hi', metadata: {} }],
    });

    const mapping = applySaveResponse(desired, remote, response);

    expect(mapping).toStrictEqual(
      new Map([
        ['start-a', 50],
        ['py-a', 30],
        ['py-b', 31],
        ['note-a', 40],
      ])
    );
  });

  it('round-trips: applying the mapping makes a re-save produce an empty payload', async () => {
    const { buildBulkSavePayload } = await import('./bulk-save.js');

    const newPython = pythonNode('py-a', null);
    const remote: GraphState = { nodes: [], edges: [] };
    const desired: GraphState = { nodes: [newPython], edges: [] };

    const firstPayload = buildBulkSavePayload({ graphId: 42, desired, remote, saveVersion: 1 });
    expect(firstPayload.python_node_list).toStrictEqual([
      {
        id: null,
        temp_id: 'py-a',
        node_name: 'py py-a',
        graph: 42,
        python_code: { name: 'code', libraries: [], code: 'def main(): pass', entrypoint: 'main' },
        input_map: {},
        output_variable_path: null,
        stream_config: {},
        use_storage: false,
        test_input: {},
        metadata: { position: { x: 0, y: 0 }, color: '#123456', icon: 'ti-node', size: { width: 200, height: 100 } },
      },
    ]);

    const response = makeGraphDto({ python_node_list: [pythonDto(30)] });
    const mapping = applySaveResponse(desired, remote, response);
    expect(mapping.get('py-a')).toBe(30);

    const patchedNode: PythonGraphNode = { ...newPython, backendId: mapping.get('py-a')! };
    const patchedState: GraphState = { nodes: [patchedNode], edges: [] };

    const secondPayload = buildBulkSavePayload({
      graphId: 42,
      desired: patchedState,
      remote: patchedState,
      saveVersion: 2,
    });
    expect(secondPayload.python_node_list).toStrictEqual([]);
    expect(secondPayload.deleted.python_node_ids).toStrictEqual([]);
  });
});
