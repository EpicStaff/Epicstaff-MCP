import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileFlow } from '../compiler/index.js';
import type { GraphDto } from '../models/graph.js';
import { decompileFlow, type DecompilerDeps } from './decompiler.js';
import { hasErrors } from './diagnostics.js';
import { loadFlowDirectory } from './loader.js';
import { contentHash, readLock } from './lockfile.js';

// ---------------------------------------------------------------------------
// Fixture: a small remote graph — start → agent → task → end, one detached
// python node with an illegal node name, one plain-edge chain and one
// conditional edge out of the task node.
// ---------------------------------------------------------------------------

function nodeMetadata(x: number, y: number, nodeNumber: number): Record<string, unknown> {
  return {
    position: { x, y },
    color: '#685fff',
    icon: 'ti ti-robot',
    size: { width: 320, height: 80 },
    nodeNumber,
  };
}

const PYTHON_CODE = 'def main(x):\n    return x\n';
const CONDITION_CODE = 'def main(research):\n    return "end"\n';

function buildGraphDto(): GraphDto {
  return {
    id: 42,
    uuid: 'uuid-42',
    name: 'pulled-flow',
    description: 'A flow pulled from the backend',
    save_version: 7,
    metadata: {},
    start_node_list: [
      {
        id: 1,
        graph: 42,
        node_name: 'start',
        variables: { topic: 'ai' },
        metadata: nodeMetadata(100, 200, 1),
      },
    ],
    agent_node_list: [
      {
        id: 2,
        metadata: nodeMetadata(500, 200, 2),
        node_name: 'research',
        graph: 42,
        input_map: { query: 'variables.topic' },
        output_variable_path: 'variables.research',
        agent_definition: 77,
        surface_list: [88],
        tasks: [
          {
            id: 900,
            name: 'research-task',
            order: 0,
            instructions: 'Research the topic.',
            output_schema: {},
            context_tasks: [],
          },
        ],
        inline_surface: null,
      },
    ],
    task_node_list: [
      {
        id: 3,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        metadata: nodeMetadata(900, 200, 3),
        node_name: 'write',
        graph: 42,
        input_map: {},
        output_variable_path: null,
        instructions: 'Write a report',
        output_schema: {},
        remember_output: false,
        agent_definition: 77,
        surface_list: [],
        inline_surface: null,
      },
    ],
    end_node_list: [
      {
        id: 4,
        graph: 42,
        output_map: {},
        metadata: nodeMetadata(1300, 200, 4),
      },
    ],
    python_node_list: [
      {
        id: 5,
        node_name: 'My Node!',
        graph: 42,
        python_code: { id: 51, libraries: [], code: PYTHON_CODE, entrypoint: 'main' },
        input_map: {},
        test_input: {},
        output_variable_path: null,
        metadata: nodeMetadata(100, 600, 5),
      },
    ],
    edge_list: [
      { id: 11, start_node_id: 1, end_node_id: 2, graph: 42, metadata: {} },
      { id: 12, start_node_id: 2, end_node_id: 3, graph: 42, metadata: {} },
      { id: 13, start_node_id: 3, end_node_id: 4, graph: 42, metadata: {} },
    ],
    conditional_edge_list: [
      {
        id: 21,
        graph: 42,
        source_node_id: 3,
        python_code: { id: 52, libraries: [], code: CONDITION_CODE, entrypoint: 'main' },
        input_map: { research: 'variables.research' },
        metadata: {},
      },
    ],
    crew_node_list: [],
    file_extractor_node_list: [],
    webhook_trigger_node_list: [],
    telegram_trigger_node_list: [],
    subgraph_node_list: [],
    decision_table_node_list: [],
    classification_decision_table_node_list: [],
    audio_transcription_node_list: [],
    graph_note_list: [],
    schedule_trigger_node_list: [],
  };
}

function buildStubDeps(dto: GraphDto): DecompilerDeps {
  return {
    graphs: {
      get: async (graphId) => {
        expect(graphId).toBe(42);
        return dto;
      },
      listLight: async () => [],
    },
    agentDefinitions: {
      get: async (id) => {
        expect(id).toBe(77);
        return {
          id: 77,
          organization: 1,
          name: 'researcher',
          description: '',
          instructions: 'Research things.',
          llm_config: 55,
          fcm_llm_config: null,
          default_surfaces: [],
          metadata: {},
          max_iter: 25,
          max_rpm: 10,
          max_execution_time: 600,
          cache: true,
          max_retry_limit: 2,
          default_temperature: 0,
        };
      },
    },
    surfaces: {
      get: async (id) => {
        expect(id).toBe(88);
        return {
          id: 88,
          organization: 1,
          name: 'web-tools',
          description: '',
          instructions: '',
          owner_agent: null,
          allow_creation: false,
          python_tools: [],
          mcp_tools: [],
          storage_items: [],
          knowledge: [],
        };
      },
    },
    llm: { listConfigs: async () => [] },
    tools: { listPythonCodeTools: async () => [], listMcpTools: async () => [] },
    knowledge: { listCollections: async () => [] },
  };
}

