import type { ApiClient } from '../http/client.js';
import { ApiError } from '../http/errors.js';

/**
 * Audit trail search — ported from frontend `features/audit/services/audit-token.service.ts` (the
 * short-lived audit token) and `features/audit/services/audit-api.service.ts` (the auditor's session
 * search), with the request shape of src/auditor/app/domains/sessions/schemas.py.
 *
 * Two hops, like the frontend:
 *   1. `POST api/audit/token/` (django_app AuditTokenView) mints a JWT for the caller and the active
 *      organization, carrying the AUDIT actions the caller holds there (`read`, `export`) and the
 *      retention window that bounds what it may see. 403 when the caller has no AUDIT permission.
 *   2. The auditor service, reached through nginx at `<origin>/auditor/`, verifies that token locally
 *      and answers `POST api/audit/sessions/search`, scoped to the token's organization.
 *
 * The token is a bearer credential: it lives only in this object's memory, bound to one
 * organization, and is never logged, persisted or returned to a tool caller.
 */

/** Auditor's sessions-domain `MatchScope` — which rows come back around a match. */
export interface AuditMatchScope {
  ancestors?: boolean;
  children?: boolean;
  /** 0–20. */
  rows_before?: number;
  full_session_history?: boolean;
}

/** `SessionSearchRequest` — `filters` (a FilterNode tree) and `query` (text) are mutually exclusive. */
export interface AuditSearchRequest {
  filters?: Record<string, unknown>;
  query?: string;
  match_scope?: AuditMatchScope;
  cursor?: string;
  /** 1–1000, auditor default 50. */
  size?: number;
}

/** `SessionSearchResponse`. */
export interface AuditSearchResponse {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
  partial: boolean;
}

interface AuditTokenResponse {
  token: string;
  expires_in: number;
}

/** Re-mint this long before expiry, so a token never expires in flight (frontend REFRESH_MARGIN_MS). */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

/**
 * The auditor sits next to the API on the same origin (nginx `/auditor/`, frontend
 * environment `auditorUrl: '/auditor/'`); resolved relative to the API base `…/api/`.
 */
export const AUDITOR_SESSIONS_SEARCH_PATH = '../auditor/api/audit/sessions/search';

export class AuditApi {
  private cached: { orgId: number; token: string; expiresAt: number } | null = null;

  constructor(private readonly client: ApiClient) {}

  /**
   * Search the active organization's session audit trail. `orgId` must be the organization the
   * client currently sends as X-Organization-Id — the token is minted for, and cached per, it.
   */
  async searchSessions(orgId: number, request: AuditSearchRequest): Promise<AuditSearchResponse> {
    const search = async (token: string): Promise<AuditSearchResponse> =>
      this.client.post<AuditSearchResponse>(AUDITOR_SESSIONS_SEARCH_PATH, { bearerToken: token, body: request });
    try {
      return await search(await this.token(orgId));
    } catch (error) {
      // An expired or rotated-secret token: drop it and mint once more (frontend AuditTokenService does the same).
      if (error instanceof ApiError && error.status === 401) {
        this.clear();
        return search(await this.token(orgId));
      }
      throw error;
    }
  }

  /** Forget the token (organization switch, rejection). */
  clear(): void {
    this.cached = null;
  }

  private async token(orgId: number): Promise<string> {
    const cached = this.cached;
    if (cached && cached.orgId === orgId && Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }
    const minted = await this.client.post<AuditTokenResponse>('audit/token/', { body: {} });
    this.cached = { orgId, token: minted.token, expiresAt: Date.now() + minted.expires_in * 1000 };
    return minted.token;
  }
}
