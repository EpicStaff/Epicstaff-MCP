import type { Config } from '../config.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../util/logger.js';
import { ApiError, toApiError } from './errors.js';

/**
 * Headless port of the EpicStaff frontend HTTP layer.
 *
 * Mirrors the Angular interceptor chain
 * (core/interceptors/auth.interceptor.ts + active-org.interceptor.ts):
 *  - auth:   attach `X-Api-Key` to every non-auth request (the headless analogue of
 *            `Authorization: Bearer`); on 401 run a single-flight re-auth and retry once.
 *  - org:    attach `X-Organization-Id` when an active org is selected; skipped for
 *            auth endpoints and admin organization routes, same rules as the frontend.
 *  - errors: normalize 400/422 `{errors:[{field,value,reason}]}` bodies into ApiError.
 */
export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Multipart body — used by document upload; takes precedence over `body`. */
  formData?: FormData;
  /** Skip API-key + org headers (auth endpoints). */
  skipAuth?: boolean;
  /** Use a one-off bearer token instead of the API key (bootstrap: minting the key). */
  bearerToken?: string;
}

const ORG_HEADER_SKIP = [/\/api\/auth\//, /\/admin\/organizations\/\d+\//];

export class EpicStaffClient {
  /** Installed by auth.ts — runs the single-flight re-mint. Returns the fresh API key. */
  private reauthenticate: (() => Promise<string>) | null = null;

  constructor(
    private readonly config: Config,
    private readonly store: StateStore,
  ) {}

  onUnauthorized(handler: () => Promise<string>): void {
    this.reauthenticate = handler;
  }

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  async post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  async put<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  async patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, options);
  }

  async delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(url, options);

    const init: RequestInit = { method, headers };
    if (options.formData) {
      init.body = options.formData;
    } else if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(options.body);
    }

    logger.debug(`${method} ${url}`);
    const response = await fetch(url, init);

    // Auth endpoints are exempt from the 401→re-auth retry (mirrors auth.interceptor.ts,
    // which never refresh-retries /auth/ URLs) — otherwise key validation would deadlock
    // against the bootstrap that issued it.
    const isAuthEndpoint = /\/api\/auth\//.test(url);
    if (
      response.status === 401 &&
      !isAuthEndpoint &&
      !options.skipAuth &&
      !options.bearerToken &&
      !isRetry &&
      this.reauthenticate
    ) {
      logger.info('Got 401 — re-authenticating and retrying once');
      await this.reauthenticate();
      return this.request<T>(method, path, options, true);
    }

    if (!response.ok) {
      throw await toApiError(response, url);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
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

  private buildHeaders(url: string, options: RequestOptions): Headers {
    const headers = new Headers();
    if (options.bearerToken) {
      headers.set('Authorization', `Bearer ${options.bearerToken}`);
    } else if (!options.skipAuth) {
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