describe('decompileFlow', () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(path.join(tmpdir(), 'es-mcp-decompile-'));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('writes flow source that loads through loadFlowDirectory with zero errors', async () => {
    const result = await decompileFlow(buildStubDeps(buildGraphDto()), 42, targetDir);

    expect(result.files).toEqual([
      path.join(targetDir, 'flow.yaml'),
      path.join(targetDir, 'flow.lock.json'),
    ]);
    // The only lossy mapping in the fixture is the illegal python node name.
    expect(result.warnings).toEqual([
      "flow.nodes: node name 'My Node!' is not a valid symbolic name — renamed to 'My_Node' (the node is renamed on the next push)",
    ]);

    const { source, diagnostics } = await loadFlowDirectory(targetDir);
    expect(diagnostics).toEqual([]);
    expect(source).not.toBeNull();

    const flow = source!;
    expect(flow.meta.name).toBe('pulled-flow');
    expect(flow.meta.description).toBe('A flow pulled from the backend');
    // Nodes come out in nodeNumber order under sanitized symbolic names.
    expect(Object.keys(flow.flow.nodes)).toEqual(['start', 'research', 'write', 'end', 'My_Node']);

    const start = flow.flow.nodes['start']!;
    expect(start).toMatchObject({ type: 'start', initial_state: { topic: 'ai' } });

    const research = flow.flow.nodes['research']!;
    expect(research).toMatchObject({
      type: 'agent',
      agent: { existing: 'researcher' },
      surfaces: [{ existing: 'web-tools' }],
      input_map: { query: 'variables.topic' },
      output_variable_path: 'variables.research',
      position: { x: 500, y: 200 },
    });

    const write = flow.flow.nodes['write']!;
    expect(write).toMatchObject({
      type: 'task',
      agent: { existing: 'researcher' },
      task: 'Write a report',
    });

    const pythonNode = flow.flow.nodes['My_Node']!;
    expect(pythonNode).toMatchObject({ type: 'python', code: PYTHON_CODE, entrypoint: 'main' });

    // Three plain edges plus the conditional edge out of the task node.
    expect(flow.flow.edges).toHaveLength(4);
    expect(flow.flow.edges.slice(0, 3)).toEqual([
      expect.objectContaining({ from: 'start', to: 'research' }),
      expect.objectContaining({ from: 'research', to: 'write' }),
      expect.objectContaining({ from: 'write', to: 'end' }),
    ]);
    const conditional = flow.flow.edges[3]!;
    expect(conditional.from).toBe('write');
    expect(conditional.condition).toMatchObject({
      code: CONDITION_CODE,
      entrypoint: 'main',
      input_map: { research: 'variables.research' },
    });
  });

  it('seeds the lockfile with graph identity, node backend ids and conditional-edge hashes', async () => {
    const dto = buildGraphDto();
    const result = await decompileFlow(buildStubDeps(dto), 42, targetDir);

    const lock = (await readLock(targetDir))!;
    expect(lock).toEqual(result.lock);
    expect(lock.flowName).toBe('pulled-flow');
    expect(lock.graphId).toBe(42);
    expect(lock.saveVersion).toBe(7);
    expect(lock.documents).toEqual({});

    // One `nodes.<name>` entry per node, hashed the way the pusher hashes nodes.
    const emptyHash = contentHash({});
    expect(lock.entities['nodes.start']).toEqual({ backendId: 1, contentHash: emptyHash });
    expect(lock.entities['nodes.research']).toEqual({ backendId: 2, contentHash: emptyHash });
    expect(lock.entities['nodes.write']).toEqual({ backendId: 3, contentHash: emptyHash });
    expect(lock.entities['nodes.end']).toEqual({ backendId: 4, contentHash: emptyHash });
    expect(lock.entities['nodes.My_Node']).toEqual({ backendId: 5, contentHash: emptyHash });

    // Conditional-edge hash matches the body the pusher will build from the
    // next compile (emit always sets libraries: [] on edge conditions).
    expect(lock.entities['conditional_edges.write']).toEqual({
      backendId: 21,
      contentHash: contentHash({
        graph: 42,
        source_node_id: 3,
        python_code: { code: CONDITION_CODE, entrypoint: 'main', libraries: [] },
        input_map: { research: 'variables.research' },
      }),
    });

    // Shallow pull: no entity sections were materialized, so no entity entries.
    const entityKeys = Object.keys(lock.entities).filter(
      (key) => !key.startsWith('nodes.') && !key.startsWith('conditional_edges.'),
    );
    expect(entityKeys).toEqual([]);
  });

  it('recompiles with zero errors and keeps the pulled canvas positions pinned', async () => {
    await decompileFlow(buildStubDeps(buildGraphDto()), 42, targetDir);

    const artifact = await compileFlow(targetDir);
    expect(hasErrors(artifact.diagnostics)).toBe(false);
    expect(artifact.flowName).toBe('pulled-flow');

    const positionByName = new Map(
      artifact.graph.nodes.map((node) => [node.node_name, node.position]),
    );
    expect(positionByName.get('start')).toEqual({ x: 100, y: 200 });
    expect(positionByName.get('research')).toEqual({ x: 500, y: 200 });
    expect(positionByName.get('write')).toEqual({ x: 900, y: 200 });
    expect(positionByName.get('end')).toEqual({ x: 1300, y: 200 });
    expect(positionByName.get('My_Node')).toEqual({ x: 100, y: 600 });

    // The conditional edge survives the round trip into the push plan.
    const conditionalEdges = artifact.summary['conditionalEdges'] as Array<{
      sourceNodeName: string;
      python_code: { code: string; entrypoint: string; libraries: string[] };
    }>;
    expect(conditionalEdges).toHaveLength(1);
    expect(conditionalEdges[0]!.sourceNodeName).toBe('write');
    expect(conditionalEdges[0]!.python_code).toEqual({
      code: CONDITION_CODE,
      entrypoint: 'main',
      libraries: [],
    });
  });

  it('refuses to overwrite an existing local flow source', async () => {
    await decompileFlow(buildStubDeps(buildGraphDto()), 42, targetDir);

    await expect(decompileFlow(buildStubDeps(buildGraphDto()), 42, targetDir)).rejects.toThrow(
      /already exists/,
    );
  });
});
