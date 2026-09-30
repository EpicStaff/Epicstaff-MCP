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
import { resolveRagRefs } from '../src/pusher/rag-refs.js';

/**
 * Full write→build→push integration against an in-process mock EpicStaff backend.
 * Verifies: dependency-ordered creation, $ref/$model/embedder substitution,
 * bulk-save payload with temp_ids, lockfile round-trip, and idempotent repush.
 */
const ENV = {
  EPICSTAFF_BASE_URL: 'http://es.mock',
  EPICSTAFF_USERNAME: 'dev@example.com',
  EPICSTAFF_PASSWORD: 'pw',
};
const FIXTURE = join(import.meta.dirname, 'fixtures/flow-source/valid-basic');

/** A JWT-shaped access token valid for an hour (AuthService reads its `exp`). */
const encodeSegment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const MOCK_JWT = `${encodeSegment({ alg: 'HS256' })}.${encodeSegment({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

interface Received {
  method: string;
  path: string;
  body?: unknown;
  headers?: Headers;
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
  secrets: Array<{ id: number; name: string; tail: string }> = [];
  keyValueTables: Array<{ id: number; name: string }> = [];
  availableRags = new Map<number, Array<{ rag_id: number; rag_type: string; rag_status: string; created_at: string }>>();

  private id(): number {
    this.nextId += 1;
    return this.nextId;
  }

  async handle(
    method: string,
    url: URL,
    body: unknown,
    headers: Headers = new Headers(),
  ): Promise<{ status: number; body: unknown; setCookie?: string }> {
    const path = url.pathname;
    this.received.push({ method, path, body, headers });
    const key = `${method} ${path}`;

    // auth (rbac views): refresh token only in the HttpOnly cookie
    if (key === 'POST /api/auth/login/')
      return { status: 200, body: { access: MOCK_JWT }, setCookie: 'auth.refresh=r; HttpOnly; Path=/api/auth/' };
    if (key === 'POST /api/auth/refresh/') {
      if (headers.get('Cookie') !== 'auth.refresh=r') return { status: 401, body: { detail: 'No refresh token.' } };
      return { status: 200, body: { access: MOCK_JWT } };
    }
    if (key === 'POST /api/profile/api-keys/')
      return { status: 201, body: { id: 1, api_key: 'mock-key', prefix: 'mock-key', name: 'es-mcp', expires_at: null } };

    // secrets/ is JWT-only (DenyApiKeyAuth)
    if (path === '/api/secrets/') {
      if (headers.get('X-Api-Key') !== null || headers.get('Authorization') !== `Bearer ${MOCK_JWT}`) {
        return { status: 403, body: { detail: 'API keys cannot be used here.' } };
      }
      if (method === 'GET') return { status: 200, body: { count: this.secrets.length, results: this.secrets } };
      const { name, value } = body as { name: string; value: string };
      const secret = { id: this.id(), name, tail: value.length >= 9 ? value.slice(-4) : '' };
      this.secrets.push(secret);
      return { status: 201, body: secret };
    }
    if (key === 'GET /api/key-value-tables/')
      return { status: 200, body: { count: this.keyValueTables.length, results: this.keyValueTables } };
    if (key === 'POST /api/key-value-tables/') {
      const table = { id: this.id(), name: (body as { name: string }).name };
      this.keyValueTables.push(table);
      return { status: 201, body: table };
    }
    if (/^GET \/api\/source-collections\/\d+\/available-rags\/$/.test(key)) {
      return { status: 200, body: this.availableRags.get(Number(path.split('/')[3])) ?? [] };
    }
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
    // Mirrors DefaultModelsSerializer: the org default embedder is memory_embedding_config.
    if (key === 'GET /api/default-models/')
      return { status: 200, body: { agent_llm_config: null, memory_embedding_config: 71 } };

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
    // Mirrors GraphRagViewSet.create_or_update: wrapped envelope, id as graph_rag_id.
    if (/^POST \/api\/graph-rag\/collections\/\d+\/graph-rag\/$/.test(key))
      return {
        status: 200,
        body: { message: 'GraphRag configured successfully', graph_rag: { graph_rag_id: this.id() } },
      };
    if (/^PUT \/api\/graph-rag\/\d+\/index-config\/$/.test(key))
      return { status: 200, body: { message: 'Index config updated' } };
    if (/^POST \/api\/naive-rag\/\d+\/document-configs\/initialize\/$/.test(key))
      return { status: 200, body: { message: 'ok', configs_created: 0, configs_existing: 2, new_configs: [] } };
    if (/^GET \/api\/naive-rag\/\d+\/document-configs\/$/.test(key))
      return {
        status: 200,
        body: [
          { naive_rag_document_id: 11, document_id: 1, file_name: 'a.md', chunk_size: 1000, chunk_overlap: 150 },
          { naive_rag_document_id: 12, document_id: 2, file_name: 'b.md', chunk_size: 1000, chunk_overlap: 150 },
        ],
      };
    if (/^PUT \/api\/naive-rag\/\d+\/document-configs\/bulk-update\/$/.test(key))
      return { status: 200, body: { message: 'Successfully updated 2 config(s)', updated_count: 2, failed_count: 0 } };
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

  lastSavedDto: Record<string, unknown> | null = null;

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
      'knowledge_node_list',
      'key_value_node_list',
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
      const result = await backend.handle(init?.method ?? 'GET', url, body, new Headers(init?.headers));
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (result.setCookie) headers.append('Set-Cookie', result.setCookie);
      return new Response(JSON.stringify(result.body), { status: result.status, headers });
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
    for (const [refKey, ragId] of await resolveRagRefs(artifact, entityResult.idMap, context)) {
      entityResult.idMap.set(refKey, ragId);
    }
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

  it('applies naive document chunking (initialize → bulk-update) before indexing starts', async () => {
    // The fixture sets chunk_size: 800 / chunk_overlap: 100 on the naive rag.
    await pushOnce();

    const paths = backend.received.map((r) => `${r.method} ${r.path}`);
    const initializeIndex = paths.findIndex((p) => /POST \/api\/naive-rag\/\d+\/document-configs\/initialize\/$/.test(p));
    const bulkUpdateIndex = paths.findIndex((p) => /PUT \/api\/naive-rag\/\d+\/document-configs\/bulk-update\/$/.test(p));
    const indexingIndex = paths.findIndex((p) => p === 'POST /api/process-rag-indexing/');
    expect(initializeIndex).toBeGreaterThan(-1);
    expect(bulkUpdateIndex).toBeGreaterThan(initializeIndex);
    expect(indexingIndex).toBeGreaterThan(bulkUpdateIndex);

    // All config rows get the authored chunking.
    const bulkUpdate = backend.received[bulkUpdateIndex]!;
    expect(bulkUpdate.body).toEqual({ config_ids: [11, 12], chunk_size: 800, chunk_overlap: 100 });
  });

  it('applies the graph index config before indexing and re-applies it when it changes', async () => {
    const flowFile = join(flowDir, 'flow.yaml');
    const graphRagBlock = [
      'strategy: graph',
      '      llm_config: default',
      '      entity_types: [service, person]',
      '      max_gleanings: 2',
    ].join('\n');
    writeFileSync(
      flowFile,
      readFileSync(flowFile, 'utf8')
        .replace('strategy: naive', graphRagBlock)
        .replace('      chunk_size: 800\n', '')
        .replace('      chunk_overlap: 100\n', ''),
    );

    await pushOnce();
    const indexConfigPuts = () =>
      backend.received.filter((r) => r.method === 'PUT' && /\/api\/graph-rag\/\d+\/index-config\/$/.test(r.path));
    expect(indexConfigPuts()).toHaveLength(1);
    expect(indexConfigPuts()[0]!.body).toEqual({ entity_types: ['service', 'person'], max_gleanings: 2 });

    // The config must land before indexing reads it.
    const paths = backend.received.map((r) => `${r.method} ${r.path}`);
    const putIndex = paths.findIndex((p) => /PUT \/api\/graph-rag\/\d+\/index-config\/$/.test(p));
    const indexingIndex = paths.findIndex((p) => p === 'POST /api/process-rag-indexing/');
    expect(indexingIndex).toBeGreaterThan(putIndex);

    // Unchanged repush: rag reused, no second index-config write, no re-index.
    const indexingCalls = () => backend.received.filter((r) => r.path === '/api/process-rag-indexing/');
    const indexingCountAfterFirstPush = indexingCalls().length;
    await pushOnce();
    expect(indexConfigPuts()).toHaveLength(1);
    expect(indexingCalls()).toHaveLength(indexingCountAfterFirstPush);

    // Changing entity_types dirties the rag: config re-applied, indexing re-triggered.
    writeFileSync(
      flowFile,
      readFileSync(flowFile, 'utf8').replace('entity_types: [service, person]', 'entity_types: [service, api]'),
    );
    await pushOnce();
    expect(indexConfigPuts()).toHaveLength(2);
    expect(indexConfigPuts()[1]!.body).toEqual({ entity_types: ['service', 'api'], max_gleanings: 2 });
    expect(indexingCalls().length).toBeGreaterThan(indexingCountAfterFirstPush);
  });

  it('section filter pushes only llm_configs + knowledge (the provision_knowledge path)', async () => {
    const context = createContext(loadConfig(ENV));
    await context.auth.ensureAuthenticated();
    await context.org.resolve();
    const artifact = await compileFlow(flowDir);

    const lock = createLock(artifact.flowName);
    const entityResult = await new EntityPusher(context).push(artifact, lock, {
      sections: ['llm_configs', 'knowledge'],
    });

    // Only llm-configs and the collection were created; tools/surfaces/agents were skipped.
    const createPaths = backend.received
      .filter((r) => r.method === 'POST' && r.path.match(/llm-configs|python-code-tool|source-collections|surfaces|agent-definitions/))
      .map((r) => r.path);
    expect(createPaths).toEqual(['/api/llm-configs/', '/api/source-collections/']);

    // RAG indexing was still kicked off for the provisioned collection.
    expect(backend.received.some((r) => r.path === '/api/process-rag-indexing/' && r.method === 'POST')).toBe(true);

    // The action set is confined to the two allowed sections.
    expect(entityResult.actions.some((a) => a.kind === 'knowledge_collection')).toBe(true);
    expect(entityResult.actions.every((a) => a.key.startsWith('llm_configs.') || a.key.startsWith('knowledge.'))).toBe(true);

    // No graph was touched.
    expect(backend.savedGraphPayloads.length).toBe(0);
  });

  describe('secrets, key-value tables and knowledge-retriever RAGs', () => {
    const OPENAI_ENV = 'ES_MCP_TEST_OPENAI_KEY';
    const BOT_ENV = 'ES_MCP_TEST_BOT_TOKEN';
    const OPENAI_VALUE = 'sk-test-0123456789abcd';
    const BOT_VALUE = '123456:telegram-token-wxyz';

    beforeEach(() => {
      process.env[OPENAI_ENV] = OPENAI_VALUE;
      process.env[BOT_ENV] = BOT_VALUE;
      const flowFile = join(flowDir, 'flow.yaml');
      writeFileSync(
        flowFile,
        readFileSync(flowFile, 'utf8')
          .replace('    temperature: 0.2\n', `    temperature: 0.2\n    api_key_env: ${OPENAI_ENV}\n`)
          .replace(
            '    finish:\n      type: end\n',
            [
              '    finish:',
              '      type: end',
              '    bot:',
              '      type: telegram-trigger',
              `      bot_token_env: ${BOT_ENV}`,
              '    lookup:',
              '      type: knowledge-retriever',
              '      collection: docs',
              '      query: "{topic}"',
              '      input_map: { topic: variables.topic }',
              '      output_variable_path: variables.handbook',
              '    handbook:',
              '      type: knowledge-retriever',
              '      collection: { existing: "Legacy Handbook" }',
              '      rag: graph',
              '      query: "{topic}"',
              '      input_map: { topic: variables.topic }',
              '      output_variable_path: variables.legacy',
              '    remember:',
              '      type: key-value',
              '      table: Research Memory',
              '      mode: write',
              '      entries:',
              '        - { key: last_summary, value: variables.summary }',
              '',
            ].join('\n'),
          ),
      );
      backend.collections.push({ collection_id: 300, collection_name: 'Legacy Handbook' });
      backend.availableRags.set(300, [
        { rag_id: 7, rag_type: 'graph', rag_status: 'completed', created_at: '2026-01-01T00:00:00Z' },
        { rag_id: 9, rag_type: 'graph', rag_status: 'completed', created_at: '2026-06-01T00:00:00Z' },
        { rag_id: 4, rag_type: 'naive', rag_status: 'completed', created_at: '2026-07-01T00:00:00Z' },
      ]);
    });

    afterEach(() => {
      delete process.env[OPENAI_ENV];
      delete process.env[BOT_ENV];
    });

    it('stores env credentials as org secrets over JWT and sends only their ids', async () => {
      await pushOnce();

      expect(backend.secrets.map((secret) => secret.name).sort()).toStrictEqual([
        `es-mcp:${BOT_ENV}`,
        `es-mcp:${OPENAI_ENV}`,
      ]);
      const secretCalls = backend.received.filter((r) => r.path === '/api/secrets/');
      // JWT-only route: never the API key.
      for (const call of secretCalls) {
        expect(call.headers?.get('X-Api-Key')).toBeNull();
        expect(call.headers?.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
      }

      const openaiSecret = backend.secrets.find((secret) => secret.name === `es-mcp:${OPENAI_ENV}`)!;
      const botSecret = backend.secrets.find((secret) => secret.name === `es-mcp:${BOT_ENV}`)!;
      const llmCreate = backend.received.find((r) => r.path === '/api/llm-configs/' && r.method === 'POST')!;
      expect(llmCreate.body).toMatchObject({ api_key_secret_id: openaiSecret.id });
      expect(llmCreate.body).not.toHaveProperty('api_key');

      const saved = backend.savedGraphPayloads[0] as Record<string, Array<Record<string, unknown>>>;
      expect(saved.telegram_trigger_node_list![0]).toMatchObject({
        telegram_bot_api_key_secret_id: botSecret.id,
        webhook_trigger: null,
      });

      // The raw values only ever travel in the secret-create body.
      for (const call of backend.received.filter((r) => r.path !== '/api/secrets/')) {
        const serialized = JSON.stringify(call.body ?? null);
        expect(serialized).not.toContain(OPENAI_VALUE);
        expect(serialized).not.toContain(BOT_VALUE);
      }
      const lockText = readFileSync(join(flowDir, 'flow.lock.json'), 'utf8');
      expect(lockText).not.toContain(OPENAI_VALUE);
      expect(lockText).not.toContain(BOT_VALUE);
    });

    it('creates the key-value table once and addresses both knowledge RAGs by id', async () => {
      await pushOnce();

      expect(backend.keyValueTables.map((table) => table.name)).toStrictEqual(['Research Memory']);
      const table = backend.keyValueTables[0]!;
      const saved = backend.savedGraphPayloads[0] as Record<string, Array<Record<string, unknown>>>;
      expect(saved.key_value_node_list![0]).toMatchObject({
        key_value_table: table.id,
        mode: 'write',
        output_variable_path: null,
        entries: [{ key: 'last_summary', value: 'variables.summary' }],
      });

      const lock = (await readLock(flowDir))!;
      const localRagId = lock.entities['knowledge.docs#rag']!.backendId;
      const localCollectionId = lock.entities['knowledge.docs']!.backendId;
      const knowledgeNodes = saved.knowledge_node_list!;
      expect(knowledgeNodes.find((node) => node.node_name === 'lookup')).toMatchObject({
        source_collection: localCollectionId,
        rag_type: 'naive',
        rag_id: localRagId,
        query: '{topic}',
      });
      // Existing collection: the newest graph RAG from available-rags/.
      expect(knowledgeNodes.find((node) => node.node_name === 'handbook')).toMatchObject({
        source_collection: 300,
        rag_type: 'graph',
        rag_id: 9,
      });
    });

    it('repush reuses the secrets and table by name — no duplicates, no node changes', async () => {
      await pushOnce();
      const { entityResult } = await pushOnce();

      expect(backend.secrets).toHaveLength(2);
      expect(backend.keyValueTables).toHaveLength(1);
      expect(backend.received.filter((r) => r.path === '/api/secrets/' && r.method === 'POST')).toHaveLength(2);
      const ensured = entityResult.actions.filter((action) => action.kind === 'secret' || action.kind === 'key_value_table');
      expect(ensured.every((action) => action.action === 'reused')).toBe(true);

      // The nodes that reference secrets / tables / RAGs diff clean against the remote.
      const saved = backend.savedGraphPayloads[1] as Record<string, unknown>;
      expect(saved['telegram_trigger_node_list']).toEqual([]);
      expect(saved['knowledge_node_list']).toEqual([]);
      expect(saved['key_value_node_list']).toEqual([]);
      for (const ids of Object.values(saved['deleted'] as Record<string, number[]>)) expect(ids).toEqual([]);
    });

    it('refuses to reuse a same-named secret whose value changed, without echoing either value', async () => {
      await pushOnce();
      process.env[OPENAI_ENV] = 'sk-test-rotated-99999999';

      const failure = await pushOnce().then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toContain(`es-mcp:${OPENAI_ENV}`);
      expect(failure?.message).toContain('immutable');
      expect(failure?.message).not.toContain('sk-test-rotated-99999999');
      expect(failure?.message).not.toContain(OPENAI_VALUE);
    });

    it('keeps a webhook trigger attached in the editor across a repush', async () => {
      await pushOnce();
      // Simulate the user attaching webhook trigger #77 to the telegram node in the UI.
      const dto = backend.lastSavedDto as Record<string, Array<Record<string, unknown>>>;
      dto.telegram_trigger_node_list![0]!.webhook_trigger = 77;

      const { graphResult } = await pushOnce();
      expect(graphResult.nodeActions.created).toBe(0);
      const saved = backend.savedGraphPayloads[1] as Record<string, Array<Record<string, unknown>>>;
      // Nothing to update: the desired node inherits the attached trigger instead of nulling it.
      expect(saved.telegram_trigger_node_list).toEqual([]);
    });
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
