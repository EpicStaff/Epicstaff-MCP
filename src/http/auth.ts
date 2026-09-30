import { hostname } from 'node:os';
import type { Config } from '../config.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../util/logger.js';
import type { EpicStaffClient } from './client.js';
import { ApiError } from './errors.js';

/**
 * Auth bootstrap — the headless analogue of the frontend's login + token refresh
 * (services/auth/auth.service.ts), adapted for a long-running client:
 *
 *   1. If a persisted API key exists, validate it (GET auth/api-key/validate/).
 *   2. Otherwise login with credentials (POST auth/login/ → JWT pair), then either:
 *      a. mint a dedicated API key (POST auth/api-key/ — raw key returned exactly
 *         once), persist it, and discard the JWTs; or
 *      b. if auth/api-key/ doesn't exist (a legacy backend that predates the
 *         API-key system — 404), keep the JWT pair and authenticate every request
 *         with `Authorization: Bearer <access>` instead, refreshing it via
 *         auth/refresh/ (mirrors the frontend's refreshToken()) each bootstrap.
 *
 * Re-mints are single-flight (the frontend dedupes refreshes the same way via
 * `refreshInProgress$`): concurrent 401s share one bootstrap promise.
 */
interface TokenPair {
  access: string;
  refresh: string;
}

interface RefreshResponse {
  access: string;
  /** Only present when the backend rotates refresh tokens (SimpleJWT ROTATE_REFRESH_TOKENS). */
  refresh?: string;
}

interface ApiKeyMintResponse {
  api_key: string;
  prefix: string;
  name: string;
}

export class AuthService {
  private bootstrapPromise: Promise<string> | null = null;

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

  private async forceRemint(): Promise<string> {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }
    // Drop the rejected credential in both schemes; bootstrap() below picks whichever
    // path still has something to work with (refresh token, credentials, or nothing).
    this.store.update({ apiKey: null, keyPrefix: null, bearerAccessToken: null });
    return this.ensureAuthenticated();
  }

  private async bootstrap(): Promise<string> {
    if (this.config.apiToken !== undefined) {
      return this.useProvidedToken(this.config.apiToken);
    }
    const { apiKey, bearerRefreshToken } = this.store.get();
    if (apiKey && (await this.isKeyValid())) {
      return apiKey;
    }
    if (!apiKey && bearerRefreshToken) {
      return this.refreshBearer(bearerRefreshToken);
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
    this.store.update({ apiKey: token, keyPrefix: token.slice(0, 8) });
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
   * Refresh a legacy backend's JWT access token via its refresh token. Falls back to a
   * fresh login when the refresh token itself is rejected (expired or revoked).
   */
  private async refreshBearer(refreshToken: string): Promise<string> {
    let refreshed: RefreshResponse;
    try {
      refreshed = await this.client.post<RefreshResponse>('auth/refresh/', {
        skipAuth: true,
        body: { refresh: refreshToken },
      });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        logger.info('Stored refresh token is no longer valid — logging in again');
        this.store.update({ bearerAccessToken: null, bearerRefreshToken: null });
        return this.establishCredential();
      }
      throw error;
    }
    this.store.update({
      bearerAccessToken: refreshed.access,
      bearerRefreshToken: refreshed.refresh ?? refreshToken,
    });
    return refreshed.access;
  }

  private async establishCredential(): Promise<string> {
    // Every caller (bootstrap, useProvidedToken's fallback check) already verified
    // both are set before reaching here.
    const { email, password } = this.config;
    if (email === undefined || password === undefined) {
      throw new Error('establishCredential() called without credentials — this is a bug in AuthService.');
    }
    logger.info('Logging in to establish a credential');
    let tokens: TokenPair;
    try {
      tokens = await this.client.post<TokenPair>('auth/login/', {
        skipAuth: true,
        body: { email, password },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw new ApiError(
          error.status,
          error.url,
          'Login failed — check EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD in the MCP server environment.',
        );
      }
      throw error;
    }

    try {
      // Raw key is returned exactly once (server stores only hash + prefix) — persist immediately.
      const minted = await this.client.post<ApiKeyMintResponse>('auth/api-key/', {
        bearerToken: tokens.access,
        body: { name: `es-mcp (${hostname()})`, scopes: [] },
      });
      this.store.update({
        apiKey: minted.api_key,
        keyPrefix: minted.prefix,
        bearerAccessToken: null,
        bearerRefreshToken: null,
      });
      logger.info(`Minted API key ${minted.prefix}… and persisted it`);
      return minted.api_key;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        throw error;
      }
      // Legacy backend: no API-key system at all. Keep the JWT pair and authenticate
      // with Authorization: Bearer instead — the client falls back to that header
      // whenever no apiKey is stored (see client.ts buildHeaders).
      logger.info('auth/api-key/ not found — this backend has no API-key system; using JWT bearer auth instead');
      this.store.update({
        apiKey: null,
        keyPrefix: null,
        bearerAccessToken: tokens.access,
        bearerRefreshToken: tokens.refresh,
      });
      return tokens.access;
    }
  }
}
