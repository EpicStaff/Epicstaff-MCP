import type { ApiClient } from '../http/client.js';
import type { Paginated } from './paging.js';
import type { MembershipSummary } from './profile.js';
import { withRedactedErrors } from './redaction.js';
import { type UserSession, withUserSession, withUserSessionIfAvailable } from './user-session.js';

/**
 * Workspace users — ported from frontend
 * `features/role-base-access/services/admin/admin-user.service.ts` with the DTOs of
 * `shared/models/role-based-access/admin/admin-user.model.ts`. Backend: rbac/views/users.py
 * (UserAdminViewSet) — superadmin-only and cross-org: the organization is a filter, never the
 * X-Organization-Id header.
 *
 * Reads accept the personal API key (RestrictApiKeyToUserKeyReads lets a USER key read), but it
 * sees only its own organization: reads use the user-session bearer from {@link UserSession} when
 * there is a session. Every write is JWT-only, so writes always do.
 */

/** `UserResponseSerializer`. */
export interface AdminUser {
  id: number;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  is_superadmin: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  memberships: MembershipSummary[];
}

export type AccountStatus = 'active' | 'inactive';

export interface ListAdminUsersParams {
  search?: string;
  status?: AccountStatus;
  is_superadmin?: boolean;
  role_id?: number;
  org_ids?: number[];
  page?: number;
  page_size?: number;
}

/** `UserCreateRequestSerializer`. organization_id + role_id give the account its first membership. */
export interface CreateAdminUserRequest {
  email: string;
  password: string;
  display_name?: string | null;
  organization_id?: number;
  role_id?: number;
}

/** UserPagination bounds (rbac/views/users.py). */
export const ADMIN_PAGE_SIZE_MAX = 200;

export class AdminUsersApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  /**
   * Intentional divergence: the frontend sends `is_active=` here, which the backend ignores; the
   * account-state filter UserValidationService.validate_list_users_query reads is `status`.
   */
  async list(params: ListAdminUsersParams = {}): Promise<Paginated<AdminUser>> {
    return withUserSessionIfAvailable(this.session, (bearerToken) =>
      this.client.get<Paginated<AdminUser>>('admin/users/', {
        bearerToken,
        query: {
          search: params.search,
          status: params.status,
          is_superadmin: params.is_superadmin,
          role_id: params.role_id,
          org_ids: params.org_ids?.length ? params.org_ids.join(',') : undefined,
          page: params.page,
          page_size: params.page_size,
        },
      }),
    );
  }

  /** Create an account. The password never reaches an error message (see withRedactedErrors). */
  async create(request: CreateAdminUserRequest): Promise<AdminUser> {
    return withRedactedErrors([{ field: 'password', value: request.password }], () =>
      withUserSession(this.session, (bearerToken) =>
        this.client.post<AdminUser>('admin/users/', { bearerToken, body: request }),
      ),
    );
  }

  async grantSuperadmin(userId: number): Promise<AdminUser> {
    return this.action(userId, 'grant-superadmin');
  }

  async revokeSuperadmin(userId: number): Promise<AdminUser> {
    return this.action(userId, 'revoke-superadmin');
  }

  /** The account can no longer sign in; its sessions and API keys stop working. */
  async deactivate(userId: number): Promise<AdminUser> {
    return this.action(userId, 'deactivate');
  }

  async reactivate(userId: number): Promise<AdminUser> {
    return this.action(userId, 'reactivate');
  }

  private async action(userId: number, action: string): Promise<AdminUser> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<AdminUser>(`admin/users/${userId}/${action}/`, { bearerToken, body: {} }),
    );
  }
}
