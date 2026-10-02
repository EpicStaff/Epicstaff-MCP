import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/**
 * Issue: a fresh server process sent no X-Organization-Id (and entity tools refused with
 * "No active organization selected") until check_connection ran. Tools now resolve the org
 * lazily — the saved selection validated against the profile, or the single membership.
 */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw' };
const FIXTURE = join(import.meta.dirname, 'fixtures/flow-source/valid-basic');

describe('org context in a fresh server process', () => {
  let scratchDir: string;
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  let orgHeaders: Array<{ path: string; org: string | null }>;

  async function start(activeOrgId: number | null) {
    const context = createContext(loadConfig(ENV));
    context.store.update({ apiKey: 'stored-key', keyPrefix: 'stored-k', activeOrgId });
    ({ client, call } = await connectTools(context));
  }

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'es-mcp-org-'));
    process.env.ES_MCP_STATE_DIR = scratchDir;
    orgHeaders = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      orgHeaders.push({ path: url.pathname, org: new Headers(init?.headers).get('X-Organization-Id') });
      const reply = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
      if (url.pathname === '/api/auth/api-key/validate/') return reply({ active: true });
      if (url.pathname === '/api/profile/') return reply({ memberships: [{ organization: { id: 9, name: 'Only org', is_active: true } }] });
      if (url.pathname === '/api/graphs/77/') return reply({ id: 77, name: 'someone-elses-flow', save_version: 3 });
      if (url.pathname === '/api/sessions/5/') {
        return new Headers(init?.headers).get('X-Organization-Id') === '9'
          ? reply({ id: 5, status: 'end' })
          : reply({ status_code: 400, code: 'org_context_required' }, 400);
      }
      return reply({ detail: 'no mock' }, 404);
    });
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('get_session works without check_connection (persisted org is validated and sent)', async () => {
    await start(9);
    const { isError, body } = await call('get_session', { session_id: 5 });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(orgHeaders.find((entry) => entry.path === '/api/sessions/5/')?.org).toBe('9');
  });

  it('an entity tool (diff_flow) auto-selects the single org instead of refusing', async () => {
    await start(null);
    const flowDir = join(scratchDir, 'flow');
    cpSync(FIXTURE, flowDir, { recursive: true });
    const { isError, body } = await call('diff_flow', { flow_dir: flowDir });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body.data.graph.wouldDo).toMatch(/create graph/);
  });

  it('diff_flow reports a locked graph that no longer exists instead of a bare 404', async () => {
    await start(9);
    const flowDir = join(scratchDir, 'flow-stale');
    cpSync(FIXTURE, flowDir, { recursive: true });
    writeFileSync(
      join(flowDir, 'flow.lock.json'),
      JSON.stringify({ flowName: 'research-and-write', graphId: 4242, saveVersion: 3, entities: {}, documents: {} }),
    );
    const { isError, body } = await call('diff_flow', { flow_dir: flowDir });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body.data.graph).toMatchObject({ graphId: 4242, wouldDo: 'recreate graph + all nodes/edges' });
    expect(body.data.graph.warning).toMatch(/no longer exists/);
  });

  it('diff_flow flags a locked graph that belongs to another flow', async () => {
    await start(9);
    const flowDir = join(scratchDir, 'flow-foreign');
    cpSync(FIXTURE, flowDir, { recursive: true });
    writeFileSync(
      join(flowDir, 'flow.lock.json'),
      JSON.stringify({ flowName: 'research-and-write', graphId: 77, saveVersion: 3, entities: {}, documents: {} }),
    );
    const { body } = await call('diff_flow', { flow_dir: flowDir });
    expect(body.data.graph.wouldDo).toMatch(/refuse/);
    expect(body.data.graph.conflict).toMatch(/"someone-elses-flow", but this flow source is named "research-and-write"/);
  });

  it('a 400 org_context_required carries an actionable hint', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/auth/api-key/validate/') return new Response('{"active":true}', { status: 200 });
      if (path === '/api/profile/') {
        return new Response(
          JSON.stringify({ memberships: [{ organization: { id: 1, name: 'A' } }, { organization: { id: 2, name: 'B' } }] }),
          { status: 200 },
        );
      }
      return new Response('{"status_code":400,"code":"org_context_required"}', { status: 400 });
    });
    await start(null);
    const { body } = await call('get_session', { session_id: 5 });
    expect(body.hint).toMatch(/set_active_organization/);
  });
});
