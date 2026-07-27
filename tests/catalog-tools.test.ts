import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { registerCatalogTools } from '../src/tools/catalog.tools.js';

/**
 * Focused integration tests for the standalone catalog CRUD tools. Handlers are
 * captured from a fake McpServer and invoked directly against an in-process mock
 * backend — exercising reference resolution, org-unique-name handling, the
 * delete warnings, and the create_collection RAG pipeline.
 *
 * Note: calling handlers directly bypasses MCP's Zod parsing, so inputs are
 * passed fully-specified (defaults the schema would apply are not relied upon).
 */
const ENV = { ES_URL: 'http://es.mock', ES_EMAIL: 'dev@example.com', ES_PASSWORD: 'pw' };

interface Received {
  method: string;
  path: string;
  body?: unknown;
}

type MockResponse = { status: number; body: unknown };

class MockBackend {
  received: Received[] = [];
  private nextId = 500;
  /** Per-endpoint override for the next matching call (used to force conflicts). */
  overrides = new Map<string, MockResponse>();

  agents = [{ id: 5, name: 'Writer' }];
  surfaces: Array<Record<string, unknown>> = [{ id: 7, name: 'Docs' }];
  llmConfigs = [{ id: 55, custom_name: 'gpt-4o-default', model: 10 }];
  pythonTools = [{ id: 9, name: 'search', description: '' }];
  mcpTools = [{ id: 12, name: 'fetch', tool_name: 'fetch', transport: 'sse' }];
  collections: Array<Record<string, unknown>> = [];
  embeddingConfigs = [{ id: 71, custom_name: 'default-embedder', model: 20 }];

  private id(): number {
    this.nextId += 1;
    return this.nextId;
  }

  async handle(method: string, url: URL, body: unknown): Promise<MockResponse> {
    const path = url.pathname;
    this.received.push({ method, path, body });
    const key = `${method} ${path}`;

    const override = this.overrides.get(key);
    if (override) {
      this.overrides.delete(key);
      return override;
    }

    // auth + org bootstrap
    if (key === 'POST /api/auth/login/') return { status: 200, body: { access: 'jwt', refresh: 'r' } };
    if (key === 'POST /api/auth/api-key/')
      return { status: 201, body: { api_key: 'mock-key', prefix: 'mock-key', name: 'es-mcp' } };
    if (key === 'GET /api/auth/api-key/validate/') return { status: 200, body: { active: true } };
    if (key === 'GET /api/profile/')
      return { status: 200, body: { memberships: [{ organization: { id: 1, name: 'Mock Org', is_active: true } }] } };

    // reference lists (resolution)
    if (key === 'GET /api/agent-definitions/') return { status: 200, body: this.agents };
    if (key === 'GET /api/surfaces/') return { status: 200, body: this.surfaces };
    if (key === 'GET /api/llm-configs/') return { status: 200, body: this.llmConfigs };
    if (key === 'GET /api/python-code-tool/') return { status: 200, body: this.pythonTools };
    if (key === 'GET /api/mcp-tools/') return { status: 200, body: this.mcpTools };
    if (key === 'GET /api/source-collections/') return { status: 200, body: this.collections };
    if (key === 'GET /api/embedding-configs/') return { status: 200, body: this.embeddingConfigs };
    if (key === 'GET /api/default-embedding-config/') return { status: 200, body: { model: 20 } };

    // surface CRUD
    if (key === 'POST /api/surfaces/') {
      const created = { id: this.id(), ...(body as Record<string, unknown>) };
      return { status: 201, body: created };
    }
    if (/^GET \/api\/surfaces\/\d+\/$/.test(key)) {
      const id = Number(path.split('/')[3]);
      return { status: 200, body: { id, name: 'Docs', description: '', instructions: '', owner_agent: null, allow_creation: false, python_tools: [], mcp_tools: [], storage_items: [], knowledge: [] } };
    }
    if (/^PUT \/api\/surfaces\/\d+\/$/.test(key)) {
      const id = Number(path.split('/')[3]);
      return { status: 200, body: { id, ...(body as Record<string, unknown>) } };
    }
    if (/^DELETE \/api\/surfaces\/\d+\/$/.test(key)) return { status: 204, body: undefined };

    // agent CRUD
    if (key === 'POST /api/agent-definitions/') {
      const created = { id: this.id(), ...(body as Record<string, unknown>) };
      return { status: 201, body: created };
    }
    if (/^GET \/api\/agent-definitions\/\d+\/$/.test(key)) {
      const id = Number(path.split('/')[3]);
      return { status: 200, body: { id, name: 'Writer' } };
    }
    if (/^PATCH \/api\/agent-definitions\/\d+\/$/.test(key)) {
      const id = Number(path.split('/')[3]);
      return { status: 200, body: { id, ...(body as Record<string, unknown>) } };
    }
    if (/^DELETE \/api\/agent-definitions\/\d+\/$/.test(key)) return { status: 204, body: undefined };

    // collection CRUD + RAG pipeline
    if (key === 'POST /api/source-collections/') {
      const bodyObj = body as { collection_name: string };
      const collectionId = this.id();
      this.collections.push({ collection_id: collectionId, collection_name: bodyObj.collection_name });
      return { status: 201, body: { collection_id: collectionId, collection_name: bodyObj.collection_name } };
    }
    if (/^POST \/api\/naive-rag\/collections\/\d+\/naive-rag\/$/.test(key))
      return { status: 201, body: { naive_rag: { naive_rag_id: 900 } } };
    if (/^POST \/api\/graph-rag\/collections\/\d+\/graph-rag\/$/.test(key))
      return { status: 201, body: { graph_rag: { graph_rag_id: 901 } } };
    if (/^PUT \/api\/graph-rag\/\d+\/index-config\/$/.test(key))
      return { status: 200, body: { message: 'Index config updated' } };
    if (/^POST \/api\/naive-rag\/\d+\/document-configs\/initialize\/$/.test(key))
      return { status: 200, body: { message: 'ok', configs_created: 0, configs_existing: 1, new_configs: [] } };
    if (/^GET \/api\/naive-rag\/\d+\/document-configs\/$/.test(key))
      return {
        status: 200,
        body: [
          { naive_rag_document_id: 950, document_id: 1, file_name: 'doc.md', chunk_size: 1000, chunk_overlap: 150 },
        ],
      };
    if (/^PUT \/api\/naive-rag\/\d+\/document-configs\/bulk-update\/$/.test(key))
      return { status: 200, body: { message: 'Successfully updated 1 config(s)', updated_count: 1, failed_count: 0 } };
    if (key === 'POST /api/process-rag-indexing/') return { status: 200, body: { detail: 'started' } };
    if (/^DELETE \/api\/source-collections\/\d+\/$/.test(key)) return { status: 204, body: undefined };

    return { status: 404, body: { detail: `no mock for ${key}` } };
  }
}

