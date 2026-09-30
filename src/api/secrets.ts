import type { EpicStaffClient } from '../http/client.js';
import { ApiError } from '../http/errors.js';

/**
 * Org Secrets API — ported from shared/services/secrets/secrets-api.service.ts.
 *
 * `secrets/` is JWT-only on the backend (SecretViewSet → DenyApiKeyAuth): an API key
 * can neither list nor create secrets. Every call therefore carries the user-session
 * bearer token from {@link UserSession}, never the X-Api-Key the rest of the MCP uses.
 *
 * A Secret's name and value are immutable. The response exposes only `tail` (the last
 * 4 characters of values of 9+ characters), never the value.
 */
export interface Secret {
  id: number;
  name: string;
  /** Last 4 characters of the value, or '' for values shorter than 9 characters. */
  tail: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** Supplies a JWT access token for JWT-only routes (implemented by AuthService). */
export interface UserSession {
  /** A currently valid access token — refreshed or re-established as needed. */
  accessToken(): Promise<string>;
  /** The token was rejected (401): drop it and return a fresh one. */
  renewAccessToken(): Promise<string>;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

/** Mirrors the backend's tail rule (tables/services/secrets/encryption.py). */
const TAIL_LENGTH = 4;
const MIN_LENGTH_FOR_TAIL = 9;

export function secretTail(value: string): string {
  return value.length >= MIN_LENGTH_FOR_TAIL ? value.slice(-TAIL_LENGTH) : '';
}

export class SecretsApi {
  constructor(
    private readonly client: EpicStaffClient,
    private readonly session: UserSession,
  ) {}

  async list(): Promise<Secret[]> {
    const response = await this.withSession((bearerToken) =>
      this.client.get<Paginated<Secret> | Secret[]>('secrets/', { bearerToken, query: { limit: 1000 } }),
    );
    return Array.isArray(response) ? response : response.results;
  }

  async findByName(name: string): Promise<Secret | undefined> {
    return (await this.list()).find((secret) => secret.name === name);
  }

  /**
   * Create a secret. Errors are re-thrown WITHOUT the response body: validation bodies
   * echo the submitted `value`, which must never reach logs or the MCP client.
   */
  async create(name: string, value: string): Promise<Secret> {
    try {
      return await this.withSession((bearerToken) =>
        this.client.post<Secret>('secrets/', { bearerToken, body: { name, value } }),
      );
    } catch (error) {
      if (error instanceof ApiError) {
        const reasons = (error.validationErrors ?? [])
          .filter((issue) => issue.field !== 'value')
          .map((issue) => `${issue.field}: ${issue.reason}`);
        const valueRejected = (error.validationErrors ?? []).some((issue) => issue.field === 'value');
        throw new ApiError(
          error.status,
          error.url,
          `Creating secret "${name}" failed with HTTP ${error.status}` +
            (reasons.length > 0 ? ` — ${reasons.join('; ')}` : '') +
            (valueRejected ? ' — the secret value was rejected (value not shown)' : ''),
        );
      }
      throw error;
    }
  }

  private async withSession<T>(call: (bearerToken: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.session.accessToken());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return call(await this.session.renewAccessToken());
      }
      throw error;
    }
  }
}
