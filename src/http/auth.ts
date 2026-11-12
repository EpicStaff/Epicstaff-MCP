import { hostname } from 'node:os';
import { apiKeyPrefix } from '../api/profile.js';
import type { UserSession } from '../api/user-session.js';
import type { Config } from '../config.js';
import { type StateStore, activeApiKey } from '../state/store.js';
import { logger } from '../util/logger.js';
import type { EpicStaffClient } from './client.js';
import { ApiError } from './errors.js';

/**
 * Auth bootstrap — the headless analogue of the frontend's login + token refresh
 * (frontend services/auth/auth.service.ts) against the backend's rbac auth views
 * (src/django_app/rbac/views/{auth,api_keys}.py), adapted for a long-running client:
 *
 * EpicStaff binds a user API key to one organization and acts in it whatever X-Organization-Id
 * says, so the server holds one key per organization (StateStore `apiKeys`) and works with the
 * active organization's:
 *
 *   1. If a persisted key for the active organization exists, validate it (GET auth/api-key/validate/).
 *   2. Otherwise settle the active organization (OrgService) and obtain a user session — the stored
 *      JWT access token while it is unexpired, else a refresh through the stored refresh cookie,
 *      and only when both fail a login with credentials (POST auth/login/ → access token in the
 *      body, refresh token in the HttpOnly refresh cookie, see REFRESH_COOKIE_NAMES) — then either:
 *      a. mint a dedicated API key for that organization (POST profile/api-keys/ with the access
 *         token and `org_id` — the raw key is returned exactly once), persist it; or
 *      b. if profile/api-keys/ doesn't exist (a legacy backend that predates the
 *         API-key system — 404), authenticate every request with
 *         `Authorization: Bearer <access>` instead (`jwtOnly`), refreshing it via
 *         auth/refresh/ each bootstrap.
 *      While no organization is chosen (several memberships, no selection yet) nothing is
 *      minted: requests carry the JWT until set_active_organization picks one.
 *
 * The JWT session from the login is kept in both cases: some routes reject API keys
 * outright (`secrets/` — DenyApiKeyAuth), and {@link UserSession} serves them a bearer
 * token, refreshed through the cookie instead of re-logging in (LoginThrottle allows
 * only a handful of logins per minute).
 *
 * Re-mints are single-flight (the frontend dedupes refreshes the same way via
 * `refreshInProgress$`): concurrent 401s share one bootstrap promise.
 */
interface LoginResponse {
  access: string;
  /** Only legacy backends return it in the body; current ones set the refresh cookie. */
  refresh?: string;
}

interface RefreshResponse {
  access: string;
  /** Legacy backends with ROTATE_REFRESH_TOKENS return the rotated token in the body. */
  refresh?: string;
}

/** `POST profile/api-keys/` response: ApiKeySerializer fields + the raw `api_key`, once. */
interface ApiKeyMintResponse {
  id: number;
  name: string;
  prefix: string;
  expires_at: string | null;
  org_id: number;
  api_key: string;
}

/** `GET auth/api-key/validate/` response — the field MCP reads. */
interface ApiKeyValidateResponse {
  /** The organization a user API key is bound to (null for the SYSTEM key). */
  org_id?: number | null;
}

/**
 * Names of the HttpOnly refresh-token cookie (rbac/identity/refresh_cookie.py): a server that sets
 * Secure cookies (HTTPS) uses `__Host-auth.refresh` on `Path=/` and expires the old name in the
 * same response; over plain http it is `auth.refresh` on `/api/auth/`. Only the server knows which
 * applies, so the token is read from whichever it set and sent back under both names — the server
 * reads only its own name, which then appears exactly once, as it requires.
 */
export const REFRESH_COOKIE_NAMES = ['__Host-auth.refresh', 'auth.refresh'] as const;

/**
 * A key this process minted that is rejected sooner than this is not replaced by another
 * mint: the server is refusing fresh keys (revoked on creation, clock skew, a proxy dropping
 * the header), and re-minting would burn through the per-user active-key cap in a loop.
 */
export const MIN_REMINT_INTERVAL_MS = 60_000;

/** Refresh a JWT this many seconds before its `exp`, so it cannot expire in flight. */
const ACCESS_TOKEN_EXPIRY_MARGIN_SECONDS = 30;

interface JwtSession {
  access: string;
  refresh: string | null;
}

/**
 * The refresh token the response set, if any. An empty value is the server expiring a cookie
 * (the old name over HTTPS, or a logout), never a token, so it is skipped.
 */
