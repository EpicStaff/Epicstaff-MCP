import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFlow } from '../src/compiler/index.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createLock, readLock, writeLock } from '../src/flow-source/lockfile.js';
import { EntityPusher } from '../src/pusher/entities.js';
import { GraphPusher } from '../src/pusher/graph.js';

/**
 * Full write→build→push integration against an in-process mock EpicStaff backend.
 * Verifies: dependency-ordered creation, $ref/$model/embedder substitution,
 * bulk-save payload with temp_ids, lockfile round-trip, and idempotent repush.
 */
const ENV = { ES_URL: 'http://es.mock', ES_EMAIL: 'dev@example.com', ES_PASSWORD: 'pw' };
const FIXTURE = join(import.meta.dirname, 'fixtures/flow-source/valid-basic');

interface Received {
  method: string;
  path: string;
  body?: unknown;
}

class MockBackend {
  received: Received[] = [];
  private nextId = 100;
  private graphSaveVersion = 1;
  savedGraphPayloads: unknown[] = [];
  createdByPath = new Map<string, number[]>();
  collections: Array<{ collection_id: number; collection_name: string }> = [];
  /** When > 0, the next N calls to process-rag-indexing/ fail with 400 (simulates a mid-push failure). */
  failIndexingTimes = 0;

  private id(): number {
    this.nextId += 1;
    return this.nextId;
  }

  async handle(method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }> {
    const path = url.pathname;
    this.received.push({ method, path, body });
    const key = `${method} ${path}`;

    // auth
    if (key === 'POST /api/auth/login/') return { status: 200, body: { access: 'jwt', refresh: 'r' } };
    if (key === 'POST /api/auth/api-key/')
      return { status: 201, body: { api_key: 'mock-key', prefix: 'mock-key', name: 'es-mcp' } };
    if (key === 'GET /api/auth/api-key/validate/') return { status: 200, body: { active: true } };
    if (key === 'GET /api/profile/')
      return {
        status: 200,
        body: { memberships: [{ organization: { id: 1, name: 'Mock Org', is_active: true } }] },
      };

    // reference data
    if (key === 'GET /api/providers/') return { status: 200, body: [{ id: 1, name: 'openai' }] };
    if (key === 'GET /api/llm-models/')
      return { status: 200, body: [{ id: 10, name: 'gpt-4o', llm_provider: 1 }] };
    if (key === 'GET /api/llm-configs/')
      return { status: 200, body: [{ id: 55, custom_name: 'org-default-fcm', model: 10 }] };
    if (key === 'GET /api/embedding-configs/')
      return { status: 200, body: [{ id: 71, custom_name: 'default-embedder', model: 20 }] };
    // Mirrors DefaultEmbeddingConfigSerializer: no id — only the embedding model + task/key.
    if (key === 'GET /api/default-embedding-config/')
      return { status: 200, body: { model: 20, task_type: 'RETRIEVAL_DOCUMENT', api_key: null } };

    // collection listing — used by the reuse-before-create idempotency guard.
    if (key === 'GET /api/source-collections/') return { status: 200, body: { results: this.collections } };

    // entity creates
    const creates: Record<string, string> = {
      'POST /api/llm-configs/': 'llm-configs',
      'POST /api/python-code-tool/': 'python-code-tool',
      'POST /api/source-collections/': 'source-collections',
      'POST /api/surfaces/': 'surfaces',
      'POST /api/agent-definitions/': 'agent-definitions',
    };
    if (creates[key]) {
      const id = this.id();
      const track = this.createdByPath.get(creates[key]!) ?? [];
      track.push(id);
      this.createdByPath.set(creates[key]!, track);
      const base = typeof body === 'object' && body !== null ? body : {};
      if (creates[key] === 'source-collections') {
        const collectionName = String((base as { collection_name?: unknown }).collection_name ?? '');
        this.collections.push({ collection_id: id, collection_name: collectionName });
      }
      return {
        status: 201,
        body: { ...base, id, collection_id: id },
      };
    }
    // entity updates
    if (
      (method === 'PATCH' || method === 'PUT') &&
      /^\/api\/(llm-configs|python-code-tool|mcp-tools|surfaces|agent-definitions)\/\d+\/$/.test(path)
    ) {
      const base = typeof body === 'object' && body !== null ? body : {};
      return { status: 200, body: { ...base, id: Number(path.split('/')[3]) } };
    }
    if (/^POST \/api\/documents\/source-collection\/\d+\/upload\/$/.test(key))
      return { status: 201, body: { uploaded: 1 } };
    // Mirrors NaiveRagViewSet.create_or_update: wrapped envelope, id as naive_rag_id.
    if (/^POST \/api\/naive-rag\/collections\/\d+\/naive-rag\/$/.test(key))
      return {
        status: 200,
        body: { message: 'NaiveRag configured successfully', naive_rag: { naive_rag_id: this.id() } },
      };
    if (key === 'POST /api/process-rag-indexing/') {
      if (this.failIndexingTimes > 0) {
        this.failIndexingTimes -= 1;
        return { status: 400, body: { error: 'indexing rejected' } };
      }
      return { status: 200, body: { detail: 'started', rag_id: 1, rag_type: 'naive' } };
    }

    // graph
    if (key === 'POST /api/graphs/') {
      const graphId = this.id();
      return { status: 201, body: this.graphDto(graphId, {}) };
    }
    if (/^GET \/api\/graphs\/\d+\/$/.test(key)) {
      const graphId = Number(path.split('/')[3]);
      return { status: 200, body: this.lastSavedDto ?? this.graphDto(graphId, {}) };
    }
    if (/^POST \/api\/graphs\/\d+\/save\/$/.test(key)) {
      const graphId = Number(path.split('/')[3]);
      this.savedGraphPayloads.push(body);
      this.graphSaveVersion += 1;
      this.lastSavedDto = this.graphDto(graphId, body as Record<string, unknown>);
      return { status: 200, body: this.lastSavedDto };
    }

    return { status: 404, body: { detail: `no mock for ${key}` } };
  }

