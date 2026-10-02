import { hostname } from 'node:os';
import type { UserSession } from '../api/secrets.js';
import type { Config } from '../config.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../util/logger.js';
import type { EpicStaffClient } from './client.js';
import { ApiError } from './errors.js';

/**
 * Auth bootstrap — the headless analogue of the frontend's login + token refresh
 * (frontend services/auth/auth.service.ts) against the backend's rbac auth views
 * (src/django_app/rbac/views/{auth,api_keys}.py), adapted for a long-running client:
 *
 *   1. If a persisted API key exists, validate it (GET auth/api-key/validate/).
 *   2. Otherwise obtain a user session — the stored JWT access token while it is unexpired,
 *      else a refresh through the stored `auth.refresh` cookie, and only when both fail a
 *      login with credentials (POST auth/login/ → access token in the body, refresh token in
 *      the HttpOnly `auth.refresh` cookie) — then either:
 *      a. mint a dedicated API key (POST profile/api-keys/ with the access token — the
 *         raw key is returned exactly once), persist it; or
 *      b. if profile/api-keys/ doesn't exist (a legacy backend that predates the
 *         API-key system — 404), authenticate every request with
 *         `Authorization: Bearer <access>` instead (`jwtOnly`), refreshing it via
 *         auth/refresh/ each bootstrap.
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
  /** Only legacy backends return it in the body; current ones set the `auth.refresh` cookie. */
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
  api_key: string;
}

/** Name of the HttpOnly refresh-token cookie (rbac/identity/refresh_cookie.py). */
export const REFRESH_COOKIE_NAME = 'auth.refresh';

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