function refreshTokenFromCookies(headers: Headers): string | null {
  const valueByName = new Map<string, string>();
  for (const cookie of headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair === undefined || separator <= 0) continue;
    const value = pair.slice(separator + 1).trim();
    if (value !== '') valueByName.set(pair.slice(0, separator).trim(), value);
  }
  for (const name of REFRESH_COOKIE_NAMES) {
    const value = valueByName.get(name);
    if (value !== undefined) return value;
  }
  return null;
}

/** The `Cookie` entries that carry `refreshToken` to auth/refresh/ under every refresh-cookie name. */
function refreshCookies(refreshToken: string): Record<string, string> {
  return Object.fromEntries(REFRESH_COOKIE_NAMES.map((name) => [name, refreshToken]));
}

/** True when the JWT's `exp` is past (or within the safety margin). Unparseable ⇒ expired. */
function isJwtExpired(token: string, nowSeconds: number = Date.now() / 1000): boolean {
  const payload = token.split('.')[1];
  if (payload === undefined) return true;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp !== 'number' || claims.exp - ACCESS_TOKEN_EXPIRY_MARGIN_SECONDS <= nowSeconds;
  } catch {
    return true;
  }
}

export class AuthService implements UserSession {
  private bootstrapPromise: Promise<string> | null = null;
  private sessionPromise: Promise<string> | null = null;
  /** When this process last minted an API key, per organization (loop guard, see MIN_REMINT_INTERVAL_MS). */
  private readonly lastMintAt = new Map<number, number>();
  /** Installed by org.ts — settles the active organization before a key is minted for it. */
  private resolveOrgContext: (() => Promise<void>) | null = null;
  /**
   * The organization EPICSTAFF_API_TOKEN is bound to when it is the only credential: the server
   * can act nowhere else (set_active_organization refuses other organizations).
   */
  pinnedOrgId: number | null = null;

  constructor(
    private readonly config: Config,
    private readonly store: StateStore,
    private readonly client: EpicStaffClient,
  ) {
    client.onUnauthorized((sent) => this.forceRemint(sent));
  }

  onOrgContextNeeded(handler: () => Promise<void>): void {
    this.resolveOrgContext = handler;
  }

  /** {@link UserSession}: login credentials are configured, so a JWT session can be opened. */
  hasUserSession(): boolean {
    return this.config.email !== undefined && this.config.password !== undefined;
  }

