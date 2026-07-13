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
 *   2. Otherwise login with credentials (POST auth/login/ → JWT pair),
 *      mint a dedicated API key (POST auth/api-key/ — raw key returned exactly once),
 *      persist it, and discard the JWTs.
 *
 * Re-mints are single-flight (the frontend dedupes refreshes the same way via
 * `refreshInProgress$`): concurrent 401s share one bootstrap promise.
 */
interface TokenPair {
  access: string;
  refresh: string;
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

  /** Ensure a working API key exists; validate the stored one or mint fresh. */
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
    this.store.update({ apiKey: null, keyPrefix: null });
    return this.ensureAuthenticated();
  }

  private async bootstrap(): Promise<string> {
    const { apiKey } = this.store.get();
    if (apiKey && (await this.isKeyValid())) {
      return apiKey;
    }
    return this.mintKey();
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

  private async mintKey(): Promise<string> {
    logger.info('Logging in to mint a new API key');
    let tokens: TokenPair;
    try {
      tokens = await this.client.post<TokenPair>('auth/login/', {
        skipAuth: true,
        body: { email: this.config.email, password: this.config.password },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw new ApiError(
          error.status,
          error.url,
          'Login failed — check ES_EMAIL / ES_PASSWORD in the MCP server environment.',
        );
      }
      throw error;
    }

    // Raw key is returned exactly once (server stores only hash + prefix) — persist immediately.
    const minted = await this.client.post<ApiKeyMintResponse>('auth/api-key/', {
      bearerToken: tokens.access,
      body: { name: `es-mcp (${hostname()})`, scopes: [] },
    });
    this.store.update({ apiKey: minted.api_key, keyPrefix: minted.prefix });
    logger.info(`Minted API key ${minted.prefix}… and persisted it`);
    return minted.api_key;
  }
}
