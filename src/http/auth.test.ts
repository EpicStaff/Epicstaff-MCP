import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { StateStore } from '../state/store.js';
import { EpicStaffClient } from './client.js';
import { AuthService, MIN_REMINT_INTERVAL_MS } from './auth.js';
import { OrgService } from './org.js';

const ENV = {
  EPICSTAFF_BASE_URL: 'http://es.test',
  EPICSTAFF_USERNAME: 'dev@example.com',
  EPICSTAFF_PASSWORD: 'secret',
};

type FetchCall = { url: string; method: string; headers: Headers; body?: unknown };

function jsonResponse(status: number, body: unknown, setCookie?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (setCookie !== undefined) headers.append('Set-Cookie', setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Current backends: access in the body, refresh only in the HttpOnly `auth.refresh` cookie. */
function loginResponse(access: string, refresh: string): Response {
  return jsonResponse(200, { access }, `auth.refresh=${refresh}; HttpOnly; Path=/api/auth/; SameSite=Lax`);
}

/** A syntactically valid JWT whose `exp` is `secondsFromNow` away. */
function jwt(subject: string, secondsFromNow = 3600): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ sub: subject, exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.sig`;
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

  it('first launch: logs in, mints a key via profile/api-keys/ with the bearer token, persists it', async () => {
    routes.set('POST /api/auth/login/', (call) => {
      expect(call.body).toMatchObject({ email: 'dev@example.com', remember_me: true });
      return loginResponse('jwt-access', 'jwt-refresh');
    });
    routes.set('POST /api/profile/api-keys/', (call) => {
      expect(call.headers.get('Authorization')).toBe('Bearer jwt-access');
      expect(call.headers.get('X-Api-Key')).toBeNull();
      expect(Object.keys(call.body as object)).toEqual(['name']);
      return jsonResponse(201, { id: 1, api_key: 'raw-key-abc', prefix: 'raw-key-', name: 'es-mcp', expires_at: null });
    });

    const { store, auth } = makeServices();
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('raw-key-abc');
    expect(store.get().apiKey).toBe('raw-key-abc');
    expect(store.get().keyPrefix).toBe('raw-key-');
    expect(store.get().jwtOnly).toBe(false);
    // The JWT session is kept (from the cookie) for JWT-only routes.
    expect(store.get().bearerAccessToken).toBe('jwt-access');
    expect(store.get().bearerRefreshToken).toBe('jwt-refresh');
    // login carried no api key header
    const login = calls.find((call) => call.url.includes('auth/login/'))!;
    expect(login.headers.get('X-Api-Key')).toBeNull();
  });

  it('API-key mode never sends the kept JWT on business calls', async () => {
    routes.set('GET /api/graphs/', (call) => {
      expect(call.headers.get('X-Api-Key')).toBe('k');
      expect(call.headers.get('Authorization')).toBeNull();
      return jsonResponse(200, { results: [] });
    });
    const { store, client } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k', bearerAccessToken: 'jwt', bearerRefreshToken: 'r' });
    await client.get('graphs/');
  });

  it('user session: reuses an unexpired access token without any request', async () => {
    const { store, auth } = makeServices();
    const live = jwt('user', 600);
    store.update({ apiKey: 'k', keyPrefix: 'k', bearerAccessToken: live, bearerRefreshToken: 'r' });
    expect(await auth.accessToken()).toBe(live);
    expect(calls).toHaveLength(0);
  });

  it('user session: refreshes an expired access token through the refresh cookie (no login)', async () => {
    routes.set('POST /api/auth/refresh/', (call) => {
      expect(call.headers.get('Cookie')).toBe('auth.refresh=refresh-1');
      return jsonResponse(200, { access: 'access-2' }, 'auth.refresh=refresh-2; HttpOnly; Path=/api/auth/');
    });
    const { store, auth } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k', bearerAccessToken: jwt('user', -60), bearerRefreshToken: 'refresh-1' });

    expect(await auth.accessToken()).toBe('access-2');
    expect(store.get().bearerRefreshToken).toBe('refresh-2'); // rotated cookie adopted
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
  });

  it('user session: logs in once when there is no refresh token', async () => {
    let logins = 0;
    routes.set('POST /api/auth/login/', () => {
      logins += 1;
      return loginResponse('access-new', 'refresh-new');
    });
    const { store, auth } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k' });

    const [first, second] = await Promise.all([auth.renewAccessToken(), auth.renewAccessToken()]);
    expect(first).toBe('access-new');
    expect(second).toBe('access-new');
    expect(logins).toBe(1); // single-flight
    expect(store.get().bearerRefreshToken).toBe('refresh-new');
    expect(store.get().apiKey).toBe('k'); // the API key is untouched
  });

  it('user session without credentials: explains that a user login is required', async () => {
    const { auth } = makeServices({ EPICSTAFF_BASE_URL: 'http://es.test', EPICSTAFF_API_TOKEN: 'issued-key-123' });
    await expect(auth.accessToken()).rejects.toThrow(/EPICSTAFF_USERNAME \+ EPICSTAFF_PASSWORD/);
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
    routes.set('POST /api/auth/login/', () => loginResponse('jwt2', 'r2'));
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(201, { id: 2, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null }),
    );

    const { store, auth } = makeServices();
    store.update({ apiKey: 'dead-key', keyPrefix: 'dead-key' });
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('fresh-key');
    expect(store.get().apiKey).toBe('fresh-key');
  });

  it('invalid stored key + unexpired stored JWT: mints with the stored session, no login', async () => {
    const live = jwt('user', 600);
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/profile/api-keys/', (call) => {
      expect(call.headers.get('Authorization')).toBe(`Bearer ${live}`);
      return jsonResponse(201, { id: 6, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null });
    });

    const { store, auth } = makeServices();
    store.update({ apiKey: 'dead-key', keyPrefix: 'dead-key', bearerAccessToken: live, bearerRefreshToken: 'refresh-1' });

    expect(await auth.ensureAuthenticated()).toBe('fresh-key');
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
    expect(calls.some((call) => call.url.includes('auth/refresh/'))).toBe(false);
    expect(store.get().bearerRefreshToken).toBe('refresh-1');
  });

  it('invalid stored key + expired access: refreshes through the cookie and mints, no login', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/auth/refresh/', (call) => {
      expect(call.headers.get('Cookie')).toBe('auth.refresh=refresh-1');
      return jsonResponse(200, { access: 'access-2' }, 'auth.refresh=refresh-2; HttpOnly; Path=/api/auth/');
    });
    routes.set('POST /api/profile/api-keys/', (call) => {
      expect(call.headers.get('Authorization')).toBe('Bearer access-2');
      return jsonResponse(201, { id: 7, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null });
    });

    const { store, auth } = makeServices();
    store.update({
      apiKey: 'dead-key',
      keyPrefix: 'dead-key',
      bearerAccessToken: jwt('user', -60),
      bearerRefreshToken: 'refresh-1',
    });

    expect(await auth.ensureAuthenticated()).toBe('fresh-key');
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
    expect(store.get().bearerRefreshToken).toBe('refresh-2');
  });

  it('invalid stored key + revoked access token: renews via the cookie, then mints — still no login', async () => {
    const revoked = jwt('user', 600);
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/auth/refresh/', () => jsonResponse(200, { access: 'access-2' }));
    routes.set('POST /api/profile/api-keys/', (call) =>
      call.headers.get('Authorization') === 'Bearer access-2'
        ? jsonResponse(201, { id: 8, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null })
        : jsonResponse(401, { detail: 'token revoked' }),
    );

    const { store, auth } = makeServices();
    store.update({ apiKey: 'dead-key', keyPrefix: 'dead-key', bearerAccessToken: revoked, bearerRefreshToken: 'r' });

    expect(await auth.ensureAuthenticated()).toBe('fresh-key');
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
  });

  it('invalid stored key + dead session: logs in exactly once as the last resort', async () => {
    let logins = 0;
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/auth/refresh/', () => jsonResponse(401, { detail: 'expired' }));
    routes.set('POST /api/auth/login/', () => {
      logins += 1;
      return loginResponse('access-3', 'refresh-3');
    });
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(201, { id: 9, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null }),
    );

    const { store, auth } = makeServices();
    store.update({
      apiKey: 'dead-key',
      keyPrefix: 'dead-key',
      bearerAccessToken: jwt('user', -60),
      bearerRefreshToken: 'stale',
    });

    expect(await auth.ensureAuthenticated()).toBe('fresh-key');
    expect(logins).toBe(1);
  });

  it('repeated bootstraps with a valid stored key mint zero keys (and never log in)', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(200, { active: true }));
    const { store } = makeServices();
    store.update({ apiKey: 'stored-key', keyPrefix: 'stored-k' });

    // Fresh services each time = a fresh server process reading the same state file.
    for (let launch = 0; launch < 5; launch += 1) {
      const { auth } = makeServices();
      expect(await auth.ensureAuthenticated()).toBe('stored-key');
      await Promise.all([auth.ensureAuthenticated(), auth.ensureAuthenticated()]);
    }
    expect(calls.filter((call) => call.url.includes('profile/api-keys/'))).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes('auth/login/'))).toHaveLength(0);
  });

  it('a freshly minted key that the server rejects is not re-minted in a loop', async () => {
    let mints = 0;
    routes.set('POST /api/auth/login/', () => loginResponse('jwt-loop', 'r-loop'));
    routes.set('POST /api/profile/api-keys/', () => {
      mints += 1;
      return jsonResponse(201, { id: 10 + mints, api_key: `key-${mints}`, prefix: 'key', name: 'es-mcp', expires_at: null });
    });
    // The server rejects every key (e.g. a proxy strips X-Api-Key).
    routes.set('GET /api/graphs/', () => jsonResponse(401, { detail: 'bad key' }));

    const { client } = makeServices();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(client.get('graphs/')).rejects.toThrow();
    }
    expect(mints).toBe(1);
    await expect(client.get('graphs/')).rejects.toThrow(/not minting another one/);
  });

  it('re-mints normally when the previous mint is older than the loop window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let mints = 0;
      routes.set('POST /api/auth/login/', () => loginResponse(jwt('user', 7200), 'r'));
      routes.set('POST /api/profile/api-keys/', () => {
        mints += 1;
        return jsonResponse(201, { id: 20 + mints, api_key: `key-${mints}`, prefix: 'key', name: 'es-mcp', expires_at: null });
      });
      routes.set('GET /api/graphs/', (call) =>
        call.headers.get('X-Api-Key') === 'key-2' ? jsonResponse(200, { results: [] }) : jsonResponse(401, {}),
      );
      const { client, auth } = makeServices();
      await auth.ensureAuthenticated(); // key-1
      vi.setSystemTime(Date.now() + MIN_REMINT_INTERVAL_MS + 1000); // key-1 later expires
      await expect(client.get('graphs/')).resolves.toEqual({ results: [] });
      expect(mints).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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
    routes.set('POST /api/auth/login/', () => loginResponse('jwt3', 'r3'));
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(201, { id: 3, api_key: 'good-key', prefix: 'good-key', name: 'es-mcp', expires_at: null }),
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
    routes.set('POST /api/auth/login/', () => loginResponse('jwt', 'r'));
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(201, { id: 4, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null }),
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

  it('legacy backend (profile/api-keys/ missing): falls back to JWT bearer auth', async () => {
    // Legacy backends return the refresh token in the body, not a cookie.
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'jwt-access', refresh: 'jwt-refresh' }));
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
    expect(store.get().jwtOnly).toBe(true);

    await client.get('graphs/');
  });

  it('bearer mode: the next bootstrap refreshes the access token via auth/refresh/', async () => {
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: 'access-1', refresh: 'refresh-1' }));
    routes.set('POST /api/auth/refresh/', (call) => {
      // Sent both ways: body for legacy backends, cookie for current ones.
      expect(call.body).toEqual({ refresh: 'refresh-1' });
      expect(call.headers.get('Cookie')).toBe('auth.refresh=refresh-1');
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
    store.update({ bearerAccessToken: 'stale-access', bearerRefreshToken: 'refresh-1', jwtOnly: true });

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

  it('org: a fresh process resolves the persisted org before its first org-scoped call', async () => {
    let profileCalls = 0;
    routes.set('GET /api/profile/', () => {
      profileCalls += 1;
      return jsonResponse(200, { memberships: [{ organization: { id: 7, name: 'Acme', is_active: true } }] });
    });
    const seen: Array<string | null> = [];
    routes.set('GET /api/sessions/3/', (call) => {
      seen.push(call.headers.get('X-Organization-Id'));
      return jsonResponse(200, { id: 3 });
    });

    // No check_connection / org.resolve() call — just a tool hitting an org-scoped route.
    const { store, client } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k', activeOrgId: null });
    await Promise.all([client.get('sessions/3/'), client.get('sessions/3/')]);
    await client.get('sessions/3/');

    expect(seen).toEqual(['7', '7', '7']);
    expect(profileCalls).toBe(1); // once per process, single-flight
    expect(store.get().activeOrgId).toBe(7);
  });

  it('org: a persisted org that is no longer a membership is dropped before it is sent', async () => {
    routes.set('GET /api/profile/', () =>
      jsonResponse(200, {
        memberships: [
          { organization: { id: 1, name: 'One', is_active: true } },
          { organization: { id: 2, name: 'Two', is_active: true } },
        ],
      }),
    );
    routes.set('GET /api/graphs/', (call) => {
      expect(call.headers.get('X-Organization-Id')).toBeNull();
      return jsonResponse(200, { results: [] });
    });
    const { store, client } = makeServices();
    store.update({ apiKey: 'k', keyPrefix: 'k', activeOrgId: 99 });
    await client.get('graphs/');
    expect(store.get().activeOrgId).toBeNull();
  });

  it('org header is never attached to auth endpoints', async () => {
    routes.set('POST /api/auth/login/', (call) => {
      expect(call.headers.get('X-Organization-Id')).toBeNull();
      return loginResponse('a', 'r');
    });
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(201, { id: 5, api_key: 'nk', prefix: 'nk', name: 'es-mcp', expires_at: null }),
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