  /** Ensure a working credential exists; validate/refresh the stored one or establish fresh. */
  async ensureAuthenticated(): Promise<string> {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }
    this.bootstrapPromise = this.bootstrap().finally(() => {
      this.bootstrapPromise = null;
    });
    return this.bootstrapPromise;
  }

  /**
   * {@link UserSession}: a valid JWT access token for JWT-only routes. Reuses the stored
   * token, refreshes it through the refresh cookie, and logs in only when neither works.
   */
  async accessToken(): Promise<string> {
    const { bearerAccessToken } = this.store.get();
    if (bearerAccessToken && !isJwtExpired(bearerAccessToken)) {
      return bearerAccessToken;
    }
    return this.renewAccessToken();
  }

  /** {@link UserSession}: the stored access token was rejected — obtain a fresh one. */
  async renewAccessToken(): Promise<string> {
    if (this.sessionPromise) {
      return this.sessionPromise;
    }
    this.sessionPromise = this.renewSession().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  private async renewSession(): Promise<string> {
    const { bearerRefreshToken } = this.store.get();
    if (bearerRefreshToken) {
      const refreshed = await this.refreshSession(bearerRefreshToken);
      if (refreshed !== null) return refreshed;
    }
    if (this.config.email === undefined || this.config.password === undefined) {
      throw new Error(
        'This operation needs a signed-in user session (EpicStaff does not accept API keys here — e.g. ' +
          'managing org secrets). Set EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD in the MCP server environment, ' +
          'or create the secret in the EpicStaff UI.',
      );
    }
    const session = await this.login();
    this.store.update({ bearerAccessToken: session.access, bearerRefreshToken: session.refresh });
    return session.access;
  }

  private async forceRemint(sent: string | null): Promise<string> {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }
    // Drop only the rejected credential — the one the client sent. If the credential changed while
    // the request was in flight (org switch, parallel re-mint), the current one is not at fault.
    const state = this.store.get();
    if (state.activeOrgId !== null && activeApiKey(state)?.key === sent) {
      this.setOrgKey(state.activeOrgId, null);
    } else if (state.bearerAccessToken === sent) {
      this.store.update({ bearerAccessToken: null });
    }
    return this.ensureAuthenticated();
  }

  private async bootstrap(): Promise<string> {
    if (this.config.apiToken !== undefined) {
      const token = await this.useProvidedToken(this.config.apiToken);
      if (token !== null) return token;
    }
    let state = this.store.reloadApiKeys();
    if (state.jwtOnly && state.bearerRefreshToken) {
      const refreshed = await this.refreshSession(state.bearerRefreshToken);
      if (refreshed !== null) return refreshed;
    }
    if (!activeApiKey(state)) {
      // A key belongs to one organization: settle which (drop a stale selection, auto-select a
      // single membership) before looking for its key or minting one.
      await this.resolveOrgContext?.();
      state = this.store.get();
    }
    const held = activeApiKey(state);
    if (held && (await this.validate(held.key)) !== null) {
      return held.key;
    }
    if (state.activeOrgId === null) {
      // Several organizations and none chosen yet: work with the JWT until set_active_organization.
      return this.accessToken();
    }
    return this.establishCredential(state.activeOrgId);
  }

  /**
   * EPICSTAFF_API_TOKEN path (the original plugin's contract): use the pre-issued key directly,
   * held as the key of the organization auth/api-key/validate/ names. As the only credential it
   * pins the server to that organization. Next to login credentials it serves its own organization
   * and the credential flow takes over elsewhere — or everywhere, when the token is rejected.
   * Returns null when the credential flow should continue.
   */
  private async useProvidedToken(token: string): Promise<string | null> {
    const validated = await this.validate(token);
    if (this.hasUserSession()) {
      if (validated === null) {
        logger.info('EPICSTAFF_API_TOKEN was rejected — falling back to credential login');
        return null;
      }
      if (typeof validated.org_id === 'number') {
        this.setOrgKey(validated.org_id, token);
        if (this.store.get().activeOrgId === null) this.store.update({ activeOrgId: validated.org_id });
      }
      return activeApiKey(this.store.get())?.key === token ? token : null;
    }
    if (validated === null) {
      throw new Error(
        'EPICSTAFF_API_TOKEN was rejected by the server. Provide a valid token, ' +
          'or set EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD so a fresh key can be minted.',
      );
    }
    if (typeof validated.org_id !== 'number') {
      throw new Error(
        'EPICSTAFF_API_TOKEN is not bound to an organization (the system key?). Use a personal API key ' +
          '(EpicStaff → Profile → API keys), or set EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD instead.',
      );
    }
    this.pinnedOrgId = validated.org_id;
    this.setOrgKey(validated.org_id, token);
    this.store.update({ activeOrgId: validated.org_id, jwtOnly: false });
    return token;
  }

  /** `key`'s details from auth/api-key/validate/, or null when the server rejects it. */
  private async validate(key: string): Promise<ApiKeyValidateResponse | null> {
    try {
      return await this.client.get<ApiKeyValidateResponse>('auth/api-key/validate/', { apiKey: key });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        logger.info(`API key ${apiKeyPrefix(key)}… is no longer valid`);
        return null;
      }
      throw error;
    }
  }

  /** Hold `key` as `orgId`'s API key, or drop that organization's key (null). */
  private setOrgKey(orgId: number, key: string | null): void {
    const apiKeys = { ...this.store.get().apiKeys };
    if (key === null) delete apiKeys[orgId];
    else apiKeys[orgId] = { key, prefix: apiKeyPrefix(key) };
    this.store.update({ apiKeys });
  }

  /**
   * Exchange the refresh token for a new access token (POST auth/refresh/). Current
   * backends read the token only from the refresh cookie; legacy ones read the
   * `refresh` body field — both are sent. Returns null when the refresh token itself is
   * rejected (expired or revoked), after clearing the session.
   */
  private async refreshSession(refreshToken: string): Promise<string | null> {
    let rotatedCookie: string | null = null;
    let refreshed: RefreshResponse;
    try {
      refreshed = await this.client.post<RefreshResponse>('auth/refresh/', {
        skipAuth: true,
        cookies: refreshCookies(refreshToken),
        body: { refresh: refreshToken },
        onResponseHeaders: (headers) => {
          rotatedCookie = refreshTokenFromCookies(headers);
        },
      });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        logger.info('Stored refresh token is no longer valid — a fresh login is needed');
        this.store.update({ bearerAccessToken: null, bearerRefreshToken: null });
        return null;
      }
      throw error;
    }
    this.store.update({
      bearerAccessToken: refreshed.access,
      bearerRefreshToken: rotatedCookie ?? refreshed.refresh ?? refreshToken,
    });
    return refreshed.access;
  }

  private async login(): Promise<JwtSession> {
    const { email, password } = this.config;
    if (email === undefined || password === undefined) {
      throw new Error('login() called without credentials — this is a bug in AuthService.');
    }
    logger.info('Logging in to establish a user session');
    let refreshCookie: string | null = null;
    let tokens: LoginResponse;
    try {
      tokens = await this.client.post<LoginResponse>('auth/login/', {
        skipAuth: true,
        // remember_me: the refresh cookie lives for REFRESH_TOKEN_LIFETIME instead of 30 minutes,
        // so later processes refresh instead of logging in again.
        body: { email, password, remember_me: true },
        onResponseHeaders: (headers) => {
          refreshCookie = refreshTokenFromCookies(headers);
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw new ApiError(
          error.status,
          error.url,
          'Login failed — check EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD in the MCP server environment.',
        );
      }
      if (error instanceof ApiError && error.status === 429) {
        throw new ApiError(
          error.status,
          error.url,
          'Login is rate-limited by the server (too many logins) — wait a minute and retry.',
        );
      }
      throw error;
    }
    return { access: tokens.access, refresh: refreshCookie ?? tokens.refresh ?? null };
  }

  /**
   * Mint a dedicated API key for `orgId` with the user's JWT session. The session comes from the
   * store when possible (unexpired access token, else a cookie refresh) — a login happens only when
   * neither works, because LoginThrottle allows just a handful per minute.
   */
  private async establishCredential(orgId: number): Promise<string> {
    const storedAccess = this.store.get().bearerAccessToken;
    const access = await this.accessToken();
    try {
      this.assertNotRemintLoop(orgId);
      try {
        return await this.mintWith(access, orgId);
      } catch (error) {
        // A stored access token can be revoked server-side before its `exp` (logout elsewhere).
        // Drop it and renew once — refresh cookie, else login — then retry the mint.
        if (error instanceof ApiError && error.status === 401 && access === storedAccess) {
          logger.info('Stored access token was rejected while minting — renewing the session');
          this.store.update({ bearerAccessToken: null });
          return await this.mintWith(await this.renewAccessToken(), orgId);
        }
        throw error;
      }
    } catch (error) {
      // No key for this org (e.g. its 5-active-key limit is reached). The JWT with X-Organization-Id
      // acts in the same org, so keep working instead of locking every tool — set_active_organization
      // and revoke_my_api_key included.
      logger.warn(
        `Could not get an API key for organization ${orgId} (${error instanceof Error ? error.message : String(error)}) — using the signed-in session instead`,
      );
      return this.accessToken();
    }
  }

  private assertNotRemintLoop(orgId: number): void {
    const lastMintAt = this.lastMintAt.get(orgId);
    if (lastMintAt === undefined) return;
    const ageMs = Date.now() - lastMintAt;
    if (ageMs < MIN_REMINT_INTERVAL_MS) {
      throw new Error(
        `The API key this server minted ${Math.round(ageMs / 1000)}s ago was rejected right away — not minting ` +
          'another one (that would loop and exhaust the active-key limit). Check the EpicStaff API-key settings, ' +
          'the server clock, and any proxy that might strip the X-Api-Key header, then call check_connection again.',
      );
    }
  }

  private async mintWith(access: string, orgId: number): Promise<string> {
    try {
      // Raw key is returned exactly once (server stores only hash + prefix) — persist immediately.
      // The route is JWT-only (DenyApiKeyAuth) — hence the bearer token.
      const minted = await this.client.post<ApiKeyMintResponse>('profile/api-keys/', {
        bearerToken: access,
        body: { name: `es-mcp (${hostname()})`, org_id: orgId },
      });
      this.lastMintAt.set(orgId, Date.now());
      this.store.update({
        apiKeys: { ...this.store.get().apiKeys, [orgId]: { key: minted.api_key, prefix: minted.prefix } },
        bearerAccessToken: access,
        jwtOnly: false,
      });
      logger.info(`Minted API key ${minted.prefix}… for organization ${orgId} and persisted it`);
      return minted.api_key;
    } catch (error) {
      // A 1.5 backend also answers 404 for a deleted organization — that is not a legacy backend.
      if (!(error instanceof ApiError && error.status === 404) || error.bodyExcerpt?.includes('organization_not_found')) {
        throw error;
      }
      // Legacy backend: no API-key system at all. Authenticate with Authorization: Bearer
      // instead — the client uses the JWT whenever jwtOnly is set (see client.ts buildHeaders).
      logger.info('profile/api-keys/ not found — this backend has no API-key system; using JWT bearer auth instead');
      this.store.update({
        apiKeys: {},
        bearerAccessToken: access,
        jwtOnly: true,
      });
      return access;
    }
  }
}
