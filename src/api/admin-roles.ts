import type { ApiClient } from '../http/client.js';
import type { Paginated } from './paging.js';
import type { NamedRef } from './profile.js';
import { type UserSession, withUserSession, withUserSessionIfAvailable } from './user-session.js';

/**
 * Roles — ported from frontend `features/role-base-access/services/admin/roles.service.ts` with the
 * DTOs of `shared/models/role-based-access/roles.model.ts`. Backend: rbac/views/roles.py
 * (RoleAdminViewSet) — cross-org and permission-gated: the door gate needs `roles` permission in
 * some organization, RoleManagementService checks the target organization and the ceiling rule (a
 * role can't grant more than its author holds). A role of an organization the caller can't read
 * answers 404.
 *
 * Reads accept the personal API key, but it sees only its own organization: reads use the
 * user-session bearer from {@link UserSession} when there is a session. Writes — the dry-run delete
 * included, DELETE is not a safe method — always do.
 */

export interface RolePermission {
  resource_type: string;
  actions: string[];
}

/** `RoleResponseSerializer`. Built-in roles are templates shared by every organization. */
export interface RoleDto {
  id: number;
  name: string;
  description: string | null;
  is_built_in: boolean;
  scope: 'global' | 'org';
  org_id: number | null;
  org: NamedRef | null;
  assigned_count: number;
  permissions: RolePermission[];
}

/** `GET admin/roles/`: custom roles paged in `results`, built-ins always complete. */
export interface RolesListResponse extends Paginated<RoleDto> {
  built_in_roles: RoleDto[];
}

export interface ListRolesParams {
  org_ids?: number[];
  /** Only roles assignable in these organizations (also scopes the list to them). */
  assignable_org_ids?: number[];
  search?: string;
  page?: number;
  page_size?: number;
}

export interface CreateRoleRequest {
  org_id: number;
  name: string;
  description?: string | null;
  permissions: RolePermission[];
}

export interface UpdateRoleRequest {
  name?: string;
  description?: string | null;
  /** Replaces the whole permission set. */
  permissions?: RolePermission[];
}

/** `DELETE admin/roles/{id}/?dry_run=true` — the members a delete reassigns to the built-in Viewer role. */
export interface DeleteRolePreview {
  role_id: number;
  assigned_count: number;
  affected_users: Array<{ user_id: number; email: string; display_name: string | null }>;
}

export interface DeleteRoleResult {
  reassigned_count: number;
}

export class AdminRolesApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  async list(params: ListRolesParams = {}): Promise<RolesListResponse> {
    return withUserSessionIfAvailable(this.session, (bearerToken) =>
      this.client.get<RolesListResponse>('admin/roles/', {
        bearerToken,
        query: {
          org_ids: params.org_ids?.length ? params.org_ids.join(',') : undefined,
          assignable_org_ids: params.assignable_org_ids?.length ? params.assignable_org_ids.join(',') : undefined,
          search: params.search,
          page: params.page,
          page_size: params.page_size,
        },
      }),
    );
  }

  async get(roleId: number): Promise<RoleDto> {
    return withUserSessionIfAvailable(this.session, (bearerToken) => this.client.get<RoleDto>(`admin/roles/${roleId}/`, { bearerToken }));
  }

  async create(request: CreateRoleRequest): Promise<RoleDto> {
    return withUserSession(this.session, (bearerToken) => this.client.post<RoleDto>('admin/roles/', { bearerToken, body: request }));
  }

  async update(roleId: number, changes: UpdateRoleRequest): Promise<RoleDto> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.patch<RoleDto>(`admin/roles/${roleId}/`, { bearerToken, body: changes }),
    );
  }

  async previewDelete(roleId: number): Promise<DeleteRolePreview> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.delete<DeleteRolePreview>(`admin/roles/${roleId}/`, { bearerToken, query: { dry_run: 'true' } }),
    );
  }

  /** Delete for good; its members fall back to the built-in Viewer role. */
  async delete(roleId: number): Promise<DeleteRoleResult> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.delete<DeleteRoleResult>(`admin/roles/${roleId}/`, { bearerToken }),
    );
  }
}
