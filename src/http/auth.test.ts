import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The refresh token is sent under both refresh-cookie names: the server reads only its own
 * (`__Host-auth.refresh` over HTTPS, `auth.refresh` over http), which then appears once.
 */
const BOTH_REFRESH_COOKIES = (token: string): string => `__Host-auth.refresh=${token}; auth.refresh=${token}`;

/** Current backends over http: access in the body, refresh only in the HttpOnly `auth.refresh` cookie. */
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
    const org = new OrgService(store, client, auth);
    return { config, store, client, auth, org };
  }

  it('first launch: logs in, finds the org over the session, mints a key bound to it, persists it', async () => {
    const access = jwt('user');
    routes.set('POST /api/auth/login/', (call) => {
      expect(call.body).toMatchObject({ email: 'dev@example.com', remember_me: true });
      return loginResponse(access, 'jwt-refresh');
    });
    routes.set('GET /api/profile/', (call) => {
      // A user API key would see only its own org's membership — the session sees them all.
      expect(call.headers.get('Authorization')).toBe(`Bearer ${access}`);
      expect(call.headers.get('X-Api-Key')).toBeNull();
      return jsonResponse(200, { memberships: [{ organization: { id: 3, name: 'Acme', is_active: true } }] });
    });
    routes.set('POST /api/profile/api-keys/', (call) => {
      expect(call.headers.get('Authorization')).toBe(`Bearer ${access}`);
      expect(call.headers.get('X-Api-Key')).toBeNull();
      expect(call.body).toEqual({ name: expect.stringMatching(/^es-mcp/), org_id: 3 });
      return jsonResponse(201, { id: 1, api_key: 'raw-key-abc', prefix: 'raw-key-', name: 'es-mcp', org_id: 3, expires_at: null });
    });

    const { store, auth } = makeServices();
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('raw-key-abc');
    expect(store.get().activeOrgId).toBe(3);
    expect(store.get().apiKeys).toEqual({ 3: { key: 'raw-key-abc', prefix: 'raw-key-' } });
    expect(store.get().jwtOnly).toBe(false);
    // The JWT session is kept (from the cookie) for JWT-only routes.
    expect(store.get().bearerAccessToken).toBe(access);
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
    store.update({ apiKeys: { 1: { key: 'k', prefix: 'k' } }, activeOrgId: 1, bearerAccessToken: 'jwt', bearerRefreshToken: 'r' });
    await client.get('graphs/');
  });

  it('user session: reuses an unexpired access token without any request', async () => {
    const { store, auth } = makeServices();
    const live = jwt('user', 600);
    store.update({ apiKeys: { 1: { key: 'k', prefix: 'k' } }, activeOrgId: 1, bearerAccessToken: live, bearerRefreshToken: 'r' });
    expect(await auth.accessToken()).toBe(live);
    expect(calls).toHaveLength(0);
  });

  it('user session: refreshes an expired access token through the refresh cookie (no login)', async () => {
    routes.set('POST /api/auth/refresh/', (call) => {
      expect(call.headers.get('Cookie')).toBe(BOTH_REFRESH_COOKIES('refresh-1'));
      return jsonResponse(200, { access: 'access-2' }, 'auth.refresh=refresh-2; HttpOnly; Path=/api/auth/');
    });
    const { store, auth } = makeServices();
    store.update({ apiKeys: { 1: { key: 'k', prefix: 'k' } }, activeOrgId: 1, bearerAccessToken: jwt('user', -60), bearerRefreshToken: 'refresh-1' });

    expect(await auth.accessToken()).toBe('access-2');
    expect(store.get().bearerRefreshToken).toBe('refresh-2'); // rotated cookie adopted
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
  });

  it('user session: over HTTPS reads the __Host- refresh cookie, not the expired legacy one', async () => {
    routes.set('POST /api/auth/login/', () => {
      // An HTTPS server sets the prefixed cookie and expires the legacy name in the same response.
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', '__Host-auth.refresh=refresh-secure; HttpOnly; Secure; Path=/; SameSite=Lax');
      headers.append('Set-Cookie', 'auth.refresh=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/api/auth/');
      return new Response(JSON.stringify({ access: 'access-1' }), { status: 200, headers });
    });
    routes.set('POST /api/auth/refresh/', (call) => {
      expect(call.headers.get('Cookie')).toBe(BOTH_REFRESH_COOKIES('refresh-secure'));
      return jsonResponse(200, { access: 'access-2' }, '__Host-auth.refresh=refresh-rotated; HttpOnly; Secure; Path=/');
    });
    const { store, auth } = makeServices();

    expect(await auth.accessToken()).toBe('access-1');
    expect(store.get().bearerRefreshToken).toBe('refresh-secure');

    store.update({ bearerAccessToken: jwt('user', -60) });
    expect(await auth.accessToken()).toBe('access-2');
    expect(store.get().bearerRefreshToken).toBe('refresh-rotated');
  });

  it('user session: logs in once when there is no refresh token', async () => {
    let logins = 0;
    routes.set('POST /api/auth/login/', () => {
      logins += 1;
      return loginResponse('access-new', 'refresh-new');
    });
    const { store, auth } = makeServices();
    store.update({ apiKeys: { 1: { key: 'k', prefix: 'k' } }, activeOrgId: 1 });

    const [first, second] = await Promise.all([auth.renewAccessToken(), auth.renewAccessToken()]);
    expect(first).toBe('access-new');
    expect(second).toBe('access-new');
    expect(logins).toBe(1); // single-flight
    expect(store.get().bearerRefreshToken).toBe('refresh-new');
    expect(store.get().apiKeys[1]?.key).toBe('k'); // the API key is untouched
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
    store.update({ apiKeys: { 1: { key: 'stored-key', prefix: 'stored-k' } }, activeOrgId: 1 });
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
    store.update({ apiKeys: { 1: { key: 'dead-key', prefix: 'dead-key' } }, activeOrgId: 1 });
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('fresh-key');
    expect(store.get().apiKeys[1]?.key).toBe('fresh-key');
  });

  it('invalid stored key + unexpired stored JWT: mints with the stored session, no login', async () => {
    const live = jwt('user', 600);
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/profile/api-keys/', (call) => {
      expect(call.headers.get('Authorization')).toBe(`Bearer ${live}`);
      return jsonResponse(201, { id: 6, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null });
    });

    const { store, auth } = makeServices();
    store.update({ apiKeys: { 1: { key: 'dead-key', prefix: 'dead-key' } }, activeOrgId: 1, bearerAccessToken: live, bearerRefreshToken: 'refresh-1' });

    expect(await auth.ensureAuthenticated()).toBe('fresh-key');
    expect(calls.some((call) => call.url.includes('auth/login/'))).toBe(false);
    expect(calls.some((call) => call.url.includes('auth/refresh/'))).toBe(false);
    expect(store.get().bearerRefreshToken).toBe('refresh-1');
  });

  it('invalid stored key + expired access: refreshes through the cookie and mints, no login', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(401, { detail: 'invalid' }));
    routes.set('POST /api/auth/refresh/', (call) => {
      expect(call.headers.get('Cookie')).toBe(BOTH_REFRESH_COOKIES('refresh-1'));
      return jsonResponse(200, { access: 'access-2' }, 'auth.refresh=refresh-2; HttpOnly; Path=/api/auth/');
    });
    routes.set('POST /api/profile/api-keys/', (call) => {
      expect(call.headers.get('Authorization')).toBe('Bearer access-2');
      return jsonResponse(201, { id: 7, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null });
    });

    const { store, auth } = makeServices();
    store.update({
      apiKeys: { 1: { key: 'dead-key', prefix: 'dead-key' } },
      activeOrgId: 1,
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
    store.update({ apiKeys: { 1: { key: 'dead-key', prefix: 'dead-key' } }, activeOrgId: 1, bearerAccessToken: revoked, bearerRefreshToken: 'r' });

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
      apiKeys: { 1: { key: 'dead-key', prefix: 'dead-key' } },
      activeOrgId: 1,
      bearerAccessToken: jwt('user', -60),
      bearerRefreshToken: 'stale',
    });

    expect(await auth.ensureAuthenticated()).toBe('fresh-key');
    expect(logins).toBe(1);
  });

  it('repeated bootstraps with a valid stored key mint zero keys (and never log in)', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(200, { active: true }));
    const { store } = makeServices();
    store.update({ apiKeys: { 1: { key: 'stored-key', prefix: 'stored-k' } }, activeOrgId: 1 });

    // Fresh services each time = a fresh server process reading the same state file.
    for (let launch = 0; launch < 5; launch += 1) {
      const { auth } = makeServices();
      expect(await auth.ensureAuthenticated()).toBe('stored-key');
      await Promise.all([auth.ensureAuthenticated(), auth.ensureAuthenticated()]);
    }
    expect(calls.filter((call) => call.url.includes('profile/api-keys/'))).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes('auth/login/'))).toHaveLength(0);
  });

  it('a freshly minted key that the server rejects is not re-minted in a loop — the JWT takes over', async () => {
    let mints = 0;
    routes.set('POST /api/auth/login/', () => loginResponse(jwt('user'), 'r-loop'));
    routes.set('POST /api/profile/api-keys/', () => {
      mints += 1;
      return jsonResponse(201, { id: 10 + mints, api_key: `key-${mints}`, prefix: 'key', name: 'es-mcp', expires_at: null });
    });
    // The server rejects every key (e.g. a proxy strips X-Api-Key); the JWT still works.
    routes.set('GET /api/graphs/', (call) =>
      call.headers.get('Authorization') ? jsonResponse(200, { results: [] }) : jsonResponse(401, { detail: 'bad key' }),
    );

    const { client, store, auth } = makeServices();
    store.update({ activeOrgId: 1 });
    await auth.ensureAuthenticated(); // key-1
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(client.get('graphs/')).resolves.toEqual({ results: [] });
    }
    expect(mints).toBe(1);
  });

  it('when minting fails (key limit reached) tools keep working with the JWT in that org', async () => {
    routes.set('POST /api/auth/login/', () => loginResponse(jwt('user'), 'r-limit'));
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(400, { errors: [{ field: 'org_id', value: 2, reason: 'Active API key limit reached.' }] }),
    );
    routes.set('GET /api/graphs/', (call) => {
      expect(call.headers.get('Authorization')).toMatch(/^Bearer /);
      expect(call.headers.get('X-Organization-Id')).toBe('2');
      return jsonResponse(200, { results: [] });
    });

    const { client, store, auth } = makeServices();
    store.update({ activeOrgId: 2 });
    await expect(auth.ensureAuthenticated()).resolves.toMatch(/\./); // a JWT, not a throw
    await expect(client.get('graphs/')).resolves.toEqual({ results: [] });
    expect(store.get().jwtOnly).toBe(false);
  });

  it('a 404 for a deleted organization is not mistaken for a legacy backend', async () => {
    routes.set('POST /api/auth/login/', () => loginResponse(jwt('user'), 'r-404'));
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(404, { type: 'client_error', errors: [{ code: 'organization_not_found', detail: 'Organization not found.' }] }),
    );

    const { store, auth } = makeServices();
    store.update({ activeOrgId: 9, apiKeys: { 1: { key: 'org1-key', prefix: 'org1-key' } } });
    await auth.ensureAuthenticated();
    expect(store.get().jwtOnly).toBe(false);
    expect(store.get().apiKeys).toHaveProperty('1');
    expect(store.get().activeOrgId).toBeNull(); // the deleted org is no longer selected
  });

  it('a 401 for a credential that was replaced meanwhile does not drop the current key', async () => {
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(200, { org_id: 2 }));
    routes.set('GET /api/graphs/', (call) =>
      call.headers.get('X-Api-Key') === 'key-b' ? jsonResponse(200, { results: [] }) : jsonResponse(401, {}),
    );
    const { client, store } = makeServices();
    store.update({ activeOrgId: 2, apiKeys: { 2: { key: 'key-b', prefix: 'key-b' } } });
    // Simulate the race: the request went out with an older key, the active key is key-b by now.
    const reauth = (client as unknown as { reauthenticate: (sent: string | null) => Promise<string> }).reauthenticate;
    await reauth('stale-key');
    expect(store.get().apiKeys[2]?.key).toBe('key-b');
  });

  it('keeps API keys another MCP process persisted meanwhile', async () => {
    const { store } = makeServices();
    store.update({ apiKeys: { 1: { key: 'k1', prefix: 'k1' } } });
    // A second process (its own StateStore on the same file) mints org 2's key.
    const { store: other } = makeServices();
    other.update({ apiKeys: { ...other.get().apiKeys, 2: { key: 'k2', prefix: 'k2' } } });
    // This process writes something unrelated — org 2's key must survive on disk and be reusable.
    store.update({ activeOrgId: 1 });
    expect(Object.keys(store.get().apiKeys).sort()).toEqual(['1', '2']);
    store.update({ apiKeys: { 2: { key: 'k2', prefix: 'k2' } } }); // this process drops org 1's key
    expect(Object.keys(store.get().apiKeys)).toEqual(['2']);
  });

  it('dropping a stale key never erases the replacement another MCP process stored', async () => {
    const { store: a } = makeServices();
    a.update({ apiKeys: { 1: { key: 'kA', prefix: 'kA' } } });
    const { store: b } = makeServices(); // loads kA too
    b.update({ apiKeys: { 1: { key: 'kB', prefix: 'kB' } } }); // B re-minted after a 401
    a.update({ apiKeys: {} }); // A, still holding kA, drops its rejected key
    expect(makeServices().store.get().apiKeys[1]?.key).toBe('kB');
    a.update({ activeOrgId: 1 }); // an unrelated write from A must not put kA back either
    expect(makeServices().store.get().apiKeys[1]?.key).toBe('kB');
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
      const { client, auth, store } = makeServices();
      store.update({ activeOrgId: 1 });
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
    routes.set('POST /api/auth/login/', () => loginResponse(jwt('user'), 'r3'));
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(201, { id: 3, api_key: 'good-key', prefix: 'good-key', name: 'es-mcp', expires_at: null }),
    );

    const { store, client } = makeServices();
    store.update({ apiKeys: { 1: { key: 'stale-key', prefix: 'stale-ke' } }, activeOrgId: 1 });

    const result = await client.get<{ results: unknown[] }>('graphs/');
    expect(result.results).toEqual([]);
    expect(graphCalls).toBe(2); // failed once, retried once
  });

  it('EPICSTAFF_API_TOKEN: uses the provided token directly, pinned to its organization, no login', async () => {
    routes.set('GET /api/auth/api-key/validate/', (call) => {
      expect(call.headers.get('X-Api-Key')).toBe('issued-key-123');
      return jsonResponse(200, { active: true, org_id: 4 });
    });
    routes.set('GET /api/profile/', (call) => {
      expect(call.headers.get('X-Api-Key')).toBe('issued-key-123'); // no session to read it with
      return jsonResponse(200, { memberships: [{ organization: { id: 4, name: 'Four', is_active: true } }] });
    });

    const { store, auth, org } = makeServices({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: 'issued-key-123',
    });
    store.update({ activeOrgId: 5 }); // a selection an earlier configuration left behind
    const key = await auth.ensureAuthenticated();

    expect(key).toBe('issued-key-123');
    expect(store.get().activeOrgId).toBe(4);
    expect(store.get().apiKeys[4]?.key).toBe('issued-key-123');
    await expect(org.setActive(5)).rejects.toThrow(/EPICSTAFF_API_TOKEN belongs to organization 4 and works only there/);
    expect((await org.setActive(4)).activeOrgId).toBe(4);
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
    routes.set('POST /api/auth/login/', () => loginResponse(jwt('user'), 'r'));
    routes.set('POST /api/profile/api-keys/', () =>
      jsonResponse(201, { id: 4, api_key: 'fresh-key', prefix: 'fresh-ke', name: 'es-mcp', expires_at: null }),
    );

    const { auth, store } = makeServices({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: 'revoked-key',
      EPICSTAFF_USERNAME: 'dev@example.com',
      EPICSTAFF_PASSWORD: 'secret',
    });
    store.update({ activeOrgId: 1 });

    const key = await auth.ensureAuthenticated();
    expect(key).toBe('fresh-key');
  });

  it('legacy backend (profile/api-keys/ missing): falls back to JWT bearer auth', async () => {
    // Legacy backends return the refresh token in the body, not a cookie.
    const access = jwt('user');
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access, refresh: 'jwt-refresh' }));
    routes.set('GET /api/graphs/', (call) => {
      expect(call.headers.get('Authorization')).toBe(`Bearer ${access}`);
      expect(call.headers.get('X-Api-Key')).toBeNull();
      return jsonResponse(200, { results: [] });
    });

    const { store, client, auth } = makeServices();
    store.update({ activeOrgId: 1 });
    const key = await auth.ensureAuthenticated();

    expect(key).toBe(access);
    expect(store.get().apiKeys).toEqual({});
    expect(store.get().bearerAccessToken).toBe(access);
    expect(store.get().bearerRefreshToken).toBe('jwt-refresh');
    expect(store.get().jwtOnly).toBe(true);

    await client.get('graphs/');
  });

  it('bearer mode: the next bootstrap refreshes the access token via auth/refresh/', async () => {
    const access1 = jwt('user');
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: access1, refresh: 'refresh-1' }));
    routes.set('POST /api/auth/refresh/', (call) => {
      // Sent both ways: body for legacy backends, cookie for current ones.
      expect(call.body).toEqual({ refresh: 'refresh-1' });
      expect(call.headers.get('Cookie')).toBe(BOTH_REFRESH_COOKIES('refresh-1'));
      return jsonResponse(200, { access: 'access-2' });
    });

    const { store, auth } = makeServices();
    store.update({ activeOrgId: 1 });
    const first = await auth.ensureAuthenticated();
    expect(first).toBe(access1);

    const second = await auth.ensureAuthenticated();
    expect(second).toBe('access-2');
    expect(store.get().bearerAccessToken).toBe('access-2');
    // No rotated refresh token in the response — the original is kept.
    expect(store.get().bearerRefreshToken).toBe('refresh-1');
  });

  it('bearer mode: a rejected refresh token falls back to a fresh login', async () => {
    routes.set('POST /api/auth/login/', () => jsonResponse(200, { access: jwt('user'), refresh: 'refresh-1' }));
    routes.set('POST /api/auth/refresh/', () => jsonResponse(401, { detail: 'refresh token expired' }));

    const { store, auth } = makeServices();
    store.update({ activeOrgId: 1 });
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
    // Unexpired by its `exp`, but revoked on the server.
    store.update({ bearerAccessToken: jwt('revoked'), bearerRefreshToken: 'refresh-1', jwtOnly: true });

    const result = await client.get<{ results: unknown[] }>('graphs/');

    expect(result.results).toEqual([]);
    expect(graphCalls).toBe(2); // failed once with the stale token, retried once with the fresh one
  });

  it('org: auto-selects a single active org and sends the header afterwards', async () => {
    routes.set('GET /api/profile/', (call) => {
      expect(call.headers.get('Authorization')).toBe(`Bearer ${session}`);
      return jsonResponse(200, {
        memberships: [{ organization: { id: 42, name: 'Acme', is_active: true } }],
        active_organization_id: null,
      });
    });
    routes.set('GET /api/graphs/', (call) => {
      expect(call.headers.get('X-Organization-Id')).toBe('42');
      return jsonResponse(200, { results: [] });
    });

    const session = jwt('user');
    const { store, client, org } = makeServices();
    store.update({ bearerAccessToken: session });
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

    const { store, org, auth } = makeServices();
    store.update({ bearerAccessToken: jwt('user') });
    const status = await org.resolve();

    expect(status.activeOrgId).toBeNull();
    expect(status.selectionRequired).toBe(true);
    // No org chosen: nothing can be minted yet — the session carries the requests.
    expect(await auth.ensureAuthenticated()).toBe(store.get().bearerAccessToken);
    expect(calls.some((call) => call.url.includes('profile/api-keys/'))).toBe(false);
    await expect(org.setActive(99)).rejects.toThrow(/not among your memberships/);
    const chosen = await org.setActive(2);
    expect(chosen.activeOrgId).toBe(2);
    expect(store.get().activeOrgId).toBe(2);
  });

  it('org: switching organizations uses that org\'s key, minting it once on first use', async () => {
    routes.set('GET /api/profile/', () =>
      jsonResponse(200, {
        memberships: [
          { organization: { id: 1, name: 'One', is_active: true } },
          { organization: { id: 2, name: 'Two', is_active: true } },
        ],
      }),
    );
    routes.set('GET /api/auth/api-key/validate/', () => jsonResponse(200, { active: true }));
    const minted: unknown[] = [];
    routes.set('POST /api/profile/api-keys/', (call) => {
      minted.push(call.body);
      return jsonResponse(201, { id: 9, api_key: 'key-two', prefix: 'key-two', name: 'es-mcp', org_id: 2, expires_at: null });
    });
    const sent: Array<string | null> = [];
    routes.set('GET /api/graphs/', (call) => {
      sent.push(`${call.headers.get('X-Organization-Id')}:${call.headers.get('X-Api-Key')}`);
      return jsonResponse(200, { results: [] });
    });

    const { store, client, auth, org } = makeServices();
    store.update({ apiKeys: { 1: { key: 'key-one', prefix: 'key-one' } }, bearerAccessToken: jwt('user'), activeOrgId: 1 });
    expect(await auth.ensureAuthenticated()).toBe('key-one');
    await client.get('graphs/');
    await org.setActive(2);
    expect(await auth.ensureAuthenticated()).toBe('key-two');
    await client.get('graphs/');
    await org.setActive(1);
    expect(await auth.ensureAuthenticated()).toBe('key-one');
    await client.get('graphs/');

    expect(sent).toEqual(['1:key-one', '2:key-two', '1:key-one']);
    expect(minted).toEqual([{ name: expect.stringMatching(/^es-mcp/), org_id: 2 }]);
    expect(Object.keys(store.get().apiKeys).sort()).toEqual(['1', '2']);
  });

  it('state: a state file of an older version (one unbound apiKey) loads without it', async () => {
    const { store } = makeServices();
    store.update({ activeOrgId: 3 });
    const file = join(stateDir, readdirSync(stateDir)[0]!);
    const { apiKeys: _apiKeys, ...legacy } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...legacy, apiKey: 'old-key', keyPrefix: 'old-key' }));

    const reloaded = makeServices().store.get();
    expect(reloaded.apiKeys).toEqual({});
    expect(reloaded.activeOrgId).toBe(3);
    expect(reloaded).not.toHaveProperty('apiKey');
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
    store.update({ bearerAccessToken: jwt('user'), activeOrgId: null });
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
    store.update({ apiKeys: { 99: { key: 'k', prefix: 'k' } }, bearerAccessToken: jwt('user'), activeOrgId: 99 });
    await client.get('graphs/');
    expect(store.get().activeOrgId).toBeNull();
  });

  it('org header is never attached to auth endpoints', async () => {
    routes.set('POST /api/auth/login/', (call) => {
      expect(call.headers.get('X-Organization-Id')).toBeNull();
      return loginResponse(jwt('user'), 'r');
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
    store.update({ apiKeys: { 1: { key: 'k', prefix: 'k' } }, bearerAccessToken: jwt('user'), activeOrgId: 1 });

    await expect(client.post('agent-definitions/', { body: {} })).rejects.toMatchObject({
      status: 400,
      validationErrors: [{ field: 'llm_config', reason: 'This field is required.' }],
    });
  });
});
