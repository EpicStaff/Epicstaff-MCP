import type { ApiClient } from '../http/client.js';
import type { AccountStatus } from './admin-users.js';
import type { Paginated } from './paging.js';
import type { NamedRef } from './profile.js';
import { type UserSession, withUserSession, withUserSessionIfAvailable } from './user-session.js';

/**
 * Organization memberships — ported from frontend
 * `features/role-base-access/services/admin/memberships.service.ts` with the DTOs of
 * `shared/models/role-based-access/admin/admin-membership.model.ts`. Backend: rbac/views/memberships.py
 * (MembershipAdminViewSet) — cross-org and permission-gated (`memberships` permission in the target
 * organization); MembershipManagementService enforces the invariants (an organization keeps an
 * admin, the role ceiling). It links EXISTING accounts — creating an account is the superadmin's
 * admin/users/.
 *
 * Reads accept the personal API key, but it sees only its own organization: reads use the
 * user-session bearer from {@link UserSession} when there is a session; writes always do.
 */

/** `MembershipResponseSerializer`. */
export interface AdminMembership {
  id: number;
  org: NamedRef;
  user: { id: number; email: string; display_name: string | null; avatar_url: string | null; is_active: boolean };
  role: NamedRef;
  joined_at: string;
}

export interface ListMembershipsParams {
  org_ids?: number[];
  role_id?: number;
  status?: AccountStatus;
  search?: string;
  page?: number;
  page_size?: number;
}

/** Exactly one of `email` / `user_id` names the account. */
export interface CreateMembershipRequest {
  org_id: number;
  role_id: number;
  email?: string;
  user_id?: number;
}

export class AdminMembershipsApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  async list(params: ListMembershipsParams = {}): Promise<Paginated<AdminMembership>> {
    return withUserSessionIfAvailable(this.session, (bearerToken) =>
      this.client.get<Paginated<AdminMembership>>('admin/memberships/', {
        bearerToken,
        query: {
          org_ids: params.org_ids?.length ? params.org_ids.join(',') : undefined,
          role_id: params.role_id,
          status: params.status,
          search: params.search,
          page: params.page,
          page_size: params.page_size,
        },
      }),
    );
  }

  async create(request: CreateMembershipRequest): Promise<AdminMembership> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<AdminMembership>('admin/memberships/', { bearerToken, body: request }),
    );
  }

  async changeRole(membershipId: number, roleId: number): Promise<AdminMembership> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.patch<AdminMembership>(`admin/memberships/${membershipId}/`, { bearerToken, body: { role_id: roleId } }),
    );
  }

  /** Remove the user from the organization; the account itself stays. */
  async remove(membershipId: number): Promise<void> {
    await withUserSession(this.session, (bearerToken) =>
      this.client.delete<void>(`admin/memberships/${membershipId}/`, { bearerToken }),
    );
  }
}
