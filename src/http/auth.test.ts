import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { StateStore } from '../state/store.js';
import { EpicStaffClient } from './client.js';
import { AuthService } from './auth.js';
import { OrgService } from './org.js';

const ENV = {
  EPICSTAFF_BASE_URL: 'http://es.test',
  EPICSTAFF_USERNAME: 'dev@example.com',
  EPICSTAFF_PASSWORD: 'secret',
};

type FetchCall = { url: string; method: string; headers: Headers; body?: unknown };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('auth bootstrap + org resolution', () => {
  let stateDir: string;
  let calls: FetchCall[];
  let routes: Map<string, (call: FetchCall) => Response>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'es-mcp-test-'));
    process.env.ES_MCP_STATE_DIR = stateDir;
    calls = [];
    routes = new Map();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const call: FetchCall = {
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const path = new URL(url).pathname;
      const handler = routes.get(`${call.method} ${path}`);
      if (!handler) return jsonResponse(404, { detail: `no route ${call.method} ${path}` });
      return handler(call);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeServices(env: Record<string, string> = ENV) {
    const config = loadConfig(env);
    const store = new StateStore(config.apiUrl, config.email ?? 'api-token');
    const client = new EpicStaffClient(config, store);
    const auth = new AuthService(config, store, client);
    const org = new OrgService(store, client);
    return { config, store, client, auth, org };
  }

  it('first launch: logs in, mints a key with the bearer token, persists it', async () => {
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'jwt-access', refresh: 'jwt-refresh' }));
    routes.set('POST /api/auth/api-key/', (call) => {
      expect(call.headers.get('Authorization')).toBe('Bearer jwt-access');
      expect(call.body).toMatchObject({ scopes: [] });
      return jsonResponse(201, { api_key: 'raw-key-abc', prefix: 'raw-key-', name: 'es-mcp' });
    });

    const { store, auth } = makeServices();
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('raw-key-abc');
    expect(store.get().apiKey).toBe('raw-key-abc');
    expect(store.get().keyPrefix).toBe('raw-key-');
    // login carried no api key header
    const login = calls.find((call) => call.url.includes('auth/login/'))!;
    expect(login.headers.get('X-Api-Key')).toBeNull();
  });

  it('subsequent launch: validates the stored key and skips login', async () => {
    routes.set('GET /api/auth/api-key/validate/', (call) => {
      expect(call.headers.get('X-Api-Key')).toBe('stored-key');
      return jsonResponse(200, { active: true });
    });

    const { store, auth } = makeServices();
    store.update({ apiKey: 'stored-key', keyPrefix: 'stored-k' });
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('stored-key');
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
  });

  it('invalid stored key: re-mints via login', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'jwt2', refresh: 'r2' }));
    routes.set('POST /api/auth/api-key/', () =>
      jsonResponse(201, { api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp' }),
    );

    const { store, auth } = makeServices();
    store.update({ apiKey: 'dead-key', keyPrefix: 'dead-key' });
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('fresh-key');
    expect(store.get().apiKey).toBe('fresh-key');
  });

  it('401 on a business call triggers single re-mint and one retry', async () => {
    let graphCalls = 0;
    routes.set('GET /api/graphs/', (call) => {
      graphCalls += 1;
      if (call.headers.get('X-Api-Key') === 'good-key') {
        return jsonResponse(200, { results: [] });
      }
      return jsonResponse(401, { detail: 'bad key' });
    });
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'jwt3', refresh: 'r3' }));
    routes.set('POST /api/auth/api-key/', () =>
      jsonResponse(201, { api_key: 'good-key', prefix: 'good-key', name: 'es-mcp' }),
    );

    const { store, client } = makeServices();
    store.update({ apiKey: 'stale-key', keyPrefix: 'stale-ke' });

    const result = await client.get<{ results: unknown[] }>('graphs/');
    expect(result.results).toEqual([]);
    expect(graphCalls).toBe(2); // failed once, retried once
  });

  it('EPICSTAFF_API_TOKEN: uses the provided token directly, no login', async () => {
    routes.set('GET /api/auth/api-key/validate/', (call) => {
      expect(call.headers.get('X-Api-Key')).toBe('issued-key-123');
      return jsonResponse(200, { active: true });
    });

    const { store, auth } = makeServices({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: 'issued-key-123',
    });
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('issued-key-123');
    expect(store.get().apiKey).toBe('issued-key-123');
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
  });

  it('rejected EPICSTAFF_API_TOKEN without credentials: clear error, no login attempt', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));

    const { auth } = makeServices({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: 'revoked-key',
    });

    await expect(auth.ensureAuthenticated()).rejects.toThrow(/EPICSTAFF_API_TOKEN was rejected/);
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
  });

  it('rejected EPICSTAFF_API_TOKEN with credentials: falls back to login + mint', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'jwt', refresh: 'r' }));
    routes.set('POST /api/auth/api-key/', () =>
      jsonResponse(201, { api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp' }),
    );

    const { auth } = makeServices({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: 'revoked-key',
      EPICSTAFF_USERNAME: 'dev@example.com',
      EPICSTAFF_PASSWORD: 'secret',
    });

    const key = await auth.ensureAuthenticated();
    expect(key).toBe('fresh-key');
  });

  it('legacy backend (auth/api-key/ missing): falls back to JWT bearer auth', async () => {
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'jwt-access', refresh: 'jwt-refresh' }));
    routes.set('POST /api/auth/api-key/', () => jsonResponse(404, { detail: 'no such route' }));
    routes.set('GET /api/graphs/', (call) => {
      expect(call.headers.get('Authorization')).toBe('Bearer jwt-access');
      expect(call.headers.get('X-Api-Key')).toBeNull();
      return jsonResponse(200, { results: [] });
    });

    const { store, client, auth } = makeServices();
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('jwt-access');
    expect(store.get().apiKey).toBeNull();
    expect(store.get().bearerAccessToken).toBe('jwt-access');
    expect(store.get().bearerRefreshToken).toBe('jwt-refresh');

    await client.get('graphs/');
  });

  it('bearer mode: the next bootstrap refreshes the access token via auth/refresh/', async () => {
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'access-1', refresh: 'refresh-1' }));
    routes.set('POST /api/auth/api-key/', () => jsonResponse(404, { detail: 'no such route' }));
    routes.set('POST /api/auth/refresh/', (call) => {
      expect(call.body).toEqual({ refresh: 'refresh-1' });
      return jsonResponse(200, { access: 'access-2' });
    });

    const { store, auth } = makeServices();
    const first = await auth.ensureAuthenticated();
    expect(first).toBe('access-1');

    const second = await auth.ensureAuthenticated();
    expect(second).toBe('access-2');
    expect(store.get().bearerAccessToken).toBe('access-2');
    // No rotated refresh token in the response — the original is kept.
    expect(store.get().bearerRefreshToken).toBe('refresh-1');
  });

  it('bearer mode: a rejected refresh token falls back to a fresh login', async () => {
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'access-1', refresh: 'refresh-1' }));
    routes.set('POST /api/auth/api-key/', () => jsonResponse(404, { detail: 'no such route' }));
    routes.set('POST /api/auth/refresh/', () => jsonResponse(401, { detail: 'refresh token expired' }));

    const { store, auth } = makeServices();
    await auth.ensureAuthenticated();

    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'access-2', refresh: 'refresh-2' }));
    const second = await auth.ensureAuthenticated();

    expect(second).toBe('access-2');
    expect(store.get().bearerRefreshToken).toBe('refresh-2');
  });

  it('bearer mode: 401 on a business call triggers a refresh and one retry', async () => {
    routes.set('POST /api/auth/refresh/', () => jsonResponse(200, { access: 'fresh-access', refresh: 'refresh-2' }));

    let graphCalls = 0;
    routes.set('GET /api/graphs/', (call) => {
      graphCalls += 1;
      if (call.headers.get('Authorization') === 'Bearer fresh-access') {
        return jsonResponse(200, { results: [] });
      }
      return jsonResponse(401, { detail: 'expired' });
    });

    const { store, client } = makeServices();
    store.update({ bearerAccessToken: 'stale-access', bearerRefreshToken: 'refresh-1' });

    const result = await client.get<{ results: unknown[] }>('graphs/');

    expect(result.results).toEqual([]);
    expect(graphCalls).toBe(2); // failed once with the stale token, retried once with the fresh one
  });

  it('org: auto-selects a single active org and sends the header afterwards', async () => {
    routes.set('GET /api/profile/', () =>
      jsonResponse(200, {
        memberships: [{ organization: { id: 42, name: 'Acme', is_active: true } }],
        active_organization_id: null,
      }),
    );
    routes.set('GET /api/graphs/', (call) => {
      expect(call.headers.get('X-Organization-Id')).toBe('42');
      return jsonResponse(200, { results: [] });
    });

    const { store, client, org } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k' });
    const status = await org.resolve();

    expect(status.activeOrgId).toBe(42);
    expect(status.selectionRequired).toBe(false);
    await client.get('graphs/');
  });

  it('org: multiple orgs require an explicit selection; setActive rejects non-members', async () => {
    routes.set('GET /api/profile/', () =>
      jsonResponse(200, {
        memberships: [
          { organization: { id: 1, name: 'One', is_active: true } },
          { organization: { id: 2, name: 'Two', is_active: true } },
        ],
      }),
    );

    const { store, org } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k' });
    const status = await org.resolve();

    expect(status.activeOrgId).toBeNull();
    expect(status.selectionRequired).toBe(true);
    await expect(org.setActive(99)).rejects.toThrow(/not among your memberships/);
    const chosen = await org.setActive(2);
    expect(chosen.activeOrgId).toBe(2);
    expect(store.get().activeOrgId).toBe(2);
  });

  it('org header is never attached to auth endpoints', async () => {
    routes.set('POST /api/auth/login/', (call) => {
      expect(call.headers.get('X-Organization-Id')).toBeNull();
      return jsonResponse(200, { access: 'a', refresh: 'r' });
    });
    routes.set('POST /api/auth/api-key/', () =>
      jsonResponse(201, { api_key: 'nk', prefix: 'nk', name: 'es-mcp' }),
    );

    const { store, auth } = makeServices();
    store.update({ activeOrgId: 5 });
    await auth.ensureAuthenticated();
  });

  it('validation errors are normalized into field/value/reason issues', async () => {
    routes.set('POST /api/agent-definitions/', () =>
      jsonResponse(400, {
        errors: [{ field: 'llm_config', value: null, reason: 'This field is required.' }],
      }),
    );

    const { store, client } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k' });

    await expect(client.post('agent-definitions/', { body: {} })).rejects.toMatchObject({
      status: 400,
      validationErrors: [{ field: 'llm_config', reason: 'This field is required.' }],
    });
  });
});
