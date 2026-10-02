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
 *            The frontend resolves the active org once at startup (ProfileService.bootstrapUser);
 *            the headless analogue resolves it lazily before the first org-scoped request.
 *  - errors: normalize 400/422 `{errors:[{field,value,reason}]}` bodies into ApiError.
 */
export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Multipart body — used by document upload; takes precedence over `body`. */
  formData?: FormData;
  /** Skip API-key + org headers (auth endpoints). */
  skipAuth?: boolean;
  /** Use a one-off bearer token instead of the API key (minting the key, JWT-only routes). */
  bearerToken?: string;
  /** Cookies to send (the backend reads the refresh token only from its HttpOnly cookie). */
  cookies?: Record<string, string>;
  /** Receives the raw response headers (auth reads `Set-Cookie` from login / refresh). */
  onResponseHeaders?: (headers: Headers) => void;
}

/**
 * The request surface API wrappers (src/api/*) depend on — not the concrete client — so a server
 * started without a valid environment can hand them a stand-in whose every call reports the
 * configuration problem (see {@link unconfiguredClient}).
 */
export type ApiClient = Pick<EpicStaffClient, 'apiUrl' | 'get' | 'post' | 'put' | 'patch' | 'delete' | 'request'>;

/** An {@link ApiClient} whose every request rejects with `error` (invalid server environment). */
export function unconfiguredClient(error: Error): ApiClient {
  const reject = async (): Promise<never> => {
    throw error;
  };
  return {
    get apiUrl(): string {
      throw error;
    },
    get: reject,
    post: reject,
    put: reject,
    patch: reject,
    delete: reject,
    request: reject,
  };
}

const ORG_HEADER_SKIP = [/\/api\/auth\//, /\/admin\/organizations\/\d+\//];
/** The org resolver itself reads `profile/`; it must not wait on its own resolution. */
const ORG_RESOLUTION_SKIP = /\/api\/profile\//;

export class EpicStaffClient {
  /** Installed by auth.ts — runs the single-flight re-mint. Returns the fresh API key. */
  private reauthenticate: (() => Promise<string>) | null = null;
  /** Installed by org.ts — makes sure the active org is resolved before org-scoped calls. */
  private ensureOrgContext: (() => Promise<void>) | null = null;

  constructor(
    private readonly config: Config,
    private readonly store: StateStore,
  ) {}

  onUnauthorized(handler: () => Promise<string>): void {
    this.reauthenticate = handler;
  }

  onOrgContextNeeded(handler: () => Promise<void>): void {
    this.ensureOrgContext = handler;
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
    if (this.ensureOrgContext && this.isOrgScoped(url, options)) {
      await this.ensureOrgContext();
    }
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
    options.onResponseHeaders?.(response.headers);

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

  /**
   * A regular API-key request that carries the org header. Auth bootstrap traffic (skipAuth,
   * one-off bearer tokens) and the profile lookup the resolver performs are excluded, so
   * resolution can never wait on itself.
   */
  private isOrgScoped(url: string, options: RequestOptions): boolean {
    return (
      !options.skipAuth &&
      !options.bearerToken &&
      !ORG_RESOLUTION_SKIP.test(url) &&
      !ORG_HEADER_SKIP.some((pattern) => pattern.test(url))
    );
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
      const { apiKey, bearerAccessToken } = this.store.get();
      if (apiKey) {
        headers.set('X-Api-Key', apiKey);
      } else if (bearerAccessToken && this.store.get().jwtOnly) {
        // Legacy backend with no API-key system (see auth.ts) — same JWT the frontend uses.
        headers.set('Authorization', `Bearer ${bearerAccessToken}`);
      }
    }
    if (options.cookies) {
      headers.set(
        'Cookie',
        Object.entries(options.cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join('; '),
      );
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
