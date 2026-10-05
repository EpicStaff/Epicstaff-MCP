import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFlow } from '../src/compiler/index.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createLock, readLock, writeLock } from '../src/flow-source/lockfile.js';
import { EntityPusher } from '../src/pusher/entities.js';
import { GraphPusher, reconcileLockedGraph } from '../src/pusher/graph.js';
import { GraphsApi } from '../src/api/graphs.js';
import { connectTools } from './helpers/mcp-harness.js';
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
  /** Rows created through the entity endpoints, served back by their list endpoints. */
  rows = new Map<string, Array<Record<string, unknown>>>();
  collections: Array<{ collection_id: number; collection_name: string }> = [];
  /** When > 0, the next N calls to process-rag-indexing/ fail with 400 (simulates a mid-push failure). */
  failIndexingTimes = 0;
  /** When true, POST agent-definitions/ fails (simulates a failure late in the entity walk). */
  failAgentCreate = false;
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
      return {
        status: 200,
        body: [{ id: 55, custom_name: 'org-default-fcm', model: 10 }, ...(this.rows.get('llm-configs') ?? [])],
      };
    const listed = /^GET \/api\/(python-code-tool|surfaces|agent-definitions)\/$/.exec(key);
    if (listed) return { status: 200, body: this.rows.get(listed[1]!) ?? [] };
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
    if (key === 'POST /api/agent-definitions/' && this.failAgentCreate) {
      return { status: 400, body: { errors: [{ field: 'name', value: null, reason: 'simulated failure' }] } };
    }
    if (creates[key]) {
      // Mirrors the backend's per-org unique names (LLMConfig custom_name, AgentDefinition name, …).
      const sentName = (body as { name?: string; custom_name?: string }).custom_name ?? (body as { name?: string }).name;
      if (
        creates[key] !== 'source-collections' &&
        (this.rows.get(creates[key]!) ?? []).some((row) => (row.custom_name ?? row.name) === sentName)
      ) {
        return creates[key] === 'agent-definitions'
          ? { status: 409, body: { status_code: 409, code: 'agent_definition_conflict', message: 'An agent with this name already exists in the organization.' } }
          : { status: 400, body: { status_code: 400, code: 'invalid', message: 'name: An entity with this name already exists.' } };
      }
      const id = this.id();
      const track = this.createdByPath.get(creates[key]!) ?? [];
      track.push(id);
      this.createdByPath.set(creates[key]!, track);
      const base = typeof body === 'object' && body !== null ? body : {};
      const resourceRows = this.rows.get(creates[key]!) ?? [];
      resourceRows.push({ ...base, id });
      this.rows.set(creates[key]!, resourceRows);
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
      if (this.takenGraphNames.has((body as { name: string }).name)) {
        return { status: 400, body: { status_code: 400, code: 'invalid', message: 'name: A flow with this name already exists.' } };
      }
      const graphId = this.id();
      return { status: 201, body: this.graphDto(graphId, {}) };
    }
    if (/^GET \/api\/graphs\/\d+\/$/.test(key)) {
      const graphId = Number(path.split('/')[3]);
      if (this.deletedGraphs.has(graphId)) return { status: 404, body: { detail: 'Not found.' } };
      const dto = this.lastSavedDto?.id === graphId ? this.lastSavedDto : this.graphDto(graphId, {});
      return { status: 200, body: { ...dto, name: this.graphNames.get(graphId) ?? dto.name } };
    }
    if (/^PATCH \/api\/graphs\/\d+\/$/.test(key)) {
      const graphId = Number(path.split('/')[3]);
      const { name, save_version: sentVersion } = body as { name: string; save_version: number };
      if (sentVersion !== this.graphSaveVersion) return { status: 409, body: { detail: 'save_version conflict' } };
      this.graphSaveVersion += 1;
      this.graphNames.set(graphId, name);
      if (this.lastSavedDto?.id === graphId) this.lastSavedDto = { ...this.lastSavedDto, name, save_version: this.graphSaveVersion };
      return { status: 200, body: { id: graphId, name, save_version: this.graphSaveVersion } };
    }
    if (key === 'POST /api/conditionaledges/') {
      const edge = { ...(body as Record<string, unknown>), id: this.id() };
      this.conditionalEdges.push(edge);
      return { status: 201, body: edge };
    }
    if (/^POST \/api\/graphs\/\d+\/save\/$/.test(key)) {
      const graphId = Number(path.split('/')[3]);
      if (this.deletedGraphs.has(graphId)) return { status: 404, body: { detail: 'Not found.' } };
      this.savedGraphPayloads.push(body);
      this.graphSaveVersion += 1;
      this.lastSavedDto = this.graphDto(graphId, body as Record<string, unknown>);
      return { status: 200, body: this.lastSavedDto };
    }

    return { status: 404, body: { detail: `no mock for ${key}` } };
  }

  lastSavedDto: Record<string, unknown> | null = null;
  conditionalEdges: Array<Record<string, unknown>> = [];
  takenGraphNames = new Set<string>();
  /** Remote graph names that differ from the fixture's (foreign graphs, editor renames). */
  graphNames = new Map<number, string>();

  /** Graphs that were deleted remotely (GET/save answer 404), e.g. removed in the editor. */
  deletedGraphs = new Set<number>();

  /**
   * Apply a bulk-save payload to the previously saved graph, the way the backend does:
   * deletions by id, updates replace the row with the same id, creates get a fresh id (their
   * temp_id is resolved in edges and decision-table refs), agent sub-tasks get ids.
   */
  private graphDto(graphId: number, payload: Record<string, unknown>): Record<string, unknown> {
    const previous = (this.lastSavedDto?.id === graphId ? this.lastSavedDto : null) as Record<string, unknown> | null;
    const dto: Record<string, unknown> = {
      id: graphId,
      uuid: 'g-uuid',
      name: this.graphNames.get(graphId) ?? 'research-and-write',
      description: '',
      save_version: this.graphSaveVersion,
      metadata: { nodes: [], connections: [] },
      edge_list: [],
      conditional_edge_list: previous?.conditional_edge_list ?? [],
    };
    const deleted = (payload.deleted ?? {}) as Record<string, number[]>;
    const deletedIds = new Set(Object.values(deleted).flat());
    const tempToId = new Map<string, number>();
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
      const kept = ((previous?.[listKey] as Array<Record<string, unknown>> | undefined) ?? []).filter(
        (item) => !deletedIds.has(item.id as number),
      );
      const sent = Array.isArray(payload[listKey]) ? (payload[listKey] as Array<Record<string, unknown>>) : [];
      for (const item of sent) {
        const { temp_id: tempId, ...rest } = item;
        const row: Record<string, unknown> = { ...rest, id: item.id ?? this.id() };
        if (Array.isArray(row.tasks)) {
          row.tasks = (row.tasks as Array<Record<string, unknown>>).map(({ temp_id: _taskTemp, ...task }) => ({
            ...task,
            id: task.id ?? this.id(),
            context_tasks: [],
          }));
        }
        if (typeof tempId === 'string') tempToId.set(tempId, row.id as number);
        const index = kept.findIndex((existing) => existing.id === row.id);
        if (index >= 0) kept[index] = row;
        else kept.push(row);
      }
      dto[listKey] = kept;
    }
    const keptEdges = ((previous?.edge_list as Array<Record<string, unknown>> | undefined) ?? []).filter(
      (edge) => !deletedIds.has(edge.id as number),
    );
    for (const edge of (payload.edge_list as Array<Record<string, unknown>> | undefined) ?? []) {
      const { start_temp_id: startTemp, end_temp_id: endTemp, ...rest } = edge;
      const row = {
        ...rest,
        id: edge.id ?? this.id(),
        start_node_id: edge.start_node_id ?? tempToId.get(startTemp as string),
        end_node_id: edge.end_node_id ?? tempToId.get(endTemp as string),
      };
      const index = keptEdges.findIndex((existing) => existing.id === row.id);
      if (index >= 0) keptEdges[index] = row;
      else keptEdges.push(row);
    }
    dto.edge_list = keptEdges;
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
    // Same lock persistence as the push_flow tool (progress survives a mid-walk failure).
    const entityResult = await new EntityPusher(context).push(artifact, lock, {
      persistLock: (partial) => writeLock(flowDir, partial),
    });
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

  it('repush without changes is a no-op: no creates, no bulk save, save_version unchanged', async () => {
    const first = await pushOnce();
    const receivedBefore = backend.received.length;

    const { entityResult, graphResult } = await pushOnce();

    // All entities reused from the lockfile.
    expect(entityResult.actions.every((a) => a.action === 'reused' || a.action === 'resolved-existing')).toBe(true);

    // The diff is empty, so graphs/<id>/save/ is not called and save_version does not move.
    expect(backend.savedGraphPayloads).toHaveLength(1);
    expect(graphResult.changed).toBe(false);
    expect(graphResult.saveVersion).toBe(first.graphResult.saveVersion);
    expect(graphResult.nodeActions).toEqual({ created: 0, updated: 0, deleted: 0, updatedNodes: [] });
    expect((await readLock(flowDir))!.saveVersion).toBe(first.graphResult.saveVersion);

    // No entity writes fired either (no creates, no PATCH/PUT churn).
    const writes = backend.received
      .slice(receivedBefore)
      .filter((r) => r.method !== 'GET' && !r.path.startsWith('/api/auth/') && r.path !== '/api/secrets/');
    expect(writes).toEqual([]);
  });

  it('an edit after a no-op repush updates the node in place, keeping its sub-task id', async () => {
    await pushOnce();
    const savedAgent = (backend.lastSavedDto!.agent_node_list as Array<{ id: number; tasks: Array<{ id: number }> }>)[0]!;

    const flowFile = join(flowDir, 'flow.yaml');
    writeFileSync(flowFile, readFileSync(flowFile, 'utf8').replace('Research the topic thoroughly', 'Research the topic briefly'));
    const { graphResult } = await pushOnce();

    expect(graphResult.changed).toBe(true);
    expect(graphResult.nodeActions).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    const saved = backend.savedGraphPayloads[1] as Record<string, Array<Record<string, unknown>>>;
    expect(saved.agent_node_list).toHaveLength(1);
    const sentAgent = saved.agent_node_list![0] as { id: number; tasks: Array<Record<string, unknown>> };
    expect(sentAgent.id).toBe(savedAgent.id);
    expect(sentAgent.tasks[0]).toMatchObject({ id: savedAgent.tasks[0]!.id, instructions: expect.stringContaining('briefly') });
    expect(sentAgent.tasks[0]).not.toHaveProperty('temp_id');
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

  it('never adopts a same-named knowledge collection of the org: error, no upload, no RAG', async () => {
    const artifact = await compileFlow(flowDir);
    const plan = artifact.entities.find((entity) => entity.kind === 'knowledge_collection')!;
    const name = String(plan.payload?.collection_name ?? plan.name);
    backend.collections.push({ collection_id: 777, collection_name: name });
    const receivedBefore = backend.received.length;

    await expect(pushOnce()).rejects.toThrow(
      new RegExp(`knowledge collection named "${name}" already exists in this organization, and flow\\.lock\\.json does not point at it`),
    );
    const after = backend.received.slice(receivedBefore);
    expect(after.some((r) => r.path.includes('/upload/'))).toBe(false);
    expect(after.some((r) => /naive-rag|graph-rag|process-rag-indexing/.test(r.path))).toBe(false);
    expect(after.some((r) => r.method === 'POST' && r.path === '/api/source-collections/')).toBe(false);
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
    const OPENAI_ENV = 'PUSH_TEST_OPENAI_KEY';
    const BOT_ENV = 'PUSH_TEST_BOT_TOKEN';
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

      // The nodes that reference secrets / tables / RAGs diff clean against the remote:
      // nothing to save at all.
      expect(backend.savedGraphPayloads).toHaveLength(1);
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
      // Nothing to update: the desired node inherits the attached trigger instead of nulling it.
      expect(graphResult.changed).toBe(false);
      expect(backend.savedGraphPayloads).toHaveLength(1);
    });
  });

  /** The push_flow tool sequence: reconcile the locked graph, then entities, then the graph. */
  async function pushLikeTool(options: { rename?: boolean; force?: boolean } = {}) {
    const context = createContext(loadConfig(ENV));
    await context.auth.ensureAuthenticated();
    const artifact = await compileFlow(flowDir);
    const reconciled = await reconcileLockedGraph(
      new GraphsApi(context.client),
      (await readLock(flowDir)) ?? createLock(artifact.flowName),
      artifact.flowName,
      options,
    );
    const entityResult = await new EntityPusher(context).push(artifact, reconciled.lock, {
      verifyLockedIds: reconciled.graphMissing,
    });
    for (const [refKey, ragId] of await resolveRagRefs(artifact, entityResult.idMap, context)) {
      entityResult.idMap.set(refKey, ragId);
    }
    const graphResult = await new GraphPusher(context).push(artifact, entityResult.lock, entityResult.idMap);
    await writeLock(flowDir, graphResult.lock);
    return { reconciled, entityResult, graphResult };
  }

  describe('a lockfile whose graph no longer exists', () => {
    it('GraphPusher recreates the graph with a warning instead of failing on HTTP 404', async () => {
      const first = await pushOnce();
      backend.deletedGraphs.add(first.graphResult.graphId);

      const { graphResult } = await pushOnce();

      expect(graphResult.createdGraph).toBe(true);
      expect(graphResult.graphId).not.toBe(first.graphResult.graphId);
      expect(graphResult.warnings.join(' ')).toMatch(/no longer exists/);
      // Every node is created fresh in the new graph; the lock points at the new ids only.
      expect(graphResult.nodeActions.created).toBe(4);
      const lock = (await readLock(flowDir))!;
      expect(lock.graphId).toBe(graphResult.graphId);
      const newNodeIds = new Set(
        (backend.lastSavedDto!.agent_node_list as Array<{ id: number }>).map((node) => node.id),
      );
      expect(newNodeIds.has(lock.entities['nodes.research']!.backendId)).toBe(true);
    });

    it('a same-named graph that the lockfile does not own is reported, not taken over', async () => {
      const first = await pushOnce();
      backend.deletedGraphs.add(first.graphResult.graphId);
      backend.takenGraphNames.add('research-and-write');
      await expect(pushOnce()).rejects.toThrow(/already exists in this organization.*pull_flow.*meta\.name/s);
    });

    it('a stale locked id is never re-pointed at a same-named entity: refuse instead of overwriting it', async () => {
      await pushOnce();
      const lock = (await readLock(flowDir))!;
      // Another instance's lockfile: graph and llm config ids that do not exist here, while this org
      // already has a (shared) llm config with the same name.
      await writeLock(flowDir, {
        ...lock,
        graphId: 4242,
        entities: { ...lock.entities, 'llm_configs.default': { ...lock.entities['llm_configs.default']!, backendId: 9999 } },
      });
      backend.deletedGraphs.add(4242);
      const writesBefore = backend.received.filter((r) => r.method === 'PATCH' || r.method === 'PUT').length;

      await expect(pushLikeTool()).rejects.toThrow(
        /llm config named "default" already exists in this organization, and flow\.lock\.json does not point at it/,
      );
      // Nothing was updated in place — the shared entity is untouched.
      expect(backend.received.filter((r) => r.method === 'PATCH' || r.method === 'PUT').length).toBe(writesBefore);
      expect(JSON.stringify(backend.received.map((r) => r.body))).not.toContain('9999');
    });

    it('stale entity drops are reported as warnings', async () => {
      await pushOnce();
      const lock = (await readLock(flowDir))!;
      await writeLock(flowDir, {
        ...lock,
        graphId: 4444,
        entities: { ...lock.entities, 'agents.researcher': { ...lock.entities['agents.researcher']!, backendId: 9999 } },
      });
      backend.deletedGraphs.add(4444);
      backend.rows.set('agent-definitions', []); // gone here as well → created fresh
      const { entityResult } = await pushLikeTool();
      expect(entityResult.actions.find((action) => action.key === 'agents.researcher')!.action).toBe('created');
      expect(entityResult.warnings.join(' ')).toMatch(/agents\.researcher: locked id #9999 .*created anew/);
    });

    it('push_flow sequence creates an entity whose locked id and name are both gone', async () => {
      await pushOnce();
      const lock = (await readLock(flowDir))!;
      await writeLock(flowDir, {
        ...lock,
        graphId: 4343,
        entities: { ...lock.entities, 'agents.researcher': { ...lock.entities['agents.researcher']!, backendId: 9999 } },
      });
      backend.deletedGraphs.add(4343);
      backend.rows.set('agent-definitions', []); // deleted in this instance as well

      const { entityResult } = await pushLikeTool();
      expect(entityResult.actions.find((action) => action.key === 'agents.researcher')!.action).toBe('created');
    });
  });

  it('a failure mid entity walk keeps the already-created entities in the lockfile (no orphans)', async () => {
    const context = createContext(loadConfig(ENV));
    await context.auth.ensureAuthenticated();
    const artifact = await compileFlow(flowDir);
    backend.failAgentCreate = true;
    await expect(
      new EntityPusher(context).push(artifact, createLock(artifact.flowName), {
        persistLock: (partial) => writeLock(flowDir, partial),
      }),
    ).rejects.toThrow();
    const lock = (await readLock(flowDir))!;
    expect(Object.keys(lock.entities)).toEqual(
      expect.arrayContaining(['llm_configs.default', 'surfaces.web_research', 'tools.python_code_tools.fetch_page']),
    );

    // The retry reuses them instead of creating duplicates.
    backend.failAgentCreate = false;
    const llmPostsBefore = backend.received.filter((r) => r.method === 'POST' && r.path === '/api/llm-configs/').length;
    await pushOnce();
    expect(backend.received.filter((r) => r.method === 'POST' && r.path === '/api/llm-configs/').length).toBe(llmPostsBefore);
  });

  it('adoptByName (live harnesses) reuses same-named entities when the lockfile is gone', async () => {
    await pushOnce();
    const context = createContext(loadConfig(ENV));
    await context.auth.ensureAuthenticated();
    const artifact = await compileFlow(flowDir);
    const postsBefore = backend.received.filter((r) => r.method === 'POST' && /agent-definitions|surfaces|llm-configs/.test(r.path)).length;

    const result = await new EntityPusher(context).push(artifact, createLock(artifact.flowName), { adoptByName: true });

    const byKey = new Map(result.actions.map((action) => [action.key, action.action]));
    expect(byKey.get('agents.researcher')).toBe('updated');
    expect(byKey.get('surfaces.web_research')).toBe('updated');
    expect(backend.received.filter((r) => r.method === 'POST' && /agent-definitions|surfaces|llm-configs/.test(r.path)).length).toBe(postsBefore);
  });

  describe('a lockfile pointing at a graph that is not this flow', () => {
    it('GraphPusher refuses to bulk-save over a differently-named graph, even with force', async () => {
      const first = await pushOnce();
      const savesBefore = backend.savedGraphPayloads.length;
      backend.graphNames.set(first.graphResult.graphId, 'someone-elses-flow');
      const context = createContext(loadConfig(ENV));
      await context.auth.ensureAuthenticated();
      const artifact = await compileFlow(flowDir);
      const lock = (await readLock(flowDir))!;
      const entityResult = await new EntityPusher(context).push(artifact, lock);
      await expect(
        new GraphPusher(context).push(artifact, entityResult.lock, entityResult.idMap, { force: true }),
      ).rejects.toThrow(/"someone-elses-flow", but this flow source is named "research-and-write".*Refusing to overwrite/s);
      expect(backend.savedGraphPayloads).toHaveLength(savesBefore);
    });

    it('push_flow sequence stops before any entity write', async () => {
      const first = await pushOnce();
      backend.graphNames.set(first.graphResult.graphId, 'someone-elses-flow');
      const receivedBefore = backend.received.length;
      await expect(pushLikeTool()).rejects.toThrow(/Refusing to overwrite/);
      expect(backend.received.slice(receivedBefore).filter((r) => r.method !== 'GET' && !r.path.startsWith('/api/auth/'))).toEqual([]);
    });

    it('a copied flow dir with a new meta.name is refused — the lockfile name proves nothing', async () => {
      const first = await pushOnce();
      const savesBefore = backend.savedGraphPayloads.length;
      const flowFile = join(flowDir, 'flow.yaml');
      writeFileSync(flowFile, readFileSync(flowFile, 'utf8').replace('name: research-and-write', 'name: research-and-write-copy'));

      await expect(pushLikeTool()).rejects.toThrow(/graph #\d+ "research-and-write", but this flow source is named "research-and-write-copy".*rename: true/s);
      expect(backend.savedGraphPayloads).toHaveLength(savesBefore);
      expect(backend.graphNames.get(first.graphResult.graphId)).toBeUndefined(); // not renamed
      expect((await readLock(flowDir))!.flowName).toBe('research-and-write');
    });

    it('rename: true is refused for a lockfile without a completed push (save_version 0) unless forced', async () => {
      const first = await pushOnce();
      const flowFile = join(flowDir, 'flow.yaml');
      writeFileSync(flowFile, readFileSync(flowFile, 'utf8').replace('name: research-and-write', 'name: hijack'));
      const lock = (await readLock(flowDir))!;
      // Hand-made lockfile: another graph's id with save_version 0.
      await writeLock(flowDir, { ...lock, flowName: 'hijack', saveVersion: 0 });
      const savesBefore = backend.savedGraphPayloads.length;

      await expect(pushLikeTool({ rename: true })).rejects.toThrow(/records no completed push \(save_version 0\)/);
      expect(backend.graphNames.get(first.graphResult.graphId)).toBeUndefined();
      expect(backend.savedGraphPayloads).toHaveLength(savesBefore);
    });

    it('rename: true renames the remote graph and the lockfile, then pushes normally', async () => {
      const first = await pushOnce();
      const flowFile = join(flowDir, 'flow.yaml');
      writeFileSync(flowFile, readFileSync(flowFile, 'utf8').replace('name: research-and-write', 'name: research-and-write-v2'));

      const { reconciled, graphResult } = await pushLikeTool({ rename: true });

      expect(reconciled.warning).toMatch(/Renamed graph #\d+ from "research-and-write" to "research-and-write-v2"/);
      expect(backend.graphNames.get(first.graphResult.graphId)).toBe('research-and-write-v2');
      expect(graphResult.graphId).toBe(first.graphResult.graphId);
      const lock = (await readLock(flowDir))!;
      expect(lock.flowName).toBe('research-and-write-v2');
      expect(lock.saveVersion).toBe(graphResult.saveVersion);
      // A later push without rename is accepted (the names now agree).
      await expect(pushLikeTool()).resolves.toBeDefined();
    });
  });

  describe('node identity across pushes', () => {
    function addPythonNodes(): void {
      const flowFile = join(flowDir, 'flow.yaml');
      writeFileSync(
        flowFile,
        readFileSync(flowFile, 'utf8')
          .replace(
            '    finish:\n      type: end\n',
            [
              '    P1: { type: python, code: "def main():\\n    return 1", output_variable_path: variables.one }',
              '    P2: { type: python, code: "def main():\\n    return 2", output_variable_path: variables.two }',
              '    finish:',
              '      type: end',
              '',
            ].join('\n'),
          )
          .replace('    - from: write\n      to: finish', '    - from: write\n      to: P1\n    - { from: P1, to: P2 }\n    - { from: P2, to: finish }'),
      );
    }

    it('a scrambled lockfile (ids swapped between same-type nodes) is repaired by name — no churn', async () => {
      addPythonNodes();
      await pushOnce();
      const lock = (await readLock(flowDir))!;
      const p1 = lock.entities['nodes.P1']!;
      const p2 = lock.entities['nodes.P2']!;
      await writeLock(flowDir, {
        ...lock,
        entities: { ...lock.entities, 'nodes.P1': { ...p1, backendId: p2.backendId }, 'nodes.P2': { ...p2, backendId: p1.backendId } },
      });
      const savesBefore = backend.savedGraphPayloads.length;

      const { graphResult } = await pushOnce();

      expect(graphResult.changed).toBe(false);
      expect(backend.savedGraphPayloads).toHaveLength(savesBefore);
      const repaired = (await readLock(flowDir))!;
      expect(repaired.entities['nodes.P1']!.backendId).toBe(p1.backendId);
      expect(repaired.entities['nodes.P2']!.backendId).toBe(p2.backendId);
    });

    function addThirdPythonNode(): void {
      const flowFile = join(flowDir, 'flow.yaml');
      writeFileSync(
        flowFile,
        readFileSync(flowFile, 'utf8')
          .replace(
            '    finish:\n      type: end\n',
            '    P3: { type: python, code: "def main():\\n    return 3", output_variable_path: variables.three }\n    finish:\n      type: end\n',
          )
          .replace('    - { from: P2, to: finish }', '    - { from: P2, to: P3 }\n    - { from: P3, to: finish }'),
      );
    }

    function pythonUpdateIds(payload: unknown): number[] {
      return ((payload as { python_node_list: Array<{ id: number | null }> }).python_node_list ?? [])
        .map((item) => item.id)
        .filter((id): id is number => id != null);
    }

    it('a 3-way rotation of locked ids is repaired by name — no churn', async () => {
      addPythonNodes();
      addThirdPythonNode();
      await pushOnce();
      const lock = (await readLock(flowDir))!;
      const [one, two, three] = ['P1', 'P2', 'P3'].map((name) => lock.entities[`nodes.${name}`]!);
      await writeLock(flowDir, {
        ...lock,
        entities: {
          ...lock.entities,
          'nodes.P1': { ...one!, backendId: two!.backendId },
          'nodes.P2': { ...two!, backendId: three!.backendId },
          'nodes.P3': { ...three!, backendId: one!.backendId },
        },
      });
      const savesBefore = backend.savedGraphPayloads.length;

      const { graphResult } = await pushOnce();

      expect(graphResult.changed).toBe(false);
      expect(backend.savedGraphPayloads).toHaveLength(savesBefore);
      const repaired = (await readLock(flowDir))!;
      expect(['P1', 'P2', 'P3'].map((name) => repaired.entities[`nodes.${name}`]!.backendId)).toEqual([
        one!.backendId,
        two!.backendId,
        three!.backendId,
      ]);
    });

    it('a repair never binds two source nodes to one backend node: the loser is recreated, with a warning', async () => {
      addPythonNodes();
      addThirdPythonNode();
      await pushOnce();
      const lock = (await readLock(flowDir))!;
      const x = lock.entities['nodes.P1']!.backendId;
      const y = lock.entities['nodes.P3']!.backendId;
      // Remote edits: X was renamed to a name the source does not have; Y was renamed to "P1".
      const dto = backend.lastSavedDto as Record<string, Array<Record<string, unknown>>>;
      for (const node of dto.python_node_list!) {
        if (node.id === x) node.node_name = 'Renamed';
        if (node.id === y) node.node_name = 'P1';
      }
      // Lock: P1 → X (now "Renamed"), P3 → Y (now "P1").

      const { graphResult } = await pushOnce();

      const saved = backend.savedGraphPayloads.at(-1)!;
      const updates = pythonUpdateIds(saved);
      expect(new Set(updates).size).toBe(updates.length); // no node updated twice
      expect(updates).toContain(y); // P1 took Y by name
      expect(graphResult.nodeActions.created).toBe(1); // P3 recreated, not merged into Y
      expect((saved as { deleted: { python_node_ids: number[] } }).deleted.python_node_ids).toEqual([x]);
      expect(graphResult.warnings.join(' ')).toMatch(/recreated instead of overwriting: P3 \(locked #\d+ is "P1"\)/);
      const after = (await readLock(flowDir))!;
      expect(after.entities['nodes.P1']!.backendId).toBe(y);
      expect(after.entities['nodes.P3']!.backendId).not.toBe(y);
      for (const name of ['P1', 'P2', 'P3']) expect(after.entities[`nodes.${name}`]).toBeDefined(); // none lost
    });

    it('a remote graph holding two nodes with one name: warns, keeps the locked copy, deletes the other', async () => {
      addPythonNodes();
      await pushOnce();
      const dto = backend.lastSavedDto as Record<string, Array<Record<string, unknown>>>;
      const original = dto.python_node_list!.find((node) => node.node_name === 'P1')!;
      dto.python_node_list!.push({ ...original, id: 999 });

      const { graphResult } = await pushOnce();

      expect(graphResult.warnings.join(' ')).toMatch(/several nodes with the same name: P1 \(2×\)/);
      const saved = backend.savedGraphPayloads.at(-1) as { deleted: { python_node_ids: number[] } };
      expect(saved.deleted.python_node_ids).toEqual([999]);
      expect(graphResult.nodeActions.deleted).toBe(1);
      expect((await readLock(flowDir))!.entities['nodes.P1']!.backendId).toBe(original.id);
    });

    it('concurrent push_flow calls for one flow dir are serialized: one graph, one copy of each node', async () => {
      const context = createContext(loadConfig(ENV));
      await context.auth.ensureAuthenticated();
      const { client, call } = await connectTools(context);
      try {
        const [first, second] = await Promise.all([
          call('push_flow', { flow_dir: flowDir }),
          call('push_flow', { flow_dir: flowDir }),
        ]);
        expect(first.isError, first.text).toBe(false);
        expect(second.isError, second.text).toBe(false);
        expect(backend.received.filter((r) => r.method === 'POST' && r.path === '/api/graphs/')).toHaveLength(1);
        expect(second.body.data.graphId).toBe(first.body.data.graphId);
        expect(second.body.data.changed).toBe(false);
        const names = Object.entries(backend.lastSavedDto!)
          .filter(([key, value]) => key.endsWith('_list') && key !== 'edge_list' && Array.isArray(value))
          .flatMap(([, value]) => (value as Array<{ node_name?: string }>).map((node) => node.node_name ?? ''))
          .filter((name) => name !== '');
        expect(new Set(names).size).toBe(names.length);
      } finally {
        await client.close();
      }
    });
  });

  describe('environment variables reach the backend only through secret plans', () => {
    it('does not substitute {$env} placeholders smuggled into llm_configs params', async () => {
      process.env.PUSH_TEST_SMUGGLED = 'smuggled-value-123';
      try {
        const flowFile = join(flowDir, 'flow.yaml');
        writeFileSync(
          flowFile,
          readFileSync(flowFile, 'utf8').replace(
            '    temperature: 0.2\n',
            '    temperature: 0.2\n    params: { extra_headers: { Authorization: { $env: PUSH_TEST_SMUGGLED } } }\n',
          ),
        );
        await pushOnce();
        const llmCreate = backend.received.find((r) => r.path === '/api/llm-configs/' && r.method === 'POST')!;
        expect(JSON.stringify(llmCreate.body)).not.toContain('smuggled-value-123');
        for (const call of backend.received) expect(JSON.stringify(call.body ?? null)).not.toContain('smuggled-value-123');
      } finally {
        delete process.env.PUSH_TEST_SMUGGLED;
      }
    });

    it('refuses to read the MCP server own variables even if a secret plan names one', async () => {
      const context = createContext(loadConfig(ENV));
      await context.auth.ensureAuthenticated();
      const artifact = await compileFlow(flowDir);
      artifact.entities.unshift({
        key: 'secrets.EPICSTAFF_PASSWORD',
        section: 'secrets',
        name: 'EPICSTAFF_PASSWORD',
        kind: 'secret',
        action: 'ensure',
        remoteName: 'es-mcp:EPICSTAFF_PASSWORD',
        payload: { name: 'es-mcp:EPICSTAFF_PASSWORD', value: { $env: 'EPICSTAFF_PASSWORD' } },
      });
      process.env.EPICSTAFF_PASSWORD = 'server-password';
      try {
        await expect(new EntityPusher(context).push(artifact, createLock(artifact.flowName))).rejects.toThrow(
          /MCP server's own configuration/,
        );
        // Lower-case spelling (Windows env is case-insensitive) is refused as well.
        const lower = structuredClone(artifact);
        lower.entities[0] = { ...lower.entities[0]!, payload: { name: 'x', value: { $env: 'epicstaff_password' } } };
        await expect(new EntityPusher(context).push(lower, createLock(artifact.flowName))).rejects.toThrow(
          /MCP server's own configuration/,
        );
        expect(backend.secrets).toEqual([]);
      } finally {
        delete process.env.EPICSTAFF_PASSWORD;
      }
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
