import { logger } from '../util/logger.js';
import { toApiError } from './errors.js';
const ORG_HEADER_SKIP = [/\/api\/auth\//, /\/admin\/organizations\/\d+\//];
export class EpicStaffClient {
    config;
    store;
    /** Installed by auth.ts — runs the single-flight re-mint. Returns the fresh API key. */
    reauthenticate = null;
    constructor(config, store) {
        this.config = config;
        this.store = store;
    }
    onUnauthorized(handler) {
        this.reauthenticate = handler;
    }
    get apiUrl() {
        return this.config.apiUrl;
    }
    async get(path, options = {}) {
        return this.request('GET', path, options);
    }
    async post(path, options = {}) {
        return this.request('POST', path, options);
    }
    async put(path, options = {}) {
        return this.request('PUT', path, options);
    }
    async patch(path, options = {}) {
        return this.request('PATCH', path, options);
    }
    async delete(path, options = {}) {
        return this.request('DELETE', path, options);
    }
    async request(method, path, options = {}, isRetry = false) {
        const url = this.buildUrl(path, options.query);
        const headers = this.buildHeaders(url, options);
        const init = { method, headers };
        if (options.formData) {
            init.body = options.formData;
        }
        else if (options.body !== undefined) {
            headers.set('Content-Type', 'application/json');
            init.body = JSON.stringify(options.body);
        }
        logger.debug(`${method} ${url}`);
        const response = await fetch(url, init);
        // Auth endpoints are exempt from the 401→re-auth retry (mirrors auth.interceptor.ts,
        // which never refresh-retries /auth/ URLs) — otherwise key validation would deadlock
        // against the bootstrap that issued it.
        const isAuthEndpoint = /\/api\/auth\//.test(url);
        if (response.status === 401 &&
            !isAuthEndpoint &&
            !options.skipAuth &&
            !options.bearerToken &&
            !isRetry &&
            this.reauthenticate) {
            logger.info('Got 401 — re-authenticating and retrying once');
            await this.reauthenticate();
            return this.request(method, path, options, true);
        }
        if (!response.ok) {
            throw await toApiError(response, url);
        }
        if (response.status === 204) {
            return undefined;
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined);
    }
    buildUrl(path, query) {
        // apiUrl always ends with `/api/`; paths are resource-relative like `graphs/{id}/save/`.
        const url = new URL(path.replace(/^\//, ''), this.config.apiUrl);
        if (query) {
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined) {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        return url.toString();
    }
    buildHeaders(url, options) {
        const headers = new Headers();
        if (options.bearerToken) {
            headers.set('Authorization', `Bearer ${options.bearerToken}`);
        }
        else if (!options.skipAuth) {
            const { apiKey } = this.store.get();
            if (apiKey) {
                headers.set('X-Api-Key', apiKey);
            }
        }
        if (!options.skipAuth && !ORG_HEADER_SKIP.some((pattern) => pattern.test(url))) {
            const { activeOrgId } = this.store.get();
            if (activeOrgId !== null) {
                headers.set('X-Organization-Id', String(activeOrgId));
            }
        }
        return headers;
    }
}
