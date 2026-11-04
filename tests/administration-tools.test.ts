import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { type AppContext, createContext } from '../src/context.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/**
 * The administration tools (account, first setup, users / memberships / roles / API keys /
 * organizations, plugins, audit) over the real MCP path — Zod parsing included — against an
 * in-process mock backend that records every request. The focus: which credential each call carries
 * (API key for admin reads, the user session for every change), confirm guards, org-scoping errors,
 * and that no credential (password, API key, audit token) ever reaches a tool result or the log.
 */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw-of-the-mcp' };
const encodeSegment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const MOCK_JWT = `${encodeSegment({ alg: 'HS256' })}.${encodeSegment({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const STORED_KEY = 'es-storedkey-0123456789abcdef';
const MINTED_KEY = 'es-mintedkey-SECRET-VALUE-0123456789';
const AUDIT_TOKEN = 'audit.jwt.SECRET-TOKEN';

interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = (request: Received) => Reply | Promise<Reply>;

const role = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: null,
  is_built_in: false,
  scope: 'org',
  org_id: 1,
  org: { id: 1, name: 'Org' },
  assigned_count: 0,
  permissions: [],
  ...extra,
});
const builtIn = (id: number, name: string) => role(id, name, { is_built_in: true, org_id: null, org: null });
const page = <T>(results: T[], next: string | null = null) => ({ count: results.length, next, previous: null, results });
const membership = (id: number, userId: number, email: string, roleName = 'Member') => ({
  id,
  org: { id: 1, name: 'Org' },
  user: { id: userId, email, display_name: null, avatar_url: null, is_active: true },
  role: { id: 3, name: roleName },
  joined_at: '2026-10-01T00:00:00Z',
});
const adminUser = (id: number, email: string) => ({
  id,
  email,
  display_name: null,
  avatar_url: null,
  is_superadmin: false,
  is_active: true,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  memberships: [],
});
const apiKey = (id: number, prefix: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `key ${id}`,
  prefix,
  created_at: '2026-10-01T00:00:00Z',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  status: 'active',
  ...extra,
});
const preset = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  filter_body: { query: 'status = "failed"', ui_state: { version: 1, state: {} } },
  is_owner: true,
  is_shared: false,
  created_by_name: 'Dev',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...extra,
});

describe('administration tools (mock backend)', () => {
  let stateDir: string;
  let scratchDir: string;
  let client: Client;
  let context: AppContext;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  let received: Received[];
  let routes: Map<string, Route>;
  let logged: string[];

  const route = (key: string, handler: Route | Reply): void => {
    routes.set(key, typeof handler === 'function' ? handler : () => handler);
  };
  const requests = (method: string, path: string): Received[] =>
    received.filter((request) => request.method === method && request.path === path);
  const writes = (): Received[] => received.filter((request) => request.method !== 'GET' && !request.path.startsWith('/api/auth/'));

  async function connect(env: Record<string, string>, state: Record<string, unknown>): Promise<void> {
    context = createContext(loadConfig(env));
    context.store.update(state);
    ({ client, call } = await connectTools(context));
  }

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'es-mcp-admin-'));
    scratchDir = mkdtempSync(join(tmpdir(), 'es-mcp-admin-files-'));
    process.env.ES_MCP_STATE_DIR = stateDir;
    received = [];
    routes = new Map();
    logged = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    route('GET /api/auth/api-key/validate/', { status: 200, body: { active: true } });
    route('GET /api/profile/', {
      status: 200,
      body: {
        id: 7,
        email: 'dev@example.com',
        display_name: 'Dev',
        is_superadmin: false,
        is_active: true,
        memberships: [{ id: 1, organization: { id: 1, name: 'Org', is_active: true }, role: { id: 2, name: 'Org Admin' }, joined_at: 'x' }],
        active_organization_id: 1,
        active_permissions: { roles: ['read'] },
      },
    });
    route('POST /api/auth/login/', { status: 200, body: { access: MOCK_JWT }, headers: { 'Set-Cookie': 'auth.refresh=r; Path=/api/auth/' } });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const raw = init?.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const request: Received = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, body, headers: new Headers(init?.headers) };
      received.push(request);
      const handler = routes.get(`${request.method} ${request.path}`);
      const reply = handler ? await handler(request) : { status: 404, body: { detail: `no mock for ${request.method} ${request.path}` } };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json', ...reply.headers },
      });
    });

    await connect(ENV, { apiKey: STORED_KEY, keyPrefix: STORED_KEY.slice(0, 12), activeOrgId: 1 });
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  });

  // ----- account ----------------------------------------------------------------

  it('get_my_account combines the profile with the per-organization permissions', async () => {
    route('GET /api/permissions/me/orgs/', {
      status: 200,
      body: { is_superadmin: false, orgs: [{ org: { id: 1, name: 'Org' }, role: { id: 2, name: 'Org Admin' }, permissions: { roles: ['read'] } }] },
    });

    const { isError, body } = await call('get_my_account');

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body.data.user).toMatchObject({ id: 7, email: 'dev@example.com', is_superadmin: false });
    expect(body.data.memberships).toEqual([{ organization: { id: 1, name: 'Org' }, role: 'Org Admin', joined_at: 'x' }]);
    expect(body.data.permissions).toEqual([{ organization: { id: 1, name: 'Org' }, role: 'Org Admin', permissions: { roles: ['read'] } }]);
  });

  it('create_my_api_key writes the key to a new 0600 file and never returns or logs it', async () => {
    route('POST /api/profile/api-keys/', { status: 201, body: { ...apiKey(31, MINTED_KEY.slice(0, 12)), api_key: MINTED_KEY } });
    const output = join(scratchDir, 'app.env');

    const result = await call('create_my_api_key', { name: 'app', output_file: output, env_var_name: 'APP_ES_KEY', expires_in_days: 30, confirm: true });

    expect(result.isError, result.text).toBe(false);
    const mint = requests('POST', '/api/profile/api-keys/')[0]!;
    expect(mint.body).toEqual({ name: 'app', expires_in_days: 30 });
    // JWT-only route: the session bearer, never the API key.
    expect(mint.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
    expect(mint.headers.get('X-Api-Key')).toBeNull();
    expect(readFileSync(output, 'utf8')).toBe(`APP_ES_KEY=${MINTED_KEY}\n`);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(result.text).not.toContain(MINTED_KEY);
    expect(logged.join('')).not.toContain(MINTED_KEY);
    expect(result.body.data.api_key).toMatchObject({ id: 31, prefix: MINTED_KEY.slice(0, 12) });
  });

  it('create_my_api_key refuses an existing file or a symbolic link before minting anything', async () => {
    const existing = join(scratchDir, 'taken.txt');
    writeFileSync(existing, 'keep me');
    const link = join(scratchDir, 'link.txt');
    symlinkSync(existing, link);

    const taken = await call('create_my_api_key', { name: 'app', output_file: existing, confirm: true });
    const linked = await call('create_my_api_key', { name: 'app', output_file: link, confirm: true });
    const relative = await call('create_my_api_key', { name: 'app', output_file: 'key.txt', confirm: true });

    expect(taken.body.error).toMatch(/already exists/);
    expect(linked.body.error).toMatch(/symbolic link/);
    expect(relative.body.error).toMatch(/not an absolute path/);
    expect(requests('POST', '/api/profile/api-keys/')).toHaveLength(0);
    expect(readFileSync(existing, 'utf8')).toBe('keep me');
  });

  it('create_my_api_key requires confirm: true', async () => {
    const result = await call('create_my_api_key', { name: 'app', output_file: join(scratchDir, 'k') });
    expect(result.isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it('revoke_my_api_key refuses the key this server runs on and revokes another by prefix', async () => {
    route('GET /api/profile/api-keys/', { status: 200, body: [apiKey(1, STORED_KEY.slice(0, 12)), apiKey(2, 'es-other0000')] });
    route('POST /api/profile/api-keys/2/revoke/', { status: 200, body: apiKey(2, 'es-other0000', { status: 'revoked', revoked_at: 'now' }) });

    const own = await call('revoke_my_api_key', { key: 1, confirm: true });
    const other = await call('revoke_my_api_key', { key: 'es-other0000', confirm: true });

    expect(own.body.error).toMatch(/this MCP server authenticates with/);
    expect(requests('POST', '/api/profile/api-keys/1/revoke/')).toHaveLength(0);
    expect(other.isError, other.text).toBe(false);
    expect(other.body.data.api_key).toMatchObject({ id: 2, status: 'revoked' });
    expect(other.text).not.toContain(STORED_KEY);
  });

  it('list_my_api_keys marks the key the MCP runs on', async () => {
    route('GET /api/profile/api-keys/', { status: 200, body: [apiKey(1, STORED_KEY.slice(0, 12)), apiKey(2, 'es-other0000')] });

    const { body, text } = await call('list_my_api_keys');

    expect(body.data.keys[0]).toMatchObject({ id: 1, in_use_by_mcp: true });
    expect(body.data.keys[1].in_use_by_mcp).toBeUndefined();
    expect(text).not.toContain(STORED_KEY);
  });

  // ----- RBAC admin ---------------------------------------------------------------

  it('admin reads use the API key; admin writes use the signed-in session', async () => {
    route('GET /api/admin/roles/', { status: 200, body: { ...page([role(9, 'Reviewer')]), built_in_roles: [builtIn(3, 'Member')] } });
    route('POST /api/admin/roles/', (request) => ({ status: 201, body: role(10, (request.body as { name: string }).name, { permissions: (request.body as { permissions: unknown }).permissions }) }));

    const list = await call('admin_list_roles', { organization: 'Org' });
    const create = await call('admin_create_role', {
      organization: 'Org',
      name: 'Auditor',
      permissions: { audit: ['read', 'export'], flows: ['read'] },
      confirm: true,
    });

    expect(list.isError, list.text).toBe(false);
    const read = requests('GET', '/api/admin/roles/')[0]!;
    expect(read.headers.get('X-Api-Key')).toBe(STORED_KEY);
    expect(read.headers.get('Authorization')).toBeNull();
    expect(read.query.get('org_ids')).toBe('1');
    expect(list.body.data.built_in_roles[0]).toMatchObject({ id: 3, name: 'Member', built_in: true });

    expect(create.isError, create.text).toBe(false);
    const write = requests('POST', '/api/admin/roles/')[0]!;
    expect(write.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
    expect(write.headers.get('X-Api-Key')).toBeNull();
    expect(write.body).toEqual({
      org_id: 1,
      name: 'Auditor',
      permissions: [
        { resource_type: 'audit', actions: ['read', 'export'] },
        { resource_type: 'flows', actions: ['read'] },
      ],
    });
    expect(create.body.data.role.permissions).toEqual({ audit: ['read', 'export'], flows: ['read'] });
  });

  it('admin writes refuse an API-token-only server before sending anything', async () => {
    await client.close();
    await connect({ EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_API_TOKEN: STORED_KEY }, { activeOrgId: 1 });

    const result = await call('admin_create_role', { organization: 1, name: 'X', permissions: {}, confirm: true });

    expect(result.body.error).toMatch(/needs a signed-in EpicStaff session/);
    expect(writes()).toHaveLength(0);
  });

  it('admin changes without confirm are rejected by the schema', async () => {
    for (const [name, args] of [
      ['admin_set_user_active', { user: 5, active: false }],
      ['admin_set_user_superadmin', { user: 5, superadmin: true }],
      ['admin_add_membership', { user: 'a@example.com', organization: 1, role: 3 }],
      ['admin_remove_membership', { user: 5, organization: 1 }],
      ['admin_revoke_api_key', { key_id: 4 }],
      ['admin_set_organization_active', { organization: 1, active: false }],
      ['admin_grant_plugin', { plugin: 'weather', organization: 1 }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
    }
    expect(writes()).toHaveLength(0);
  });

  it('admin_delete_role previews with dry_run and refuses the real delete without confirm', async () => {
    route('DELETE /api/admin/roles/9/', (request) =>
      request.query.get('dry_run') === 'true'
        ? { status: 200, body: { role_id: 9, assigned_count: 1, affected_users: [{ user_id: 5, email: 'a@example.com', display_name: null }] } }
        : { status: 200, body: { reassigned_count: 1 } },
    );

    const preview = await call('admin_delete_role', { role: 9, dry_run: true });
    const unconfirmed = await call('admin_delete_role', { role: 9 });
    const deleted = await call('admin_delete_role', { role: 9, confirm: true });

    expect(preview.body.data.preview.affected_users).toHaveLength(1);
    expect(unconfirmed.body.error).toMatch(/without confirm: true/);
    expect(deleted.body.data).toEqual({ deleted_role_id: 9, reassigned_count: 1, reassigned_to: 'Viewer' });
    const deletes = requests('DELETE', '/api/admin/roles/9/');
    expect(deletes.map((request) => request.query.get('dry_run'))).toEqual(['true', null]);
  });

  it('admin_add_membership resolves the role among those assignable in the organization and links by email', async () => {
    route('GET /api/admin/roles/', { status: 200, body: { ...page([]), built_in_roles: [builtIn(2, 'Org Admin'), builtIn(3, 'Member')] } });
    route('POST /api/admin/memberships/', { status: 201, body: membership(40, 5, 'a@example.com') });

    const result = await call('admin_add_membership', { user: 'a@example.com', organization: 'org', role: 'member', confirm: true });

    expect(result.isError, result.text).toBe(false);
    expect(requests('GET', '/api/admin/roles/')[0]!.query.get('assignable_org_ids')).toBe('1');
    expect(requests('POST', '/api/admin/memberships/')[0]!.body).toEqual({ org_id: 1, role_id: 3, email: 'a@example.com' });
  });

  it('admin_remove_membership finds the membership by user id across pages', async () => {
    route('GET /api/admin/memberships/', (request) =>
      request.query.get('page') === '1'
        ? { status: 200, body: page([membership(40, 4, 'b@example.com')], 'next') }
        : { status: 200, body: page([membership(41, 5, 'a@example.com')]) },
    );
    route('DELETE /api/admin/memberships/41/', { status: 204 });

    const result = await call('admin_remove_membership', { user: 5, organization: 1, confirm: true });

    expect(result.isError, result.text).toBe(false);
    expect(result.body.data.removed).toMatchObject({ id: 41, user: { id: 5, email: 'a@example.com' } });
    expect(requests('DELETE', '/api/admin/memberships/41/')[0]!.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
  });

  it('a 404 explains org scoping, a 403 names the missing right', async () => {
    route('GET /api/admin/roles/77/', { status: 404, body: { status_code: 404, code: 'not_found', message: 'Role not found.' } });
    route('GET /api/admin/users/', { status: 403, body: { status_code: 403, code: 'permission_denied', message: 'Superadmin privileges are required for this action.' } });

    const missing = await call('admin_get_role', { role: 77 });
    const forbidden = await call('admin_list_users');

    expect(missing.body.error).toMatch(/belongs to an organization you cannot administer/);
    expect(missing.body.error).toMatch(/404, never 403/);
    expect(forbidden.body.error).toMatch(/refused to list users \(HTTP 403 — permission_denied: Superadmin privileges/);
    expect(forbidden.body.error).toMatch(/It needs superadmin rights/);
  });

  it('admin_list_users filters by account status (the backend ignores is_active)', async () => {
    route('GET /api/admin/users/', { status: 200, body: page([adminUser(5, 'a@example.com')]) });

    await call('admin_list_users', { status: 'inactive', superadmins_only: false });

    const query = requests('GET', '/api/admin/users/')[0]!.query;
    expect(query.get('status')).toBe('inactive');
    expect(query.get('is_superadmin')).toBe('false');
    expect(query.has('is_active')).toBe(false);
  });

  it('admin_create_user writes a generated password to a 0600 file and never returns or logs it', async () => {
    let sentPassword = '';
    route('POST /api/admin/users/', (request) => {
      sentPassword = (request.body as { password: string }).password;
      return { status: 201, body: adminUser(50, 'new@example.com') };
    });
    const passwordFile = join(scratchDir, 'new-user.txt');

    const result = await call('admin_create_user', { email: 'new@example.com', password_file: passwordFile, confirm: true });

    expect(result.isError, result.text).toBe(false);
    expect(sentPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(readFileSync(passwordFile, 'utf8')).toBe(`${sentPassword}\n`);
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
    expect(result.text).not.toContain(sentPassword);
    expect(logged.join('')).not.toContain(sentPassword);
    const write = requests('POST', '/api/admin/users/')[0]!;
    expect(write.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
    expect(write.body).toEqual({ email: 'new@example.com', password: sentPassword });
  });

  it('admin_create_user removes the password file and scrubs an echoed password when creation fails', async () => {
    route('POST /api/admin/users/', (request) => {
      const password = (request.body as { password: string }).password;
      return {
        status: 400,
        body: { status_code: 400, code: 'invalid', message: `bad ${password}`, errors: [{ field: 'password', value: password, reason: `too similar to ${password}` }] },
      };
    });
    const passwordFile = join(scratchDir, 'failed.txt');

    const result = await call('admin_create_user', { email: 'new@example.com', password_file: passwordFile, confirm: true });

    expect(result.isError).toBe(true);
    const sent = (requests('POST', '/api/admin/users/')[0]!.body as { password: string }).password;
    expect(result.text).not.toContain(sent);
    expect(result.text).toContain('[redacted]');
    expect(existsSync(passwordFile)).toBe(false);
  });

  it('admin_set_user_active refuses to deactivate the account the MCP signs in with', async () => {
    const result = await call('admin_set_user_active', { user: 7, active: false, confirm: true });

    expect(result.body.error).toMatch(/account this MCP server signs in with/);
    expect(requests('POST', '/api/admin/users/7/deactivate/')).toHaveLength(0);
  });

  it('admin_revoke_api_key refuses the key this server runs on', async () => {
    route('GET /api/profile/api-keys/', { status: 200, body: [apiKey(1, STORED_KEY.slice(0, 12))] });

    const result = await call('admin_revoke_api_key', { key_id: 1, confirm: true });

    expect(result.body.error).toMatch(/this MCP server authenticates with/);
    expect(requests('POST', '/api/admin/api-keys/1/revoke/')).toHaveLength(0);
  });

  // ----- plugins -----------------------------------------------------------------

  it('list_plugins lists the active organization\'s plugins and reports service accounts it may not read', async () => {
    route('GET /api/plugins/available/', {
      status: 200,
      body: [{ identifier: 'weather', name: 'Weather', description: 'd', icon_url: 'i', frame_origin: 'f', permissions: ['read'], availability: 'ready', development: false, navigation: [] }],
    });
    route('GET /api/plugins/service-accounts/', { status: 403, body: { status_code: 403, code: 'permission_denied', message: 'no' } });

    const { isError, body } = await call('list_plugins', { include_service_accounts: true });

    expect(isError).toBe(false);
    expect(body.data.plugins).toEqual([{ identifier: 'weather', name: 'Weather', description: 'd', availability: 'ready', your_permissions: ['read'] }]);
    expect(body.data.service_accounts).toMatch(/audit: read/);
    expect(requests('GET', '/api/plugins/available/')[0]!.headers.get('X-Organization-Id')).toBe('1');
  });

  it('plugin routes answering 404 point at the plugin platform switch', async () => {
    const result = await call('list_plugins');
    expect(result.body.error).toMatch(/plugin platform is switched off/);
  });

  it('admin_list_plugins shows a plugin without its base64 icons, over the session', async () => {
    route('GET /api/admin/plugins/weather/', {
      status: 200,
      body: {
        identifier: 'weather',
        name: 'Weather',
        description: 'd',
        state: 'running',
        trust: 'trusted',
        current_version: '1.0.0',
        grant_count: 1,
        needs_attention: false,
        pending_package: null,
        upgrade: null,
        purge_after: null,
        allowed_actions: ['uninstall'],
        current_package: {
          version: '1.0.0',
          trust: 'trusted',
          signature: 'valid',
          publisher: { name: 'P', url: null },
          contents: { has_backend: true },
          access: [{ resource_type: 'flows', resource_label: 'Flows', actions: ['read', 'use'], reason: 'runs the forecast' }],
          user_permissions: [],
          outbound_hosts: [],
          public_paths: [],
          settings: [],
          warnings: [],
          icon_data_url: 'data:image/png;base64,AAAA-ICON',
          navigation: [{ label: 'x', path: '/', icon_data_url: 'data:image/png;base64,BBBB-ICON' }],
        },
      },
    });
    route('GET /api/admin/plugins/weather/grants/', {
      status: 200,
      body: page([{ id: 3, plugin_identifier: 'weather', organization: { id: 1, name: 'Org' }, state: 'active', allowed_actions: ['suspend'], granted_by: null, granted_at: 't', suspended_at: null, purge_after: null, last_hook_error: null, owned_resource_count: 2, suspension_cause: null, installed_version: '1.0.0' }]),
    });

    const result = await call('admin_list_plugins', { plugin: 'weather' });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain('ICON');
    expect(result.body.data.plugin.current_package.access).toEqual([{ resource_type: 'flows', actions: ['read', 'use'], reason: 'runs the forecast' }]);
    expect(result.body.data.grants.items[0]).toMatchObject({ id: 3, organization: { id: 1, name: 'Org' }, state: 'active' });
    const detail = requests('GET', '/api/admin/plugins/weather/')[0]!;
    expect(detail.headers.get('Authorization')).toBe(`Bearer ${MOCK_JWT}`);
    expect(detail.headers.get('X-Api-Key')).toBeNull();
  });

  it('admin_uninstall_plugin previews without the purge phrase and needs confirm for the real uninstall', async () => {
    route('GET /api/admin/plugins/weather/purge-preview/', {
      status: 200,
      body: { plugin: { identifier: 'weather', name: 'Weather', state: 'running' }, verification_phrase: 'purge-weather', data_kept_until: '2026-12-01', organizations: { total: 1, items: [] }, owned_resources: [], data_removals_open: 0, has_org_removed_hook: false, database: null, has_backend: true, has_spa: true, package_count: 1 },
    });

    const preview = await call('admin_uninstall_plugin', { plugin: 'weather', dry_run: true });
    const unconfirmed = await call('admin_uninstall_plugin', { plugin: 'weather' });

    expect(preview.body.data.affects.data_kept_until).toBe('2026-12-01');
    expect(preview.text).not.toContain('purge-weather');
    expect(unconfirmed.body.error).toMatch(/without confirm: true/);
    expect(requests('POST', '/api/admin/plugins/weather/uninstall/')).toHaveLength(0);
  });

  // ----- audit -------------------------------------------------------------------

  it('search_audit_log mints the audit token once, sends it only to the auditor, and never returns it', async () => {
    route('POST /api/audit/token/', { status: 200, body: { token: AUDIT_TOKEN, expires_in: 900 } });
    route('POST /auditor/api/audit/sessions/search', {
      status: 200,
      body: { items: [{ id: 'e1', kind: 'event', output: { text: 'x'.repeat(5000) } }], next_cursor: 'c2', partial: false },
    });

    const first = await call('search_audit_log', { query: 'status = "failed"', size: 10 });
    const second = await call('search_audit_log', { cursor: 'c2' });

    expect(first.isError, first.text).toBe(false);
    expect(requests('POST', '/api/audit/token/')).toHaveLength(1);
    const [search] = requests('POST', '/auditor/api/audit/sessions/search');
    expect(search!.headers.get('Authorization')).toBe(`Bearer ${AUDIT_TOKEN}`);
    expect(search!.headers.get('X-Api-Key')).toBeNull();
    expect(search!.body).toEqual({ query: 'status = "failed"', size: 10 });
    expect(first.body.data.next_cursor).toBe('c2');
    expect(first.body.data.items[0].output.text).toMatch(/… \(\+3000 chars\)$/);
    for (const text of [first.text, second.text, logged.join('')]) expect(text).not.toContain(AUDIT_TOKEN);
  });

  it('search_audit_log re-mints once when the auditor rejects the token', async () => {
    let mints = 0;
    route('POST /api/audit/token/', () => ({ status: 200, body: { token: `${AUDIT_TOKEN}-${++mints}`, expires_in: 900 } }));
    route('POST /auditor/api/audit/sessions/search', (request) =>
      request.headers.get('Authorization') === `Bearer ${AUDIT_TOKEN}-1`
        ? { status: 401, body: { detail: 'Invalid or expired token' } }
        : { status: 200, body: { items: [], next_cursor: null, partial: false } },
    );

    const result = await call('search_audit_log', {});

    expect(result.isError, result.text).toBe(false);
    expect(mints).toBe(2);
  });

  it('search_audit_log runs a preset without its frontend-only panel state, and explains a missing audit permission', async () => {
    route('GET /api/audit-filter-presets/', { status: 200, body: page([preset(4, 'Failures')]) });
    route('POST /api/audit/token/', { status: 200, body: { token: AUDIT_TOKEN, expires_in: 900 } });
    route('POST /auditor/api/audit/sessions/search', { status: 200, body: { items: [], next_cursor: null, partial: false } });

    await call('search_audit_log', { preset: 'failures' });
    expect(requests('POST', '/auditor/api/audit/sessions/search')[0]!.body).toEqual({ query: 'status = "failed"', size: 20 });

    // A fresh server process (the first one holds a cached token) whose user lacks AUDIT permission.
    route('POST /api/audit/token/', { status: 403, body: { status_code: 403, code: 'permission_denied', message: 'You do not have permission to perform this action.' } });
    await client.close();
    await connect(ENV, { apiKey: STORED_KEY, activeOrgId: 1 });
    const denied = await call('search_audit_log', { query: 'kind = "session"' });
    expect(denied.body.error).toMatch(/audit: read/);
  });

  it('update_audit_preset replaces the search and refuses a colleague\'s preset', async () => {
    route('GET /api/audit-filter-presets/', { status: 200, body: page([preset(4, 'Failures'), preset(5, 'Theirs', { is_owner: false, is_shared: true, created_by_name: 'Ann' })]) });
    route('PATCH /api/audit-filter-presets/4/', (request) => ({ status: 200, body: preset(4, 'Failures', { filter_body: (request.body as { filter_body: unknown }).filter_body }) }));

    const mine = await call('update_audit_preset', { preset: 4, filters: { field: 'status', op: 'equals', value: 'failed' } });
    const theirs = await call('update_audit_preset', { preset: 'Theirs', name: 'Mine now' });

    expect(mine.isError, mine.text).toBe(false);
    expect(requests('PATCH', '/api/audit-filter-presets/4/')[0]!.body).toEqual({
      filter_body: { filters: { field: 'status', op: 'equals', value: 'failed' } },
    });
    expect(theirs.body.error).toMatch(/Ann's preset — only its author/);
    expect(requests('PATCH', '/api/audit-filter-presets/5/')).toHaveLength(0);
  });

  it('create_audit_preset refuses query and filters together', async () => {
    const result = await call('create_audit_preset', { name: 'x', query: 'a = "b"', filters: { field: 'a', op: 'equals', value: 'b' } });
    expect(result.body.error).toMatch(/not both/);
    expect(writes()).toHaveLength(0);
  });

  // ----- first setup ---------------------------------------------------------------

  it('complete_first_setup never posts to an instance that does not ask for setup', async () => {
    route('GET /api/auth/first-setup/', { status: 200, body: { needs_setup: false, setup_mode: 'cli_only' } });

    const status = await call('get_setup_status');
    const result = await call('complete_first_setup', { confirm: true });

    expect(status.body.data).toMatchObject({ needs_setup: false, setup_mode: 'cli_only' });
    expect(result.body.error).toMatch(/does not ask for first setup/);
    expect(requests('POST', '/api/auth/first-setup/')).toHaveLength(0);
  });

  it('complete_first_setup creates the configured account without returning the password or the session token', async () => {
    route('GET /api/auth/first-setup/', { status: 200, body: { needs_setup: true, setup_mode: 'open' } });
    route('POST /api/auth/first-setup/', {
      status: 201,
      body: {
        user: { id: 1, email: 'dev@example.com', display_name: 'Dev', is_superadmin: true },
        organization: { id: 1, name: 'Default', is_active: true },
        access: 'FIRST-SETUP-ACCESS-TOKEN',
      },
    });

    const result = await call('complete_first_setup', { display_name: 'Dev', confirm: true });

    expect(result.isError, result.text).toBe(false);
    const post = requests('POST', '/api/auth/first-setup/')[0]!;
    expect(post.body).toEqual({ email: 'dev@example.com', password: 'pw-of-the-mcp', display_name: 'Dev' });
    // Anonymous endpoint: no credential of the MCP rides along.
    expect(post.headers.get('X-Api-Key')).toBeNull();
    expect(post.headers.get('Authorization')).toBeNull();
    expect(result.text).not.toContain('pw-of-the-mcp');
    expect(result.text).not.toContain('FIRST-SETUP-ACCESS-TOKEN');
    expect(result.body.data.superadmin).toMatchObject({ email: 'dev@example.com', is_superadmin: true });
  });
});
