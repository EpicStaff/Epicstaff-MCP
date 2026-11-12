import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApi } from '../src/api/knowledge.js';
import { pollPythonCodeResult, type PythonCodeResult } from '../src/api/python-code-run.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import type { ApiClient } from '../src/http/client.js';
import { ApiError } from '../src/http/errors.js';
import { CODE_RUN_OUTPUT_LIMIT } from '../src/tools/code-run.tools.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/**
 * The debugging / knowledge / housekeeping tools that close the API coverage gaps: code test runs,
 * trigger test runs, Telegram fields, filter presets, emptying the recycle bin, storage imports,
 * indexing estimates and indexed chunks — over the real MCP path against a recording mock backend.
 */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw' };
const encodeSegment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const MOCK_JWT = `${encodeSegment({ alg: 'HS256' })}.${encodeSegment({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = (request: Received) => Reply | Promise<Reply>;

/** A graph with one python node, one webhook trigger and one Telegram trigger (ids collide on purpose). */
function graphDto(): Record<string, unknown> {
  return {
    id: 7,
    name: 'flow',
    save_version: 3,
    python_node_list: [
      { id: 11, node_name: 'clean_text', graph: 7, python_code: { id: 1, code: '', entrypoint: 'main', execution_timeout: 30 } },
    ],
    webhook_trigger_node_list: [
      {
        id: 11,
        node_name: 'inbound',
        graph: 7,
        python_code: { id: 2, code: '', entrypoint: 'main' },
        test_payload: { order: 42 },
      },
    ],
    telegram_trigger_node_list: [{ id: 21, node_name: 'bot', graph: 7, fields: [], test_payload: {} }],
  };
}

describe('coverage-gap tools (mock backend)', () => {
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
    stateDir = mkdtempSync(join(tmpdir(), 'es-mcp-gaps-'));
    process.env.ES_MCP_STATE_DIR = stateDir;
    received = [];
    routes = new Map();
    route('GET /api/auth/api-key/validate/', { status: 200, body: { active: true } });
    route('GET /api/profile/', { status: 200, body: { memberships: [{ organization: { id: 1, name: 'Org', is_active: true } }] } });
    route('POST /api/auth/login/', { status: 200, body: { access: MOCK_JWT }, headers: { 'Set-Cookie': 'auth.refresh=r; Path=/api/auth/' } });
    route('GET /api/graphs/7/', { status: 200, body: graphDto() });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const raw = init?.body;
      const request: Received = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body: typeof raw === 'string' ? JSON.parse(raw) : raw,
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
    context.store.update({ apiKeys: { 1: { key: 'stored-key', prefix: 'stored-k' } }, activeOrgId: 1 });
    ({ client, call } = await connectTools(context));
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ----- code test runs ------------------------------------------------------------

  it('run_node_code resolves a python node by name, posts the frontend target body and returns the result', async () => {
    route('POST /api/run-python-code/', { status: 200, body: { execution_id: 'exec-1' } });
    route('GET /api/execution-timeout-limits/', { status: 200, body: { min_seconds: 1, default_seconds: 60, max_seconds: 20 } });
    route('GET /api/python-code-result/exec-1/', {
      status: 200,
      body: { execution_id: 'exec-1', status: 'completed', returncode: 0, result_data: '"HELLO"', stdout: 'ok\n', stderr: '' },
    });

    const { isError, body } = await call('run_node_code', { graph_id: 7, node: 'clean_text', variables: { text: 'hello' } });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/run-python-code/')[0]?.body).toEqual({
      target: { type: 'python_node', id: 11 },
      variables: { text: 'hello' },
    });
    expect(body.data).toMatchObject({
      node: { kind: 'python', id: 11, node_name: 'clean_text' },
      status: 'completed',
      returncode: 0,
      result_data: '"HELLO"',
      stdout: 'ok\n',
    });
    expect(body.data).not.toHaveProperty('replayed_input');
  });

  it('run_node_code needs node_type when an id matches a python node and a webhook trigger', async () => {
    const ambiguous = await call('run_node_code', { graph_id: 7, node: 11, wait: false });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.body.error).toMatch(/ambiguous.*node_type/);
    expect(requests('POST', '/api/run-python-code/')).toHaveLength(0);

    route('POST /api/run-python-code/', { status: 200, body: { execution_id: 'exec-2' } });
    const { body } = await call('run_node_code', { graph_id: 7, node: 11, node_type: 'webhook-trigger', variables: { a: 1 }, wait: false });
    expect(requests('POST', '/api/run-python-code/')[0]?.body).toEqual({
      target: { type: 'webhook_trigger_node', id: 11 },
      variables: { a: 1 },
    });
    expect(body.data).toMatchObject({ execution_id: 'exec-2', next: expect.stringMatching(/get_code_run_result/) });
  });

  it('run_node_code replays the last session input of a python node, and says when there is none', async () => {
    route('GET /api/pythonnodes/11/last-session-input/', {
      status: 200,
      body: { detail: 'Last test input retrieved successfully.', input: { text: 'from session', limit: 2 } },
    });
    route('POST /api/run-python-code/', { status: 200, body: { execution_id: 'exec-3' } });

    const { body } = await call('run_node_code', { graph_id: 7, node: 'clean_text', use_last_session_input: true, wait: false });

    expect(requests('POST', '/api/run-python-code/')[0]?.body).toEqual({
      target: { type: 'python_node', id: 11 },
      variables: { text: 'from session', limit: 2 },
    });
    expect(body.data.replayed_input).toEqual({ text: 'from session', limit: 2 });

    route('GET /api/pythonnodes/11/last-session-input/', {
      status: 200,
      body: { detail: 'No matching test input found for this node.', input: null },
    });
    const none = await call('run_node_code', { graph_id: 7, node: 'clean_text', use_last_session_input: true });
    expect(none.isError).toBe(true);
    expect(none.body.error).toMatch(/No ended session.*pass variables/);

    const both = await call('run_node_code', { graph_id: 7, node: 'clean_text', variables: {}, use_last_session_input: true });
    expect(both.body.error).toMatch(/either variables or use_last_session_input/);
  });

  it('run_node_code explains the Flows UPDATE gate and names unknown nodes', async () => {
    route('POST /api/run-python-code/', { status: 403, body: { detail: 'no' } });
    const refused = await call('run_node_code', { graph_id: 7, node: 'inbound', wait: false });
    expect(refused.body.error).toMatch(/Flows UPDATE.*Flows USE/);

    const missing = await call('run_node_code', { graph_id: 7, node: 'nope' });
    expect(missing.body.error).toMatch(/No python or webhook-trigger node "nope".*clean_text.*Push the flow first/);
  });

  it('get_code_run_result cuts long streams and flags a pending run', async () => {
    route('GET /api/python-code-result/exec-9/', {
      status: 200,
      body: { execution_id: 'exec-9', status: 'pending', returncode: null, result_data: null, stdout: 'x'.repeat(CODE_RUN_OUTPUT_LIMIT + 5), stderr: '' },
    });

    const { body } = await call('get_code_run_result', { execution_id: 'exec-9' });

    expect(body.data.stdout).toHaveLength(CODE_RUN_OUTPUT_LIMIT + 1);
    expect(body.data.truncated).toMatch(/stdout/);
    expect(body.data.next).toMatch(/Still running/);
  });

  it('pollPythonCodeResult waits out the create race, then stops at the deadline or on a later 404', async () => {
    const pending: PythonCodeResult = { execution_id: 'e', status: 'pending', result_data: null, returncode: null, stderr: '', stdout: '' };
    const done: PythonCodeResult = { ...pending, status: 'completed', returncode: 0, result_data: '1' };
    let clock = 0;
    const timing = { sleep: async (milliseconds: number) => void (clock += milliseconds), now: () => clock };
    const notFound = new ApiError(404, 'u', 'Request failed with HTTP 404');

    const answers: Array<PythonCodeResult | ApiError> = [notFound, notFound, pending, done];
    const finished = await pollPythonCodeResult(
      {
        getResult: async () => {
          const answer = answers.shift();
          if (answer instanceof ApiError) throw answer;
          return answer!;
        },
      },
      'e',
      30,
      timing,
    );
    expect(finished).toEqual({ finished: true, result: done });

    clock = 0;
    const stillPending = await pollPythonCodeResult({ getResult: async () => pending }, 'e', 1, { ...timing, graceMs: 4000 });
    expect(stillPending).toEqual({ finished: false, lastStatus: 'pending' });
    expect(clock).toBeLessThanOrEqual(1000 + 4000);

    await expect(
      pollPythonCodeResult({ getResult: async () => Promise.reject(notFound) }, 'e', 30, timing),
    ).rejects.toThrow(/not found in the active organization/);
  });

  // ----- trigger test runs -----------------------------------------------------------

  it('run_flow_from_trigger posts the trigger test body, defaulting to the payload saved on the node', async () => {
    route('POST /api/run-session/test/', { status: 201, body: { session_id: 500 } });

    const { isError, body } = await call('run_flow_from_trigger', { graph_id: 7, node: 'inbound' });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/run-session/test/')[0]?.body).toEqual({
      graph_id: 7,
      node_type: 'webhook-trigger',
      node_id: 11,
      payload: { order: 42 },
    });
    expect(body.data).toMatchObject({
      session_id: 500,
      payload_variable: 'variables.trigger_payload',
      payload_source: 'the test payload saved on the node',
    });
  });

  it('run_flow_from_trigger explains a refused Telegram payload (fields are selected in the editor)', async () => {
    route('POST /api/run-session/test/', {
      status: 400,
      body: { payload: ['This Telegram trigger has no fields selected; select fields before running a test.'] },
    });

    const { isError, body } = await call('run_flow_from_trigger', {
      graph_id: 7,
      node: 'bot',
      payload: { message: { text: 'hi' } },
    });

    expect(isError).toBe(true);
    expect(requests('POST', '/api/run-session/test/')[0]?.body).toMatchObject({ node_type: 'telegram-trigger', node_id: 21 });
    expect(body.error).toMatch(/no fields selected.*list_telegram_trigger_fields.*EpicStaff editor/);
  });

  it('list_telegram_trigger_fields unwraps the backend data and filters by parent', async () => {
    const fields = {
      message: [{ field_name: 'text', field_type: 'String', description: 'Text' }],
      callback_query: [{ field_name: 'data', field_type: 'String', description: 'Data' }],
    };
    route('GET /api/telegram-trigger-available-fields/', { status: 200, body: { data: fields } });

    expect((await call('list_telegram_trigger_fields')).body.data).toEqual(fields);
    expect((await call('list_telegram_trigger_fields', { parent: 'message' })).body.data).toEqual({ message: fields.message });
    expect((await call('list_telegram_trigger_fields', { parent: 'poll' })).body.error).toMatch(/Unknown parent.*message, callback_query/);
  });

  // ----- filter presets --------------------------------------------------------------

  it('filter preset tools list, create, update (by name) and delete flow and tool presets', async () => {
    const preset = { id: 4, name: 'Billing', filter_body: { sortOrder: 'name_asc' }, created_at: 'c', updated_at: 'u' };
    route('GET /api/flow-filter-presets/', { status: 200, body: { count: 1, results: [preset] } });
    route('POST /api/tool-filter-presets/', (request) => ({ status: 201, body: { ...preset, id: 9, ...(request.body as object) } }));
    route('PATCH /api/flow-filter-presets/4/', (request) => ({ status: 200, body: { ...preset, ...(request.body as object) } }));
    route('DELETE /api/flow-filter-presets/4/', { status: 204 });

    const listed = await call('list_filter_presets', { scope: 'flow' });
    expect(requests('GET', '/api/flow-filter-presets/')[0]?.query.get('limit')).toBe('1000');
    expect(listed.body.data).toEqual([{ scope: 'flow', id: 4, name: 'Billing', filter_body: { sortOrder: 'name_asc' }, updated_at: 'u' }]);

    await call('create_filter_preset', { scope: 'tool', name: 'Unused', filter_body: { unusedOnly: true } });
    expect(requests('POST', '/api/tool-filter-presets/')[0]?.body).toEqual({ name: 'Unused', filter_body: { unusedOnly: true } });

    const updated = await call('update_filter_preset', { scope: 'flow', preset: 'billing', filter_body: { sortOrder: 'last_modified' } });
    expect(updated.isError, JSON.stringify(updated.body)).toBe(false);
    expect(requests('PATCH', '/api/flow-filter-presets/4/')[0]?.body).toEqual({ filter_body: { sortOrder: 'last_modified' } });

    const nothing = await call('update_filter_preset', { scope: 'flow', preset: 4 });
    expect(nothing.body.error).toMatch(/Nothing to change/);

    const deleted = await call('delete_filter_preset', { scope: 'flow', preset: 4 });
    expect(deleted.body.data).toEqual({ deleted: { scope: 'flow', id: 4 } });
  });

  // ----- recycle bin -----------------------------------------------------------------

  it('empty_recycle_bin calls again while it makes progress, through the user session, merging failures', async () => {
    const answers = [
      { purged_count: 100, remaining: 30, failed: [{ source: 'flow', id: 3, name: 'f', message: 'busy' }] },
      { purged_count: 29, remaining: 1, failed: [{ source: 'flow', id: 3, name: 'f', message: 'still busy' }] },
      { purged_count: 0, remaining: 1, failed: [{ source: 'flow', id: 3, name: 'f', message: 'still busy' }] },
    ];
    route('POST /api/recycle-bin/empty/', () => ({ status: 200, body: answers.shift() }));

    const { isError, body } = await call('empty_recycle_bin', { organization_id: 1, confirm: true });

    expect(isError, JSON.stringify(body)).toBe(false);
    const calls = requests('POST', '/api/recycle-bin/empty/');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
    expect(calls[0]?.headers.get('X-Api-Key')).toBeNull();
    expect(calls[0]?.headers.get('X-Organization-Id')).toBe('1');
    expect(body.data).toEqual({
      organization_id: 1,
      purged: 129,
      failed: [{ source: 'flow', id: 3, name: 'f', message: 'still busy' }],
    });
  });

  it('empty_recycle_bin refuses another org or a missing confirm before any request, and explains a 403', async () => {
    const wrongOrg = await call('empty_recycle_bin', { organization_id: 2, confirm: true });
    expect(wrongOrg.body.error).toMatch(/not the active organization.*Nothing was deleted/);
    const unconfirmed = await call('empty_recycle_bin', { organization_id: 1 });
    expect(unconfirmed.isError).toBe(true);
    expect(requests('POST', '/api/recycle-bin/empty/')).toHaveLength(0);

    route('POST /api/recycle-bin/empty/', { status: 403, body: { detail: 'no' } });
    const refused = await call('empty_recycle_bin', { organization_id: 1, confirm: true });
    expect(refused.body.error).toMatch(/only a superadmin/);
  });

  // ----- knowledge -------------------------------------------------------------------

  it('import_documents_from_storage resolves paths to storage ids, imports, reports skips and re-indexes', async () => {
    route('GET /api/storage/info/', (request) =>
      request.query.get('path') === 'docs/'
        ? { status: 200, body: { id: 70, name: 'docs', path: 'docs/' } }
        : { status: 404, body: { path: 'File does not exist' } },
    );
    route('POST /api/documents/source-collection/5/from-storage/', {
      status: 201,
      body: {
        message: 'Successfully imported 1 file(s), skipped 1',
        documents: [{ document_id: 31, file_name: 'a.pdf' }],
        skipped: [{ storage_file_id: 72, path: 'docs/b.exe', reason: 'unsupported_type' }],
      },
    });
    route('GET /api/source-collections/5/', { status: 200, body: { collection_id: 5, rag_configurations: [{ rag_id: 8, rag_type: 'naive' }] } });
    route('POST /api/process-rag-indexing/', { status: 202, body: { detail: 'accepted' } });

    const { isError, body } = await call('import_documents_from_storage', { collection_id: 5, storage: ['docs/', 71, 71] });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/documents/source-collection/5/from-storage/')[0]?.body).toEqual({ storage_file_ids: [70, 71] });
    expect(body.data.skipped).toEqual([{ storage_file_id: 72, path: 'docs/b.exe', reason: 'unsupported_type' }]);
    expect(body.data.reindexed).toEqual([{ rag_id: 8, rag_type: 'naive' }]);

    const missing = await call('import_documents_from_storage', { collection_id: 5, storage: ['nope.pdf'] });
    expect(missing.body.error).toMatch(/Storage path "nope.pdf" not found/);
  });

  it('estimate_rag_indexing sends the naive RAG config ids, with what-if chunking as unsaved overrides', async () => {
    route('GET /api/source-collections/5/', {
      status: 200,
      body: { collection_id: 5, rag_configurations: [{ rag_id: 8, rag_type: 'naive' }, { rag_id: 9, rag_type: 'graph' }] },
    });
    route('GET /api/naive-rag/8/document-configs/', {
      status: 200,
      body: {
        naive_rag_id: 8,
        total_configs: 2,
        configs: [
          { naive_rag_document_id: 101, document_id: 31, file_name: 'a.pdf', chunk_size: 1000, chunk_overlap: 150 },
          { naive_rag_document_id: 102, document_id: 32, file_name: 'b.md', chunk_size: 1000, chunk_overlap: 150 },
        ],
      },
    });
    const estimate = { rag_type: 'naive', document_count: 1, chunk_count: 12, embedding: { tokens: 4800, exact: true, cost_usd: 0.0001 } };
    route('POST /api/process-rag-indexing/estimate/', { status: 200, body: estimate });

    const all = await call('estimate_rag_indexing', { collection_id: 5 });
    expect(all.isError, JSON.stringify(all.body)).toBe(false);
    expect(requests('POST', '/api/process-rag-indexing/estimate/')[0]?.body).toEqual({
      rag_id: 8,
      rag_type: 'naive',
      document_config_ids: [101, 102],
    });
    expect(all.body.data).toMatchObject({ rag_id: 8, chunking: 'the saved per-document settings', ...estimate });

    const whatIf = await call('estimate_rag_indexing', { collection_id: 5, documents: ['b.md'], chunk_size: 500 });
    expect(requests('POST', '/api/process-rag-indexing/estimate/')[1]?.body).toEqual({
      rag_id: 8,
      rag_type: 'naive',
      document_config_ids: [102],
      document_configs: [{ document_config_id: 102, chunk_size: 500 }],
    });
    expect(whatIf.body.data.chunking).toEqual({ what_if: { chunk_size: 500 } });
  });

  it('estimate_rag_indexing refuses a collection with only a graph RAG', async () => {
    route('GET /api/source-collections/6/', { status: 200, body: { collection_id: 6, rag_configurations: [{ rag_id: 9, rag_type: 'graph' }] } });
    const { body } = await call('estimate_rag_indexing', { collection_id: 6 });
    expect(body.error).toMatch(/only a graph RAG.*naive RAG only/);
    expect(requests('POST', '/api/process-rag-indexing/estimate/')).toHaveLength(0);
  });

  it('list_indexed_chunks finds the document config by file name and pages the stored chunks', async () => {
    route('GET /api/source-collections/5/', { status: 200, body: { collection_id: 5, rag_configurations: [{ rag_id: 8, rag_type: 'naive' }] } });
    route('GET /api/naive-rag/8/document-configs/', {
      status: 200,
      body: {
        naive_rag_id: 8,
        total_configs: 1,
        configs: [{ naive_rag_document_id: 101, document_id: 31, file_name: 'a.pdf', chunk_size: 1000, chunk_overlap: 150, status: 'completed' }],
      },
    });
    route('GET /api/naive-rag-document-chunks/', {
      status: 200,
      body: {
        count: 2,
        results: [
          { chunk_id: 1, text: 'y'.repeat(80), chunk_index: 0, token_count: 20, overlap_start_index: null, overlap_end_index: null, metadata: {}, created_at: 'c' },
          { chunk_id: 2, text: 'short', chunk_index: 1, token_count: 2, overlap_start_index: null, overlap_end_index: null, metadata: { page: 2 }, created_at: 'c' },
        ],
      },
    });

    const { isError, body } = await call('list_indexed_chunks', { collection_id: 5, document: 'a.pdf', limit: 2, text_chars: 50 });

    expect(isError, JSON.stringify(body)).toBe(false);
    const query = requests('GET', '/api/naive-rag-document-chunks/')[0]!.query;
    expect(Object.fromEntries(query)).toEqual({ naive_rag_document_config: '101', limit: '2', offset: '0' });
    expect(body.data.document).toEqual({ document_id: 31, file_name: 'a.pdf', document_config_id: 101, status: 'completed' });
    expect(body.data.chunks).toEqual([
      { chunk_index: 0, token_count: 20, text: `${'y'.repeat(50)}…`, text_length: 80 },
      { chunk_index: 1, token_count: 2, text: 'short', metadata: { page: 2 } },
    ]);
  });
});

describe('KnowledgeApi.listNaiveRagDocumentConfigs', () => {
  const configs = [{ naive_rag_document_id: 1, document_id: 2, file_name: 'a', chunk_size: 10, chunk_overlap: 0 }];
  const clientAnswering = (answer: unknown): ApiClient => ({ get: async () => answer }) as unknown as ApiClient;

  it('reads the backend envelope ({naive_rag_id, total_configs, configs}) and still takes a page or an array', async () => {
    expect(await new KnowledgeApi(clientAnswering({ naive_rag_id: 8, total_configs: 1, configs })).listNaiveRagDocumentConfigs(8)).toEqual(configs);
    expect(await new KnowledgeApi(clientAnswering({ count: 1, results: configs })).listNaiveRagDocumentConfigs(8)).toEqual(configs);
    expect(await new KnowledgeApi(clientAnswering(configs)).listNaiveRagDocumentConfigs(8)).toEqual(configs);
  });
});
