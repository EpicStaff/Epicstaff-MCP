import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { toVenvLib } from '../src/tools/venv.tools.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/**
 * The configuration / lifecycle tools (venvs, versions, recycle bin, configs, secrets, key-value
 * tables, tool catalog, labels, import/export) over the real MCP path — Zod parsing included —
 * against an in-process mock backend that records every request.
 */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw' };
const encodeSegment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const MOCK_JWT = `${encodeSegment({ alg: 'HS256' })}.${encodeSegment({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const SECRET_VALUE = 'sk-test-super-secret-value-1234';

interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = (request: Received) => Reply | Promise<Reply>;

describe('coverage tools (mock backend)', () => {
  let stateDir: string;
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  let received: Received[];
  let routes: Map<string, Route>;

  const route = (key: string, handler: Route | Reply): void => {
    routes.set(key, typeof handler === 'function' ? handler : () => handler);
  };
  const requests = (method: string, path: string): Received[] =>
    received.filter((request) => request.method === method && request.path === path);

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'es-mcp-coverage-'));
    process.env.ES_MCP_STATE_DIR = stateDir;
    received = [];
    routes = new Map();
    route('GET /api/auth/api-key/validate/', { status: 200, body: { active: true } });
    route('GET /api/profile/', { status: 200, body: { memberships: [{ organization: { id: 1, name: 'Org', is_active: true } }] } });
    route('POST /api/auth/login/', { status: 200, body: { access: MOCK_JWT }, headers: { 'Set-Cookie': 'auth.refresh=r; Path=/api/auth/' } });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const raw = init?.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const request: Received = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: new Headers(init?.headers),
      };
      received.push(request);
      const handler = routes.get(`${request.method} ${request.path}`);
      const reply = handler ? await handler(request) : { status: 404, body: { detail: `no mock for ${request.method} ${request.path}` } };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json', ...reply.headers },
      });
    });

    const context = createContext(loadConfig(ENV));
    context.store.update({ apiKey: 'stored-key', keyPrefix: 'stored-k', activeOrgId: 1 });
    ({ client, call } = await connectTools(context));
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    delete process.env.COVERAGE_TEST_KEY;
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ----- venvs ---------------------------------------------------------------

  it('toVenvLib splits a requirement string at its first operator', () => {
    expect(toVenvLib('requests>=2.31,<3')).toEqual({ name: 'requests', specification: '>=2.31,<3', version: null, description: null });
    expect(toVenvLib('pandas')).toEqual({ name: 'pandas', specification: '', version: null, description: null });
    expect(toVenvLib({ name: ' numpy ', version: '1.26.4' })).toEqual({
      name: 'numpy',
      specification: '',
      version: '1.26.4',
      description: null,
    });
    expect(() => toVenvLib('requests>=')).toThrow(/not a PEP 440 specifier set/);
  });

  it('create_venv posts the frontend venv payload and warns about a name another venv already has', async () => {
    route('GET /api/venvs/', { status: 200, body: { count: 1, limit: 1000, offset: 0, next: null, previous: null, result: [venv(3, 'ds')] } });
    route('POST /api/venvs/', (request) => ({ status: 201, body: { ...venv(9, 'ds'), ...(request.body as object), status: 'declared' } }));

    const { isError, body } = await call('create_venv', { name: 'ds', libraries: ['pandas', 'requests>=2.31'] });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/venvs/')[0]?.body).toEqual({
      name: 'ds',
      libs: [
        { name: 'pandas', specification: '', version: null, description: null },
        { name: 'requests', specification: '>=2.31', version: null, description: null },
      ],
    });
    expect(body.data.venv).toMatchObject({ id: 9, status: 'declared', libraries: ['pandas', 'requests>=2.31'] });
    expect(body.data.warning).toMatch(/ambiguous/);
    expect(body.data.next).toMatch(/building/);
  });

  it('delete_venv explains a venv that is still in use (409)', async () => {
    route('GET /api/venvs/', { status: 200, body: { count: 1, limit: 1000, offset: 0, next: null, previous: null, result: [venv(3, 'ds')] } });
    route('GET /api/venvs/3/', { status: 200, body: venv(3, 'ds') });
    route('DELETE /api/venvs/3/', { status: 409, body: { detail: 'This environment is still used by tool "fetch".' } });

    const { isError, body } = await call('delete_venv', { venv: 'ds' });

    expect(isError).toBe(true);
    expect(body.error).toMatch(/still in use and was not deleted.*fetch/);
  });

  // ----- versions ------------------------------------------------------------

  it('restore_graph_version reads the flow save_version and backs up first by default', async () => {
    route('GET /api/graph-versions/5/', { status: 200, body: { id: 5, graph_id: 77, name: 'v1', description: '', created_at: 'x' } });
    route('GET /api/graphs/77/', { status: 200, body: { id: 77, name: 'f', save_version: 12 } });
    route('POST /api/graph-versions/5/restore/', { status: 200, body: { restored: true, graph_id: 77, warnings: [], auto_backup_version_id: 6 } });

    const { isError, body } = await call('restore_graph_version', { version_id: 5 });

    expect(isError, JSON.stringify(body)).toBe(false);
    const restore = requests('POST', '/api/graph-versions/5/restore/')[0]!;
    expect(restore.body).toEqual({ save_version: 12 });
    expect(restore.query.get('backup')).toBe('true');
    expect(body.data.next).toMatch(/pull_flow.*version #6/);
  });

  it('restore_graph_version mode new_flow creates a separate flow and leaves the original alone', async () => {
    route('POST /api/graph-versions/5/create-graph/', { status: 201, body: { created: true, graph_id: 80, warnings: [] } });

    const { body } = await call('restore_graph_version', { version_id: 5, mode: 'new_flow' });

    expect(body.data).toMatchObject({ created: true, graph_id: 80 });
    expect(received.some((request) => request.path.includes('/restore/'))).toBe(false);
  });

  // ----- recycle bin -----------------------------------------------------------

  it('list_recycle_bin reads every bin, keeps going past a bin the user may not read, and names users', async () => {
    route('GET /api/recycle-bin/settings/', { status: 200, body: { retention_days: 7 } });
    for (const path of ['storage', 'agent-definitions', 'surfaces', 'python-code-tool', 'mcp-tools', 'source-collections', 'key-value-tables', 'realtime-channels', 'webhook-triggers', 'secrets']) {
      route(`GET /api/${path}/recycle-bin/`, { status: 200, body: { count: 0, next: null, previous: null, results: [] } });
    }
    route('GET /api/realtime-channels/recycle-bin/', { status: 403, body: { detail: 'no' } });
    route('GET /api/graphs/recycle-bin/', {
      status: 200,
      body: {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 4,
            name: 'Old flow',
            deleted_at: '2026-10-01T00:00:00Z',
            days_left: 3,
            details: [{ label: 'Deleted by', value: { id: 2, display_name: 'Ada', avatar_url: null }, format: 'user' }],
            contents: [{ name: 'start', kind: 'start' }],
            hidden_contents: [],
            contents_total: 1,
          },
        ],
      },
    });

    const { isError, body } = await call('list_recycle_bin');

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body.data.retention_days).toBe(7);
    expect(body.data.bins.flow.items[0]).toMatchObject({ id: 4, days_left: 3, details: { 'Deleted by': 'Ada' } });
    expect(body.data.unavailable).toEqual({ realtime_channel: 'no permission' });
    // The secrets bin refuses API keys — it is read with the user session.
    const secretsBin = requests('GET', '/api/secrets/recycle-bin/')[0]!;
    expect(secretsBin.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
    expect(secretsBin.headers.get('X-Api-Key')).toBeNull();
  });

  it('list_recycle_bin reads a bin page without hidden_contents (backends before it existed), with search', async () => {
    // The page RecycleBinActionsMixin.recycle_bin renders on a backend one release older than
    // d545c7a: RecycleBinEntrySerializer without `hidden_contents`.
    route('GET /api/recycle-bin/settings/', { status: 200, body: { retention_days: 30 } });
    route('GET /api/python-code-tool/recycle-bin/', {
      status: 200,
      body: {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 12,
            name: 'mcp-cov-test-tool',
            deleted_at: '2026-10-29T18:00:00Z',
            days_left: 30,
            details: [
              { label: 'Created by', value: { id: 3, display_name: null, avatar_url: null }, format: 'user' },
              { label: 'Deleted by', value: null, format: 'user' },
              { label: 'Description', value: 'Coverage tool.', format: 'text' },
            ],
            contents: [],
            contents_total: 0,
          },
        ],
      },
    });

    const { isError, body } = await call('list_recycle_bin', { kind: 'python_tool', search: 'mcp-cov-test' });

    expect(isError, JSON.stringify(body)).toBe(false);
    const request = requests('GET', '/api/python-code-tool/recycle-bin/')[0]!;
    expect(request.query.get('search')).toBe('mcp-cov-test');
    expect(body.data).toMatchObject({ kind: 'python_tool', count: 1 });
    expect(body.data.items).toEqual([
      {
        kind: 'python_tool',
        id: 12,
        name: 'mcp-cov-test-tool',
        deleted_at: '2026-10-29T18:00:00Z',
        days_left: 30,
        details: { 'Created by': 'user #3', 'Deleted by': null, Description: 'Coverage tool.' },
        contents_total: 0,
      },
    ]);
  });

  it('list_recycle_bin over every bin survives empty, partial, unpaged and current-shape answers', async () => {
    route('GET /api/recycle-bin/settings/', { status: 200, body: { retention_days: 30 } });
    for (const path of ['agent-definitions', 'surfaces', 'mcp-tools', 'source-collections', 'secrets', 'webhook-triggers']) {
      route(`GET /api/${path}/recycle-bin/`, { status: 200, body: { count: 0, next: null, previous: null, results: [] } });
    }
    route('GET /api/storage/recycle-bin/', { status: 404, body: { detail: 'Not found.' } });
    route('GET /api/realtime-channels/recycle-bin/', { status: 403, body: { detail: 'no' } });
    // d545c7a shape: hidden_contents counted into contents_total.
    route('GET /api/graphs/recycle-bin/', {
      status: 200,
      body: {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 4,
            name: 'Old flow',
            deleted_at: 'x',
            days_left: 3,
            details: [],
            contents: [{ name: 'start', kind: 'start' }],
            hidden_contents: [{ kind: 'surface', count: 2 }],
            contents_total: 3,
          },
        ],
      },
    });
    // A partial entry (no details / contents / totals at all) and an older unpaged list.
    route('GET /api/python-code-tool/recycle-bin/', {
      status: 200,
      body: { count: 1, results: [{ id: 12, name: 'tool', deleted_at: 'x', days_left: 1 }] },
    });
    route('GET /api/key-value-tables/recycle-bin/', {
      status: 200,
      body: [
        { id: 7, name: 'Profiles', deleted_at: 'x', days_left: 2, details: [], contents: [{ name: 'k', kind: 'key' }], contents_total: 1 },
      ],
    });

    const { isError, body } = await call('list_recycle_bin');

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body.data.bins.flow).toMatchObject({ count: 1, items: [{ id: 4, contents_total: 3, hidden_contents: 2 }] });
    expect(body.data.bins.python_tool).toEqual({
      count: 1,
      items: [{ kind: 'python_tool', id: 12, name: 'tool', deleted_at: 'x', days_left: 1, details: {}, contents_total: 0 }],
    });
    expect(body.data.bins.key_value_table).toMatchObject({ count: 1, items: [{ id: 7, contents: ['key: k'] }] });
    expect(body.data.bins.agent).toBeUndefined();
    expect(body.data.unavailable).toEqual({ realtime_channel: 'no permission', storage: 'not available' });
  });

  it('restore_from_recycle_bin all: true restores the whole bin of one kind; ids and all exclude each other', async () => {
    route('POST /api/python-code-tool/recycle-bin/restore/', {
      status: 200,
      body: { restored: [{ id: 3, name: 'fetch', renamed_from: null, links_restored: true }], failed: [] },
    });

    const both = await call('restore_from_recycle_bin', { kind: 'python_tool', ids: [3], all: true });
    const neither = await call('restore_from_recycle_bin', { kind: 'python_tool' });
    expect(both.body.error).toMatch(/either ids .* or all: true/);
    expect(neither.body.error).toMatch(/either ids .* or all: true/);
    expect(requests('POST', '/api/python-code-tool/recycle-bin/restore/')).toHaveLength(0);

    const { isError, body } = await call('restore_from_recycle_bin', { kind: 'python_tool', all: true });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/python-code-tool/recycle-bin/restore/')[0]?.body).toEqual({ all: true });
    expect(body.data.restored).toHaveLength(1);
  });

  it('purge_from_recycle_bin has no all option: a whole-bin purge is never sent', async () => {
    const { tools } = await client.listTools();
    const purge = tools.find((tool) => tool.name === 'purge_from_recycle_bin');
    expect(purge?.inputSchema.properties).not.toHaveProperty('all');
    expect(purge?.inputSchema.required).toContain('ids');

    const result = await call('purge_from_recycle_bin', { kind: 'flow', all: true, confirm: true });

    expect(result.isError).toBe(true);
    expect(received.filter((request) => request.path.includes('/recycle-bin/purge/'))).toHaveLength(0);
  });

  it('restore_from_recycle_bin posts the bulk {ids} body of the editor', async () => {
    route('POST /api/agent-definitions/recycle-bin/restore/', {
      status: 200,
      body: { restored: [{ id: 3, name: 'Writer (1)', renamed_from: 'Writer', links_restored: true }], failed: [] },
    });

    const { body } = await call('restore_from_recycle_bin', { kind: 'agent', ids: [3] });

    expect(requests('POST', '/api/agent-definitions/recycle-bin/restore/')[0]?.body).toEqual({ ids: [3] });
    expect(body.data.note).toMatch(/new name/);
  });

  it('purge_from_recycle_bin demands confirm: true and goes through the user session', async () => {
    route('POST /api/surfaces/recycle-bin/purge/', { status: 200, body: { purged: [8], failed: [] } });

    const refused = await call('purge_from_recycle_bin', { kind: 'surface', ids: [8] });
    expect(refused.isError).toBe(true);
    expect(requests('POST', '/api/surfaces/recycle-bin/purge/')).toHaveLength(0);

    const { isError, body } = await call('purge_from_recycle_bin', { kind: 'surface', ids: [8], confirm: true });
    expect(isError, JSON.stringify(body)).toBe(false);
    const purge = requests('POST', '/api/surfaces/recycle-bin/purge/')[0]!;
    expect(purge.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
    expect(purge.headers.get('X-Api-Key')).toBeNull();
  });

  it('purge_from_recycle_bin turns the non-superadmin 403 into an explanation', async () => {
    route('POST /api/surfaces/recycle-bin/purge/', { status: 403, body: { detail: 'You do not have permission.' } });
    const { body } = await call('purge_from_recycle_bin', { kind: 'surface', ids: [8], confirm: true });
    expect(body.error).toMatch(/only a superadmin/);
  });

  // ----- secrets / credentials ---------------------------------------------------

  it('create_secret reads the value from the environment and never returns or logs it', async () => {
    process.env.COVERAGE_TEST_KEY = SECRET_VALUE;
    const logged: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    route('GET /api/secrets/', { status: 200, body: { count: 0, results: [] } });
    route('POST /api/secrets/', (request) => ({
      status: 201,
      body: { id: 21, name: (request.body as { name: string }).name, tail: SECRET_VALUE.slice(-4) },
    }));

    const result = await call('create_secret', { name: 'openai', value_env: 'COVERAGE_TEST_KEY' });
    stderr.mockRestore();

    expect(result.isError, result.text).toBe(false);
    expect(requests('POST', '/api/secrets/')[0]?.body).toEqual({ name: 'openai', value: SECRET_VALUE });
    expect(result.body.data).toEqual({ secret: { id: 21, name: 'openai' }, source: 'environment variable COVERAGE_TEST_KEY' });
    expect(result.text).not.toContain(SECRET_VALUE);
    expect(result.text).not.toContain(SECRET_VALUE.slice(-4));
    expect(logged.join('')).not.toContain(SECRET_VALUE);
  });

  it('create_secret strips a backend error that echoes the value', async () => {
    process.env.COVERAGE_TEST_KEY = SECRET_VALUE;
    route('GET /api/secrets/', { status: 200, body: { count: 0, results: [] } });
    route('POST /api/secrets/', {
      status: 400,
      body: { errors: [{ field: 'value', value: SECRET_VALUE, reason: 'too long' }] },
    });

    const result = await call('create_secret', { name: 'openai', value_env: 'COVERAGE_TEST_KEY' });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(SECRET_VALUE);
    expect(result.body.error).toMatch(/value was rejected \(value not shown\)/);
  });

  it('create_secret refuses the MCP server\'s own variables', async () => {
    const result = await call('create_secret', { name: 'x', value_env: 'EPICSTAFF_PASSWORD' });
    expect(result.isError).toBe(true);
    expect(requests('POST', '/api/secrets/')).toHaveLength(0);
  });

  it('create_llm_config stores api_key_env as the es-mcp secret and sends only its id', async () => {
    process.env.COVERAGE_TEST_KEY = SECRET_VALUE;
    route('GET /api/secrets/', { status: 200, body: { count: 0, results: [] } });
    route('POST /api/secrets/', { status: 201, body: { id: 21, name: 'es-mcp:COVERAGE_TEST_KEY', tail: '1234' } });
    route('GET /api/llm-models/', { status: 200, body: [{ id: 10, name: 'gpt-4o-mini', llm_provider: 1 }] });
    route('GET /api/providers/', { status: 200, body: [{ id: 1, name: 'openai' }] });
    route('POST /api/llm-configs/', (request) => ({ status: 201, body: { id: 55, ...(request.body as object) } }));

    const result = await call('create_llm_config', {
      name: 'fast',
      model: 'gpt-4o-mini',
      provider: 'openai',
      api_key_env: 'COVERAGE_TEST_KEY',
      temperature: 0.3,
    });

    expect(result.isError, result.text).toBe(false);
    expect(requests('POST', '/api/secrets/')[0]?.body).toEqual({ name: 'es-mcp:COVERAGE_TEST_KEY', value: SECRET_VALUE });
    expect(requests('POST', '/api/llm-configs/')[0]?.body).toEqual({
      custom_name: 'fast',
      model: 10,
      api_key_secret_id: 21,
      temperature: 0.3,
    });
    expect(result.text).not.toContain(SECRET_VALUE);
  });

  it('delete_llm_config uses the bulk-delete route and passes dry_run through', async () => {
    route('GET /api/llm-configs/', { status: 200, body: [{ id: 55, custom_name: 'fast', model: 10 }] });
    route('POST /api/llm-configs/bulk-delete/', { status: 200, body: { dry_run: true, deleted_count: 0, deleted_ids: [], deletable_ids: [], not_found_ids: [], skipped: [{ id: 55, reason: 'in_use_restricted' }], usage: {} } });

    const { body } = await call('delete_llm_config', { config: 'fast', dry_run: true });

    const request = requests('POST', '/api/llm-configs/bulk-delete/')[0]!;
    expect(request.body).toEqual({ ids: [55] });
    expect(request.query.get('dry_run')).toBe('true');
    expect(body.data.skipped).toEqual([{ id: 55, reason: 'in_use_restricted' }]);
  });

  it('update_default_models resolves config names and sends only the named slots', async () => {
    route('GET /api/llm-configs/', { status: 200, body: [{ id: 55, custom_name: 'fast', model: 10 }] });
    route('GET /api/embedding-configs/', { status: 200, body: [{ id: 71, custom_name: 'embed', model: 20 }] });
    route('PUT /api/default-models/', (request) => ({ status: 200, body: request.body }));

    await call('update_default_models', { agent_llm_config: 'fast', memory_embedding_config: 'embed', memory_llm_config: null });

    expect(requests('PUT', '/api/default-models/')[0]?.body).toEqual({
      agent_llm_config: 55,
      memory_llm_config: null,
      memory_embedding_config: 71,
    });
  });

  it('run_quickstart passes an existing secret by id and applies the defaults on request', async () => {
    route('GET /api/secrets/', { status: 200, body: { count: 1, results: [{ id: 21, name: 'openai-key', tail: '' }] } });
    route('POST /api/quickstart/', { status: 200, body: { detail: 'ok', config_name: 'openai-1', configs: { config_name: 'openai-1', llm_config: { id: 60, custom_name: 'openai-1', model: 10 }, embedding_config: null } } });
    route('POST /api/quickstart/apply/', { status: 200, body: { agent_llm_config: 60 } });

    const { isError, body } = await call('run_quickstart', { provider: 'openai', api_key_secret: 'openai-key', apply_defaults: true });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/quickstart/')[0]?.body).toEqual({ provider: 'openai', api_key_secret_id: 21 });
    expect(body.data.default_models).toEqual({ agent_llm_config: 60 });
  });

  // ----- key-value tables -----------------------------------------------------------

  it('write_key_value_entries upserts by exact key (search is a substring match) and deletes', async () => {
    route('GET /api/key-value-tables/', { status: 200, body: { count: 1, results: [{ id: 4, name: 'Profiles' }] } });
    route('GET /api/key-value-table-entries/', (request) => {
      const search = request.query.get('search');
      const rows = [
        { id: 100, table: 4, key: 'user_10', value_preview: '1' },
        { id: 101, table: 4, key: 'user_1', value_preview: '2' },
      ].filter((row) => row.key.includes(search ?? ''));
      return { status: 200, body: { count: rows.length, results: rows } };
    });
    route('PATCH /api/key-value-table-entries/101/', { status: 200, body: {} });
    route('POST /api/key-value-table-entries/', { status: 201, body: {} });
    route('DELETE /api/key-value-table-entries/100/', { status: 204 });

    const { body } = await call('write_key_value_entries', {
      table: 'profiles',
      set: { user_1: { plan: 'pro' }, user_2: 'new' },
      delete: ['user_10', 'ghost'],
    });

    expect(requests('PATCH', '/api/key-value-table-entries/101/')[0]?.body).toEqual({ value: { plan: 'pro' } });
    expect(requests('POST', '/api/key-value-table-entries/')[0]?.body).toEqual({ table: 4, key: 'user_2', value: 'new' });
    expect(body.data).toEqual({ table: 4, created: ['user_2'], updated: ['user_1'], deleted: ['user_10'], notFound: ['ghost'] });
  });

  // ----- tool catalog / labels ----------------------------------------------------------

  it('create_python_tool sends the frontend CreatePythonCodeBody with the resolved venv and labels', async () => {
    route('GET /api/venvs/', { status: 200, body: { count: 1, limit: 1000, offset: 0, next: null, previous: null, result: [venv(3, 'ds')] } });
    route('GET /api/tool-labels/', { status: 200, body: { count: 1, results: [{ id: 7, name: 'web', parent: 6, full_path: 'net/web', metadata: {} }] } });
    route('POST /api/python-code-tool/', (request) => ({ status: 201, body: { id: 90, ...(request.body as object) } }));

    const { isError, body } = await call('create_python_tool', {
      name: 'fetch',
      description: 'Fetch a page.',
      code: 'def main():\n    return 1',
      venv: 'ds',
      labels: ['net/web'],
    });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/python-code-tool/')[0]?.body).toEqual({
      name: 'fetch',
      description: 'Fetch a page.',
      variables: [],
      python_code: { code: 'def main():\n    return 1', entrypoint: 'main', venv_id: 3, global_kwargs: {} },
      labels: [7],
    });
  });

  it('update_python_tool sends only the python_code fields that changed', async () => {
    route('GET /api/python-code-tool/', { status: 200, body: [{ id: 90, name: 'fetch', description: '' }] });
    route('PATCH /api/python-code-tool/90/', (request) => ({ status: 200, body: { id: 90, name: 'fetch', ...(request.body as object) } }));

    await call('update_python_tool', { tool: 'fetch', venv: null, execution_timeout: 120 });

    expect(requests('PATCH', '/api/python-code-tool/90/')[0]?.body).toEqual({ python_code: { venv_id: null, execution_timeout: 120 } });
  });

  // ----- flows: labels, export/import, persistent state, describe ------------------------

  it('set_flow_labels resolves label paths and PATCHes with the current save_version', async () => {
    route('GET /api/labels/', { status: 200, body: { count: 1, results: [{ id: 2, name: 'prod', parent: null, full_path: 'prod', metadata: {} }] } });
    route('GET /api/graphs/77/', { status: 200, body: { id: 77, name: 'f', save_version: 3 } });
    route('PATCH /api/graphs/77/', (request) => ({ status: 200, body: { id: 77, save_version: 4, ...(request.body as object) } }));

    await call('set_flow_labels', { graph_id: 77, labels: ['prod'] });

    expect(requests('PATCH', '/api/graphs/77/')[0]?.body).toEqual({ save_version: 3, label_ids: [2] });
  });

  it('export_entities writes the export document and reports what was left out', async () => {
    const outputPath = join(stateDir, 'out', 'flows.json');
    route('POST /api/graphs/bulk-export/', {
      status: 200,
      body: { main_entity: 'Flow', Flow: [{ id: 1 }, { id: 2 }] },
      headers: { 'X-Export-Excluded': JSON.stringify([{ type: 'Agent', count: 1, names: ['Secret agent'] }]) },
    });

    const { isError, body } = await call('export_entities', { ids: [1, 2], output_path: outputPath });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/graphs/bulk-export/')[0]?.body).toEqual({ ids: [1, 2] });
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({ main_entity: 'Flow', Flow: [{ id: 1 }, { id: 2 }] });
    expect(body.data.excluded).toEqual([{ type: 'Agent', count: 1, names: ['Secret agent'] }]);
  });

  it('export_entities refuses an existing file, a non-.json path and a symbolic link; overwrite: true replaces', async () => {
    const outDir = join(stateDir, 'exports');
    mkdirSync(outDir, { recursive: true });
    const outputPath = join(outDir, 'flows.json');
    writeFileSync(outputPath, 'keep me');
    route('POST /api/graphs/bulk-export/', { status: 200, body: { main_entity: 'Flow', Flow: [{ id: 1 }, { id: 2 }] } });

    const existing = await call('export_entities', { ids: [1, 2], output_path: outputPath });
    expect(existing.isError).toBe(true);
    expect(existing.body.error).toBe(
      `${outputPath} already exists — export to a new path, or pass overwrite: true if you really want to replace it.`,
    );
    expect(readFileSync(outputPath, 'utf8')).toBe('keep me');

    const notJson = await call('export_entities', { ids: [1, 2], output_path: join(outDir, 'flows.txt'), overwrite: true });
    expect(notJson.body.error).toMatch(/must be an absolute path to a \.json file/);

    // A link to a file elsewhere: never written through, with or without overwrite.
    const target = join(stateDir, 'elsewhere.json');
    writeFileSync(target, 'precious');
    const link = join(outDir, 'link.json');
    symlinkSync(target, link);
    for (const overwrite of [false, true]) {
      const linked = await call('export_entities', { ids: [1, 2], output_path: link, overwrite });
      expect(linked.body.error).toMatch(/is a symbolic link — refusing to write through it/);
    }
    expect(readFileSync(target, 'utf8')).toBe('precious');
    // Refused paths cost no export request.
    expect(requests('POST', '/api/graphs/bulk-export/')).toHaveLength(0);

    const replaced = await call('export_entities', { ids: [1, 2], output_path: outputPath, overwrite: true });
    expect(replaced.isError, JSON.stringify(replaced.body)).toBe(false);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({ main_entity: 'Flow', Flow: [{ id: 1 }, { id: 2 }] });
  });

  it('import_entities uploads the file as multipart with the editor\'s import options', async () => {
    const filePath = join(stateDir, 'flows.json');
    writeFileSync(filePath, '{"main_entity":"Flow"}');
    route('POST /api/graphs/import/', { status: 200, body: { Flow: { created: 1 } } });

    const refused = await call('import_entities', { file_path: filePath, replace_existing: true });
    expect(refused.body.error).toMatch(/requires preserve_uuids/);

    const { isError } = await call('import_entities', { file_path: filePath, preserve_uuids: true, replace_existing: true });

    expect(isError).toBe(false);
    const form = requests('POST', '/api/graphs/import/')[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('preserve_uuids')).toBe('true');
    expect(form.get('replace_existing')).toBe('true');
    expect(form.get('import_labels')).toBe('true');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('get_flow_persistent_state returns only the asked flow\'s org and member state', async () => {
    route('GET /api/graph-organizations/', { status: 200, body: { count: 2, results: [
      { id: 1, graph: 77, persistent_variables: { counter: 3 }, user_variables: {} },
      { id: 2, graph: 78, persistent_variables: { other: 1 }, user_variables: {} },
    ] } });
    route('GET /api/graph-organization-users/', { status: 200, body: { count: 1, results: [
      { id: 5, graph: 77, organization_user: 9, persistent_variables: { name: 'Ada' } },
    ] } });

    const { body } = await call('get_flow_persistent_state', { graph_id: 77 });

    expect(body.data).toEqual({
      graphId: 77,
      organization: { persistent_variables: { counter: 3 }, user_variables_seed: {} },
      users: [{ organization_user: 9, persistent_variables: { name: 'Ada' } }],
    });
  });

  it('describe_graph names authors and last editors and shows node numbers', async () => {
    route('GET /api/graphs/77/', {
      status: 200,
      body: {
        id: 77,
        name: 'f',
        description: '',
        save_version: 3,
        created_at: '2026-01-01T00:00:00Z',
        created_by: { id: 1, display_name: 'Ada', avatar_url: null },
        last_edited_by: { id: 2, display_name: null, avatar_url: null },
        last_edited_at: '2026-02-01T00:00:00Z',
        python_node_list: [
          {
            id: 5,
            node_name: 'crunch',
            node_number: 2,
            python_code: { venv_id: 3 },
            created_by: { id: 1, display_name: 'Ada', avatar_url: null },
            last_edited_by: null,
            last_edited_at: null,
          },
        ],
        edge_list: [],
      },
    });

    const { body } = await call('describe_graph', { graph_id: 77 });

    expect(body.data).toMatchObject({ created_by: 'Ada', last_edited_by: 'user #2', last_edited_at: '2026-02-01T00:00:00Z' });
    expect(body.data.nodes.python_node_list[0]).toMatchObject({
      node_number: 2,
      venv_id: 3,
      created_by: 'Ada',
      last_edited_by: null,
    });
  });
});

function venv(id: number, name: string): Record<string, unknown> {
  return { id, name, libs: [], status: 'completed', error: null, owner: null, created_at: null, is_favorite: false };
}
