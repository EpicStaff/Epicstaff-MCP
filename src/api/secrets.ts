import type { ApiClient } from '../http/client.js';
import { ApiError } from '../http/errors.js';
import type { UserSummary } from '../models/authorship.js';
import { type Paginated, unwrap } from './paging.js';
import { type UserSession, withUserSession } from './user-session.js';

/**
 * Org Secrets API — ported from shared/services/secrets/secrets-api.service.ts.
 *
 * `secrets/` is closed to personal API keys on the backend (SecretViewSet →
 * DenyPersonalAndSystemApiKeys): an API key can neither list nor create secrets. Every call
 * therefore carries the user-session bearer token from {@link UserSession}, never the
 * X-Api-Key the rest of the MCP uses.
 *
 * A Secret's name and value are immutable. The response exposes only `tail` (the last
 * 4 characters of values of 9+ characters), never the value. Deleting moves the secret to the
 * recycle bin (RecycleBinActionsMixin).
 */
export interface Secret {
  id: number;
  name: string;
  /** Last 4 characters of the value, or '' for values shorter than 9 characters. */
  tail: string;
  metadata?: Record<string, unknown>;
  created_by?: UserSummary | null;
  created_at?: string;
  updated_at?: string;
  /** How many configs, tools and nodes reference this secret (SecretSerializer.usage_count). */
  usage_count?: number;
}

/** Mirrors the backend's tail rule (tables/services/secrets/encryption.py). */
const TAIL_LENGTH = 4;
const MIN_LENGTH_FOR_TAIL = 9;

export function secretTail(value: string): string {
  return value.length >= MIN_LENGTH_FOR_TAIL ? value.slice(-TAIL_LENGTH) : '';
}

export class SecretsApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  async list(): Promise<Secret[]> {
    const response = await withUserSession(this.session, (bearerToken) =>
      this.client.get<Paginated<Secret> | Secret[]>('secrets/', { bearerToken, query: { limit: 1000 } }),
    );
    return unwrap(response);
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
      return await withUserSession(this.session, (bearerToken) =>
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

  /** Move a secret to the recycle bin (`deleteSecret`). Configs and code that read it lose access. */
  async delete(id: number): Promise<void> {
    await withUserSession(this.session, (bearerToken) => this.client.delete<void>(`secrets/${id}/`, { bearerToken }));
  }
}
