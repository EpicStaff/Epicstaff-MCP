import { hostname } from 'node:os';
import { logger } from '../util/logger.js';
import { ApiError } from './errors.js';
export class AuthService {
    config;
    store;
    client;
    bootstrapPromise = null;
    constructor(config, store, client) {
        this.config = config;
        this.store = store;
        this.client = client;
        client.onUnauthorized(() => this.forceRemint());
    }
    /** Ensure a working API key exists; validate the stored one or mint fresh. */
    async ensureAuthenticated() {
        if (this.bootstrapPromise) {
            return this.bootstrapPromise;
        }
        this.bootstrapPromise = this.bootstrap().finally(() => {
            this.bootstrapPromise = null;
        });
        return this.bootstrapPromise;
    }
    async forceRemint() {
        if (this.bootstrapPromise) {
            return this.bootstrapPromise;
        }
        this.store.update({ apiKey: null, keyPrefix: null });
        return this.ensureAuthenticated();
    }
    async bootstrap() {
        const { apiKey } = this.store.get();
        if (apiKey && (await this.isKeyValid())) {
            return apiKey;
        }
        return this.mintKey();
    }
    async isKeyValid() {
        try {
            // Validate route authenticates via the API key itself (X-Api-Key attached by the client).
            await this.client.get('auth/api-key/validate/');
            return true;
        }
        catch (error) {
            if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                logger.info('Stored API key is no longer valid — re-minting');
                return false;
            }
            throw error;
        }
    }
    async mintKey() {
        logger.info('Logging in to mint a new API key');
        let tokens;
        try {
            tokens = await this.client.post('auth/login/', {
                skipAuth: true,
                body: { email: this.config.email, password: this.config.password },
            });
        }
        catch (error) {
            if (error instanceof ApiError && error.status === 401) {
                throw new ApiError(error.status, error.url, 'Login failed — check ES_EMAIL / ES_PASSWORD in the MCP server environment.');
            }
            throw error;
        }
        // Raw key is returned exactly once (server stores only hash + prefix) — persist immediately.
        const minted = await this.client.post('auth/api-key/', {
            bearerToken: tokens.access,
            body: { name: `es-mcp (${hostname()})`, scopes: [] },
        });
        this.store.update({ apiKey: minted.api_key, keyPrefix: minted.prefix });
        logger.info(`Minted API key ${minted.prefix}… and persisted it`);
        return minted.api_key;
    }
}
