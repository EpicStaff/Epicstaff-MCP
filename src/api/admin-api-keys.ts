import type { ApiClient } from '../http/client.js';
import type { Paginated } from './paging.js';
import type { ApiKeyDto, ApiKeyStatus } from './profile.js';
import { type UserSession, withUserSession } from './user-session.js';

/**
 * Everyone's API keys, as an administrator sees them — ported from frontend
 * `features/role-base-access/services/admin/api-keys.service.ts` with the DTOs of
 * `shared/models/auth/api-keys.model.ts`. Backend: rbac/views/api_keys_admin.py (ApiKeyAdminViewSet)
 * — cross-org, `api_keys` permission, and JWT-only for reads too (DenyApiKeyAuth: a credential must
 * not list or retire credentials), so every call carries the user-session bearer.
 */

/** `GetApiKeyWithOwnerResponse` — never the key itself, only its prefix. */
export interface AdminApiKey extends ApiKeyDto {
  owner: { id: number; email: string; display_name: string | null; avatar_url: string | null } | null;
  /** The owner's organizations the caller can see. */
  org_ids: number[];
}

export interface ListAdminApiKeysParams {
  /** Owner user id. */
  user?: number;
  status?: ApiKeyStatus;
  /** Key name or prefix (not the owner — filter by `user`). */
  search?: string;
  org_ids?: number[];
  page?: number;
  page_size?: number;
}

export class AdminApiKeysApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  async list(params: ListAdminApiKeysParams = {}): Promise<Paginated<AdminApiKey>> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.get<Paginated<AdminApiKey>>('admin/api-keys/', {
        bearerToken,
        query: {
          user: params.user,
          status: params.status,
          search: params.search,
          org_ids: params.org_ids?.length ? params.org_ids.join(',') : undefined,
          page: params.page,
          page_size: params.page_size,
        },
      }),
    );
  }

  /** Retire a key (authorised by `api_keys` delete): it stops authenticating at once. */
  async revoke(keyId: number): Promise<AdminApiKey> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<AdminApiKey>(`admin/api-keys/${keyId}/revoke/`, { bearerToken, body: {} }),
    );
  }
}
