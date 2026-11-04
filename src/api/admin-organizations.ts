import type { ApiClient } from '../http/client.js';
import type { Paginated } from './paging.js';
import { type UserSession, withUserSession } from './user-session.js';

/**
 * Organizations as an administrator manages them — ported from frontend
 * `features/role-base-access/services/admin/organizations.service.ts` with the DTOs of
 * `shared/models/role-based-access/organization.model.ts`. Backend: rbac/views/organizations.py
 * (OrganizationAdminViewSet): list / rename follow the `organizations` permission; create,
 * deactivate and reactivate are superadmin-only. An organization the caller can't read answers 404.
 *
 * Reads accept the personal API key; writes carry the user-session bearer from {@link UserSession}.
 */

/** `OrganizationResponseSerializer` (+ `admins` on the list). */
export interface AdminOrganization {
  id: number;
  name: string;
  is_active: boolean;
  member_count: number;
  config?: { audit_retention_days: number } | null;
  admins?: Array<{ id: number; email: string; display_name: string | null }>;
  created_at: string;
  updated_at: string;
}

export interface ListOrganizationsParams {
  is_active?: boolean;
  search?: string;
  page?: number;
  page_size?: number;
}

export class AdminOrganizationsApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  async list(params: ListOrganizationsParams = {}): Promise<Paginated<AdminOrganization>> {
    return this.client.get<Paginated<AdminOrganization>>('admin/organizations/', {
      query: { is_active: params.is_active, search: params.search, page: params.page, page_size: params.page_size },
    });
  }

  async create(name: string): Promise<AdminOrganization> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<AdminOrganization>('admin/organizations/', { bearerToken, body: { name } }),
    );
  }

  async rename(orgId: number, name: string): Promise<AdminOrganization> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.patch<AdminOrganization>(`admin/organizations/${orgId}/`, { bearerToken, body: { name } }),
    );
  }

  /** Every member loses access to the organization's data until it is reactivated. */
  async deactivate(orgId: number): Promise<AdminOrganization> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<AdminOrganization>(`admin/organizations/${orgId}/deactivate/`, { bearerToken, body: {} }),
    );
  }

  async reactivate(orgId: number): Promise<AdminOrganization> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<AdminOrganization>(`admin/organizations/${orgId}/reactivate/`, { bearerToken, body: {} }),
    );
  }
}