interface ToolResultContent {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResultContent>;

class CaptureServer {
  handlers = new Map<string, ToolHandler>();
  registerTool(name: string, _def: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

function parse(result: ToolResultContent): { ok: boolean; data?: any; error?: string; next?: string } {
  const payload = JSON.parse(result.content[0]!.text) as { ok: boolean; data?: unknown; error?: string };
  return { ok: payload.ok, data: payload.data as any, error: payload.error };
}

describe('catalog tools (mock backend)', () => {
  let stateDir: string;
  let backend: MockBackend;
  let handlers: Map<string, ToolHandler>;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'es-mcp-catalog-'));
    process.env.ES_MCP_STATE_DIR = stateDir;
    backend = new MockBackend();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const result = await backend.handle(init?.method ?? 'GET', url, body);
      // 204 (and other null-body statuses) must not carry a body, or Response throws.
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const context = createContext(loadConfig(ENV));
    await context.auth.ensureAuthenticated();
    await context.org.resolve(); // auto-selects the single org
    const server = new CaptureServer();
    registerCatalogTools(server as unknown as McpServer, context);
    handlers = server.handlers;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('registers the full catalog tool set', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        'attach_rag',
        'create_agent',
        'create_collection',
        'create_surface',
        'delete_agent',
        'delete_collection',
        'delete_surface',
        'get_agent',
        'get_surface',
        'update_agent',
        'update_surface',
      ].sort(),
    );
  });

  it('create_surface resolves owner_agent + tool names to ids and posts them', async () => {
    const result = parse(
      await handlers.get('create_surface')!({
        name: 'ResearchDocs',
        owner_agent: 'Writer',
        python_tools: [{ tool: 'search', mode: 'allow' }],
        mcp_tools: [{ tool: 'fetch', mode: 'deny' }],
      }),
    );
    expect(result.ok).toBe(true);
    const post = backend.received.find((r) => r.method === 'POST' && r.path === '/api/surfaces/')!;
    const posted = post.body as {
      owner_agent: number;
      python_tools: Array<{ python_tool: number; mode: string }>;
      mcp_tools: Array<{ mcp_tool: number; mode: string }>;
    };
    expect(posted.owner_agent).toBe(5);
    expect(posted.python_tools[0]).toEqual({ python_tool: 9, mode: 'allow' });
    expect(posted.mcp_tools[0]).toEqual({ mcp_tool: 12, mode: 'deny' });
    expect(result.data.next).toContain('existing:');
  });

  it('create_surface reports a helpful message on a name conflict (400 already exists)', async () => {
    backend.overrides.set('POST /api/surfaces/', {
      status: 400,
      body: { status_code: 400, code: 'x', message: 'SurfaceValidationError: Surface with this Organization and Name already exists.' },
    });
    const result = parse(await handlers.get('create_surface')!({ name: 'Docs' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('update_surface');
    expect(result.error).toContain('already exists');
  });

  it('unknown reference name yields a clear resolution error', async () => {
    const result = parse(await handlers.get('create_surface')!({ name: 'X', owner_agent: 'Nope' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Agent "Nope" not found');
    expect(result.error).toContain('Writer'); // lists what is available
  });

  it('create_agent resolves llm_config + default_surfaces and reports conflict via update_agent (409)', async () => {
    const ok = parse(
      await handlers.get('create_agent')!({
        name: 'Newbie',
        instructions: 'do things',
        llm_config: 'gpt-4o-default',
        default_surfaces: [{ surface: 'Docs', place: 'flow' }],
      }),
    );
    expect(ok.ok).toBe(true);
    const post = backend.received.find((r) => r.method === 'POST' && r.path === '/api/agent-definitions/')!;
    const posted = post.body as { llm_config: number; default_surfaces: Array<{ surface: number; place: string }> };
    expect(posted.llm_config).toBe(55);
    expect(posted.default_surfaces[0]).toEqual({ surface: 7, place: 'flow' });

    backend.overrides.set('POST /api/agent-definitions/', {
      status: 409,
      body: { status_code: 409, code: 'agent_definition_conflict', message: 'AgentDefinitionConflictError: An agent with this name already exists.' },
    });
    const conflict = parse(
      await handlers.get('create_agent')!({ name: 'Writer', instructions: 'x', llm_config: 55 }),
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain('update_agent');
  });

  it('delete_surface warns that referencing flows will break on next push', async () => {
    const result = parse(await handlers.get('delete_surface')!({ surface: 7 }));
    expect(result.ok).toBe(true);
    expect(result.data.next).toContain('push_flow');
    expect(result.data.next).toContain('existing:');
    expect(backend.received.some((r) => r.method === 'DELETE' && r.path === '/api/surfaces/7/')).toBe(true);
  });

  it('create_collection runs create → naive RAG → indexing and points at wait_for_collections', async () => {
    const result = parse(
      await handlers.get('create_collection')!({ name: 'Handbook', rag: { strategy: 'naive' } }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.ragType).toBe('naive');
    expect(result.data.ragId).toBe(900);
    expect(result.data.indexingStarted).toBe(true);
    expect(result.data.next).toContain('wait_for_collections');
    expect(backend.received.some((r) => r.path.match(/naive-rag/))).toBe(true);
    expect(backend.received.some((r) => r.path === '/api/process-rag-indexing/')).toBe(true);
  });

  it('create_collection rejects a missing document path before creating the collection', async () => {
    const result = parse(
      await handlers.get('create_collection')!({ name: 'BadDocs', documents: ['/definitely/not/here.md'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('file(s) not found');
    expect(backend.received.some((r) => r.method === 'POST' && r.path === '/api/source-collections/')).toBe(false);
  });

  it('attach_rag requires llm_config for graph strategy', async () => {
    const result = parse(await handlers.get('attach_rag')!({ collection_id: 42, strategy: 'graph' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('graph RAG requires llm_config');
  });

  it('delete_collection warns the pgvector index is dropped irreversibly', async () => {
    const result = parse(await handlers.get('delete_collection')!({ collection_id: 42 }));
    expect(result.ok).toBe(true);
    expect(result.data.next).toContain('pgvector');
    expect(backend.received.some((r) => r.method === 'DELETE' && r.path === '/api/source-collections/42/')).toBe(true);
  });
});