/** Extract `auth.refresh` from Set-Cookie headers, if the response set it. */
function refreshTokenFromCookies(headers: Headers): string | null {
  for (const cookie of headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair !== undefined && separator > 0 && pair.slice(0, separator).trim() === REFRESH_COOKIE_NAME) {
      const value = pair.slice(separator + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
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
  /** When this process last minted an API key (loop guard, see MIN_REMINT_INTERVAL_MS). */
  private lastMintAt: number | null = null;

  constructor(
    private readonly config: Config,
    private readonly store: StateStore,
    private readonly client: EpicStaffClient,
  ) {
    client.onUnauthorized(() => this.forceRemint());
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

  private async forceRemint(): Promise<string> {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }
    // Drop only the rejected credential. In API-key mode the JWT session is a different
    // credential and stays usable for minting the replacement key without a login; in
    // JWT-only mode the access token IS the rejected credential.
    if (this.store.get().jwtOnly) {
      this.store.update({ bearerAccessToken: null });
    } else {
      this.store.update({ apiKey: null, keyPrefix: null });
    }
    return this.ensureAuthenticated();
  }

  private async bootstrap(): Promise<string> {
    if (this.config.apiToken !== undefined) {
      return this.useProvidedToken(this.config.apiToken);
    }
    const { apiKey, bearerRefreshToken, jwtOnly } = this.store.get();
    if (apiKey && (await this.isKeyValid())) {
      return apiKey;
    }
    if (jwtOnly && !apiKey && bearerRefreshToken) {
      const refreshed = await this.refreshSession(bearerRefreshToken);
      if (refreshed !== null) return refreshed;
    }
    return this.establishCredential();
  }

  /**
   * EPICSTAFF_API_TOKEN path (the original plugin's contract): use the
   * pre-issued key directly. Seeded into the store so the client attaches it
   * as X-Api-Key like any minted key. Falls back to credential login only
   * when the token is rejected AND credentials are configured.
   */
  private async useProvidedToken(token: string): Promise<string> {
    this.store.update({ apiKey: token, keyPrefix: token.slice(0, 8), jwtOnly: false });
    if (await this.isKeyValid()) {
      return token;
    }
    this.store.update({ apiKey: null, keyPrefix: null });
    if (this.config.email !== undefined && this.config.password !== undefined) {
      logger.info('EPICSTAFF_API_TOKEN was rejected — falling back to credential login');
      return this.establishCredential();
    }
    throw new Error(
      'EPICSTAFF_API_TOKEN was rejected by the server. Provide a valid token, ' +
        'or set EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD so a fresh key can be minted.',
    );
  }

  private async isKeyValid(): Promise<boolean> {
    try {
      // Validate route authenticates via the API key itself (X-Api-Key attached by the client).
      await this.client.get('auth/api-key/validate/');
      return true;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        logger.info('Stored API key is no longer valid — re-minting');
        return false;
      }
      throw error;
    }
  }

  /**
   * Exchange the refresh token for a new access token (POST auth/refresh/). Current
   * backends read the token only from the `auth.refresh` cookie; legacy ones read the
   * `refresh` body field — both are sent. Returns null when the refresh token itself is
   * rejected (expired or revoked), after clearing the session.
   */
  private async refreshSession(refreshToken: string): Promise<string | null> {
    let rotatedCookie: string | null = null;
    let refreshed: RefreshResponse;
    try {
      refreshed = await this.client.post<RefreshResponse>('auth/refresh/', {
        skipAuth: true,
        cookies: { [REFRESH_COOKIE_NAME]: refreshToken },
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
   * Mint a dedicated API key with the user's JWT session. The session comes from the store
   * when possible (unexpired access token, else a cookie refresh) — a login happens only when
   * neither works, because LoginThrottle allows just a handful per minute.
   */
  private async establishCredential(): Promise<string> {
    this.assertNotRemintLoop();
    const storedAccess = this.store.get().bearerAccessToken;
    const access = await this.accessToken();
    try {
      return await this.mintWith(access);
    } catch (error) {
      // A stored access token can be revoked server-side before its `exp` (logout elsewhere).
      // Drop it and renew once — refresh cookie, else login — then retry the mint.
      if (error instanceof ApiError && error.status === 401 && access === storedAccess) {
        logger.info('Stored access token was rejected while minting — renewing the session');
        this.store.update({ bearerAccessToken: null });
        return this.mintWith(await this.renewAccessToken());
      }
      throw error;
    }
  }

  private assertNotRemintLoop(): void {
    if (this.lastMintAt === null) return;
    const ageMs = Date.now() - this.lastMintAt;
    if (ageMs < MIN_REMINT_INTERVAL_MS) {
      throw new Error(
        `The API key this server minted ${Math.round(ageMs / 1000)}s ago was rejected right away — not minting ` +
          'another one (that would loop and exhaust the active-key limit). Check the EpicStaff API-key settings, ' +
          'the server clock, and any proxy that might strip the X-Api-Key header, then call check_connection again.',
      );
    }
  }

  private async mintWith(access: string): Promise<string> {
    const { bearerRefreshToken } = this.store.get();
    try {
      // Raw key is returned exactly once (server stores only hash + prefix) — persist immediately.
      // The route is JWT-only (DenyApiKeyAuth) — hence the bearer token.
      const minted = await this.client.post<ApiKeyMintResponse>('profile/api-keys/', {
        bearerToken: access,
        body: { name: `es-mcp (${hostname()})` },
      });
      this.lastMintAt = Date.now();
      this.store.update({
        apiKey: minted.api_key,
        keyPrefix: minted.prefix,
        bearerAccessToken: access,
        bearerRefreshToken,
        jwtOnly: false,
      });
      logger.info(`Minted API key ${minted.prefix}… and persisted it`);
      return minted.api_key;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        throw error;
      }
      // Legacy backend: no API-key system at all. Authenticate with Authorization: Bearer
      // instead — the client uses the JWT whenever jwtOnly is set (see client.ts buildHeaders).
      logger.info('profile/api-keys/ not found — this backend has no API-key system; using JWT bearer auth instead');
      this.store.update({
        apiKey: null,
        keyPrefix: null,
        bearerAccessToken: access,
        bearerRefreshToken,
        jwtOnly: true,
      });
      return access;
    }
  }
}