  private lastSavedDto: Record<string, unknown> | null = null;

  /** Echo a GraphDto: every create item in each node list gets a backend id. */
  private graphDto(graphId: number, payload: Record<string, unknown>): Record<string, unknown> {
    const dto: Record<string, unknown> = {
      id: graphId,
      uuid: 'g-uuid',
      name: 'research-and-write',
      description: '',
      save_version: this.graphSaveVersion,
      metadata: { nodes: [], connections: [] },
      edge_list: [],
      conditional_edge_list: [],
    };
    const listKeys = [
      'start_node_list',
      'crew_node_list',
      'python_node_list',
      'task_node_list',
      'agent_node_list',
      'file_extractor_node_list',
      'webhook_trigger_node_list',
      'telegram_trigger_node_list',
      'end_node_list',
      'subgraph_node_list',
      'decision_table_node_list',
      'classification_decision_table_node_list',
      'audio_transcription_node_list',
      'graph_note_list',
      'schedule_trigger_node_list',
    ];
    for (const listKey of listKeys) {
      const sent = payload[listKey];
      dto[listKey] = Array.isArray(sent)
        ? sent.map((item: Record<string, unknown>) => ({
            ...item,
            id: item.id ?? this.id(),
          }))
        : [];
    }
    const sentEdges = payload.edge_list;
    dto.edge_list = Array.isArray(sentEdges)
      ? sentEdges.map((edge: Record<string, unknown>) => ({ ...edge, id: this.id() }))
      : [];
    return dto;
  }
}

