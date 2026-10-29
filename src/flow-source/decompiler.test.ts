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
// python node with an illegal node name and one plain-edge chain. The python
// node holds the lowest #N badge (node_number), so authoring order is not the
// wire-list order.
// ---------------------------------------------------------------------------

function nodeMetadata(x: number, y: number): Record<string, unknown> {
  return {
    position: { x, y },
    color: '#685fff',
    icon: 'ti ti-robot',
    size: { width: 320, height: 80 },
  };
}

const PYTHON_CODE = 'def main(x):\n    return x\n';

function buildGraphDto(): GraphDto {
  return {
    id: 42,
    uuid: 'uuid-42',
    name: 'pulled-flow',
    description: 'A flow pulled from the backend',
    save_version: 7,
    metadata: {},
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    last_edited_by: null,
    last_edited_at: null,
    node_number_seq: 3,
    start_node_list: [
      {
        id: 1,
        graph: 42,
        node_name: 'start',
        variables: { topic: 'ai' },
        metadata: nodeMetadata(100, 200),
      },
    ],
    agent_node_list: [
      {
        id: 2,
        node_number: 2,
        metadata: nodeMetadata(500, 200),
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
        node_number: 3,
        metadata: nodeMetadata(900, 200),
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
        metadata: nodeMetadata(1300, 200),
      },
    ],
    python_node_list: [
      {
        id: 5,
        node_name: 'My Node!',
        graph: 42,
        node_number: 1,
        python_code: { id: 51, code: PYTHON_CODE, entrypoint: 'main' },
        input_map: {},
        test_input: {},
        output_variable_path: null,
        metadata: nodeMetadata(100, 600),
      },
    ],
    edge_list: [
      { id: 11, start_node_id: 1, end_node_id: 2, graph: 42, metadata: {} },
      { id: 12, start_node_id: 2, end_node_id: 3, graph: 42, metadata: {} },
      { id: 13, start_node_id: 3, end_node_id: 4, graph: 42, metadata: {} },
    ],
    file_extractor_node_list: [],
    webhook_trigger_node_list: [],
    telegram_trigger_node_list: [],
    subgraph_node_list: [],
    decision_table_node_list: [],
    classification_decision_table_node_list: [],
    audio_transcription_node_list: [],
    graph_note_list: [],
    schedule_trigger_node_list: [],
    knowledge_node_list: [],
    key_value_node_list: [],
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
          org: 1,
          name: 'researcher',
          description: '',
          instruction_list: [{ name: 'Instruction_1.md', content: 'Research things.' }],
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
          created_at: null,
          created_by: null,
          last_edited_by: null,
          last_edited_at: null,
        };
      },
    },
    surfaces: {
      get: async (id) => {
        expect(id).toBe(88);
        return {
          id: 88,
          org: 1,
          name: 'web-tools',
          description: '',
          instructions: '',
          owner_agent: null,
          allow_creation: false,
          python_tools: [],
          mcp_tools: [],
          storage_items: [],
          knowledge: [],
          created_by: null,
          last_edited_by: null,
          last_edited_at: null,
        };
      },
    },
    llm: { listConfigs: async () => [] },
    tools: { listPythonCodeTools: async () => [], listMcpTools: async () => [] },
    knowledge: { listCollections: async () => [{ collection_id: 8, collection_name: 'Handbook' }] },
    keyValueTables: { list: async () => [{ id: 4, name: 'User Profiles' }] },
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
    // Authoring order: start first, then the #N badge (node_number), then the unnumbered end.
    expect(Object.keys(flow.flow.nodes)).toEqual(['start', 'My_Node', 'research', 'write', 'end']);

    const start = flow.flow.nodes['start']!;
    expect(start).toMatchObject({ type: 'start' });
    // Seeded values are surfaced as a top-level variables: section.
    expect(flow.variables).toEqual({ topic: 'ai' });

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

    expect(flow.flow.edges).toEqual([
      { from: 'start', to: 'research' },
      { from: 'research', to: 'write' },
      { from: 'write', to: 'end' },
    ]);
  });

  it('warns that a python node\'s virtual environment is kept, not written to flow source', async () => {
    const dto = buildGraphDto();
    dto.python_node_list[0]!.python_code.venv_id = 4;
    const result = await decompileFlow(buildStubDeps(dto), 42, targetDir);

    expect(result.warnings).toContain(
      'flow.nodes.My_Node: the virtual environment (venv #4) is not representable in flow source — it is kept on the next push',
    );
    const { source, diagnostics } = await loadFlowDirectory(targetDir);
    expect(diagnostics).toEqual([]);
    expect(source!.flow.nodes['My_Node']).not.toHaveProperty('venv_id');
  });

  it('seeds the lockfile with graph identity and node backend ids', async () => {
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

    // Shallow pull: no entity sections were materialized, so no entity entries.
    const entityKeys = Object.keys(lock.entities).filter((key) => !key.startsWith('nodes.'));
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
  });

  it('pulls knowledge-retriever and key-value nodes and recompiles them with zero errors', async () => {
    const dto = buildGraphDto();
    // TO wire shape: no crew_node_list at all (removed upstream).
    expect(dto).not.toHaveProperty('crew_node_list');
    dto.knowledge_node_list = [
      {
        id: 6,
        graph: 42,
        node_name: 'retrieve',
        source_collection: 8,
        search_configs: { graph: { search_method: 'local', basic: null, local: { top_k_entities: 5 } } },
        metadata: nodeMetadata(500, 600),
        input_map: { question: 'variables.topic' },
        output_variable_path: 'variables.docs',
        query: '{question}',
        rag_type: 'graph',
        rag_id: 81,
      },
    ];
    dto.key_value_node_list = [
      {
        id: 7,
        graph: 42,
        node_name: 'remember',
        input_map: {},
        output_variable_path: null,
        key_value_table: 4,
        mode: 'write',
        entries: [{ key: 'last_{variables.topic}', value: 'variables.research' }],
        metadata: nodeMetadata(900, 600),
      },
    ];
    const result = await decompileFlow(buildStubDeps(dto), 42, targetDir);
    expect(result.warnings.filter((warning) => warning.includes('retrieve') || warning.includes('remember'))).toEqual([]);

    const { source, diagnostics } = await loadFlowDirectory(targetDir);
    expect(diagnostics).toEqual([]);
    expect(source!.flow.nodes['retrieve']).toMatchObject({
      type: 'knowledge-retriever',
      collection: { existing: 'Handbook' },
      rag: 'graph',
      query: '{question}',
      // Write-only on the backend: recovered from the read-back graph config.
      search_method: 'local',
      search_configs: { graph: { basic: null, local: { top_k_entities: 5 } } },
      input_map: { question: 'variables.topic' },
      output_variable_path: 'variables.docs',
    });
    expect(source!.flow.nodes['remember']).toMatchObject({
      type: 'key-value',
      table: 'User Profiles',
      mode: 'write',
      entries: [{ key: 'last_{variables.topic}', value: 'variables.research' }],
    });
    expect(result.lock.entities['nodes.retrieve']?.backendId).toBe(6);
    expect(result.lock.entities['nodes.remember']?.backendId).toBe(7);

    const artifact = await compileFlow(targetDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('writes a placeholder (with a warning) for a subgraph whose target flow was deleted', async () => {
    const dto = buildGraphDto();
    dto.subgraph_node_list = [
      {
        id: 9,
        node_name: 'orphan',
        graph: 42,
        subgraph: null,
        input_map: {},
        output_variable_path: null,
        metadata: nodeMetadata(100, 900),
      },
    ];
    const result = await decompileFlow(buildStubDeps(dto), 42, targetDir);
    expect(result.warnings.some((warning) => warning.includes('flow.nodes.orphan') && warning.includes('deleted'))).toBe(
      true,
    );
    const { source } = await loadFlowDirectory(targetDir);
    expect(source!.flow.nodes['orphan']).toMatchObject({ type: 'subgraph', graph: { existing: 'UNRESOLVED' } });
  });

  it('refuses to overwrite an existing local flow source', async () => {
    await decompileFlow(buildStubDeps(buildGraphDto()), 42, targetDir);

    await expect(decompileFlow(buildStubDeps(buildGraphDto()), 42, targetDir)).rejects.toThrow(
      /already exists/,
    );
  });
});