describe('push pipeline (mock backend)', () => {
  let stateDir: string;
  let flowDir: string;
  let backend: MockBackend;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'es-mcp-state-'));
    flowDir = mkdtempSync(join(tmpdir(), 'es-mcp-flow-'));
    cpSync(FIXTURE, flowDir, { recursive: true });
    process.env.ES_MCP_STATE_DIR = stateDir;
    backend = new MockBackend();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const result = await backend.handle(init?.method ?? 'GET', url, body);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(flowDir, { recursive: true, force: true });
  });

  async function pushOnce() {
    const context = createContext(loadConfig(ENV));
    await context.auth.ensureAuthenticated();
    await context.org.resolve();
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);

    let lock = (await readLock(flowDir)) ?? createLock(artifact.flowName);
    const entityResult = await new EntityPusher(context).push(artifact, lock);
    lock = entityResult.lock;
    await writeLock(flowDir, lock);
    const graphResult = await new GraphPusher(context).push(artifact, lock, entityResult.idMap);
    await writeLock(flowDir, graphResult.lock);
    return { entityResult, graphResult };
  }

  it('first push creates the whole dependency tree in order, then the graph', async () => {
    const { entityResult, graphResult } = await pushOnce();

    // Entity actions: existing FCM resolved, everything else created.
    const byAction = Object.groupBy(entityResult.actions, (action) => action.action);
    expect(byAction['resolved-existing']?.map((a) => a.key)).toEqual(['llm_configs.existing:org-default-fcm']);
    expect(byAction.created?.length).toBe(5); // llm default, python tool, collection, surface, agent

    // Creation order respects the dependency chain.
    const createPaths = backend.received
      .filter((r) => r.method === 'POST' && r.path.match(/llm-configs|python-code-tool|source-collections|surfaces|agent-definitions/))
      .map((r) => r.path);
    expect(createPaths).toEqual([
      '/api/llm-configs/',
      '/api/python-code-tool/',
      '/api/source-collections/',
      '/api/surfaces/',
      '/api/agent-definitions/',
    ]);

    // $model resolved to the real model id; $ref → ids in the agent payload.
    const llmCreate = backend.received.find((r) => r.path === '/api/llm-configs/' && r.method === 'POST')!;
    expect((llmCreate.body as { model: number }).model).toBe(10);
    const agentCreate = backend.received.find((r) => r.path === '/api/agent-definitions/' && r.method === 'POST')!;
    const agentBody = agentCreate.body as {
      llm_config: number;
      fcm_llm_config: number;
      default_surfaces: Array<{ surface: number; place: string }>;
    };
    expect(typeof agentBody.llm_config).toBe('number');
    expect(agentBody.fcm_llm_config).toBe(55); // the existing config
    expect(typeof agentBody.default_surfaces[0]!.surface).toBe('number');

    // Surface knowledge got the collection id; python tool ref resolved.
    const surfaceCreate = backend.received.find((r) => r.path === '/api/surfaces/' && r.method === 'POST')!;
    const surfaceBody = surfaceCreate.body as {
      python_tools: Array<{ python_tool: number; mode: string }>;
      knowledge: Array<{ collection: number }>;
    };
    expect(typeof surfaceBody.python_tools[0]!.python_tool).toBe('number');
    expect(typeof surfaceBody.knowledge[0]!.collection).toBe('number');

    // Documents uploaded + RAG attached + indexing started.
    expect(backend.received.some((r) => r.path.includes('/upload/'))).toBe(true);
    expect(backend.received.some((r) => r.path.includes('/naive-rag/'))).toBe(true);
    expect(backend.received.some((r) => r.path === '/api/process-rag-indexing/')).toBe(true);

    // Graph bulk-saved: 4 create items with temp_ids, 3 edges, agent node carries resolved ids.
    expect(backend.savedGraphPayloads.length).toBe(1);
    const saved = backend.savedGraphPayloads[0] as Record<string, unknown>;
    const startList = saved.start_node_list as Array<Record<string, unknown>>;
    expect(startList[0]!.id).toBeNull();
    expect(typeof startList[0]!.temp_id).toBe('string');
    const agentList = saved.agent_node_list as Array<Record<string, unknown>>;
    expect(typeof agentList[0]!.agent_definition).toBe('number');
    expect((saved.edge_list as unknown[]).length).toBe(3);

    // Lockfile: graph id + node ids recorded.
    const lock = (await readLock(flowDir))!;
    expect(lock.graphId).toBe(graphResult.graphId);
    expect(lock.saveVersion).toBe(graphResult.saveVersion);
    expect(Object.keys(lock.entities).filter((key) => key.startsWith('nodes.')).length).toBe(4);
  });

  it('repush without changes is a no-op: no creates, no node changes', async () => {
    await pushOnce();
    const receivedBefore = backend.received.length;

    const { entityResult } = await pushOnce();

    // All entities reused from the lockfile.
    expect(entityResult.actions.every((a) => a.action === 'reused' || a.action === 'resolved-existing')).toBe(true);

    // Second bulk-save contains no creates and no deletes.
    const saved = backend.savedGraphPayloads[1] as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) {
      if (key.endsWith('_node_list') && Array.isArray(value)) {
        expect(value.filter((item: Record<string, unknown>) => item.id === null)).toEqual([]);
      }
    }
    const deletedBlock = saved.deleted as Record<string, number[]>;
    for (const ids of Object.values(deletedBlock)) {
      expect(ids).toEqual([]);
    }

    // No new entity creates fired.
    const entityCreates = backend.received
      .slice(receivedBefore)
      .filter((r) => r.method === 'POST' && r.path.match(/llm-configs|python-code-tool|source-collections|surfaces|agent-definitions/));
    expect(entityCreates).toEqual([]);
  });

  it('source edit updates only the touched entity and node', async () => {
    await pushOnce();

    // Edit the agent's instructions in the flow source.
    const flowFile = join(flowDir, 'flow.yaml');
    writeFileSync(flowFile, readFileSync(flowFile, 'utf8').replace('meticulous researcher', 'thorough researcher'));

    const { entityResult } = await pushOnce();
    const byKey = new Map(entityResult.actions.map((action) => [action.key, action.action]));
    expect(byKey.get('agents.researcher')).toBe('updated');
    expect(byKey.get('surfaces.web_research')).toBe('reused');
    expect(byKey.get('tools.python_code_tools.fetch_page')).toBe('reused');
  });

  it('a mid-push indexing failure does not duplicate the collection on retry', async () => {
    // First attempt fails at the RAG indexing step, after the collection was created.
    backend.failIndexingTimes = 1;
    await expect(pushOnce()).rejects.toThrow();
    expect(backend.createdByPath.get('source-collections')).toHaveLength(1);

    // Retry succeeds and reuses the already-created collection instead of making a second one.
    const { entityResult } = await pushOnce();
    expect(entityResult.actions.some((action) => action.kind === 'knowledge_collection')).toBe(true);
    expect(backend.createdByPath.get('source-collections')).toHaveLength(1);
    expect(backend.received.some((r) => r.path === '/api/process-rag-indexing/' && r.method === 'POST')).toBe(true);
  });

  it('remote save_version drift is detected as a conflict', async () => {
    await pushOnce();
    // Simulate an editor save bumping the remote version.
    const lock = (await readLock(flowDir))!;
    await writeLock(flowDir, { ...lock, saveVersion: lock.saveVersion - 1 });

    const context = createContext(loadConfig(ENV));
    await context.auth.ensureAuthenticated();
    await context.org.resolve();
    const artifact = await compileFlow(flowDir);
    const staleLock = (await readLock(flowDir))!;
    const entityResult = await new EntityPusher(context).push(artifact, staleLock);

    await expect(
      new GraphPusher(context).push(artifact, entityResult.lock, entityResult.idMap),
    ).rejects.toThrow(/changed since the last push/);
  });
});
