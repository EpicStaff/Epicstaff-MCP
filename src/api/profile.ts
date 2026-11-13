import type { ApiClient } from '../http/client.js';
import { type UserSession, withUserSession, withUserSessionIfAvailable } from './user-session.js';

/**
 * The signed-in user's own account — ported from frontend `services/auth/profile.service.ts`
 * (profile, own API keys) and `services/auth/permissions.service.ts` (effective permissions, the
 * permission catalog), with the DTOs of `shared/models/auth/api-keys.model.ts` and
 * `shared/models/role-based-access/{membership,permissions}.model.ts`.
 * Backend: rbac/views/{profile,api_keys,permissions}.py.
 *
 * `profile/api-keys/` is closed to API keys (DenyApiKeyAuth — a credential must not mint, list or
 * retire credentials), so those calls carry the user-session bearer from {@link UserSession}. The
 * profile and per-org permission reads use it too when there is a session: a user API key sees only
 * its own organization there.
 */

export interface NamedRef {
  id: number;
  name: string;
}

/** `MembershipNestedSerializer` (rbac/serializers/users.py). */
export interface MembershipSummary {
  id: number;
  organization: NamedRef & { is_active?: boolean };
  role: NamedRef;
  joined_at: string;
}

/** resource_type → action codes, e.g. `{ flows: ['read', 'use'] }`. */
export type PermissionMap = Record<string, string[]>;

/** `ProfileResponseSerializer` — the fields MCP reads. */
export interface Profile {
  id: number;
  email: string;
  display_name: string | null;
  is_superadmin: boolean;
  is_active: boolean;
  created_at?: string;
  memberships: MembershipSummary[];
  active_organization_id: number | null;
  active_permissions: '*' | PermissionMap | null;
}

export interface UpdateProfileRequest {
  /** Trimmed by the backend; null derives it from the email. */
  display_name?: string | null;
}

/** `ActivePermissions` — `GET permissions/me/` for the active organization. */
export interface ActivePermissions {
  org_id: number;
  is_superadmin: boolean;
  role: NamedRef | null;
  permissions: '*' | PermissionMap;
}

export interface OrgCapability {
  org: NamedRef;
  role: NamedRef | null;
  permissions: PermissionMap;
}

/** `MyOrgPermissionsResponse` — superadmin: `{ is_superadmin: true, permissions: '*' }`, else `orgs`. */
export interface MyOrgPermissions {
  is_superadmin: boolean;
  orgs?: OrgCapability[];
  permissions?: '*';
}

/** `CatalogResponse` — the static permission taxonomy roles are built from. */
export interface PermissionCatalog {
  actions: Array<{ code: string; label: string; bit: number }>;
  resource_types: Array<{
    code: string;
    label: string;
    group: string;
    description: string;
    applicable_actions: string[];
    /** Superadmin-only actions that no role can grant (`organizations`: create, delete). */
    platform_actions: string[];
    recommended_with: Record<string, Array<{ resource_type: string; action: string }>>;
  }>;
}

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

/** `GetMyApiKeyResponse` — never carries the key itself, only its prefix. */
export interface ApiKeyDto {
  id: number;
  name: string;
  /** The organization the key is bound to — it works only there. */
  org_id: number;
  org_name: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  status: ApiKeyStatus;
}

/** `CreateApiKeyResponse` — the raw `api_key` is in this response only; the server keeps a hash. */
export interface CreatedApiKey extends ApiKeyDto {
  api_key: string;
}

/** Backend bounds of `expires_in_days` (ApiKeyCreateRequestSerializer); omitted = 90 days, null = never. */
export const API_KEY_MAX_EXPIRES_IN_DAYS = 3650;

/** Characters of the raw key the backend keeps and lists as `prefix` (rbac ApiKeyGenerator.PREFIX_LENGTH). */
export const API_KEY_PREFIX_LENGTH = 12;

/** The listed `prefix` of a raw key — how a key the MCP holds is recognised in a key list. */
export function apiKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, API_KEY_PREFIX_LENGTH);
}

export class ProfileApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  async getProfile(): Promise<Profile> {
    return withUserSessionIfAvailable(this.session, (bearerToken) => this.client.get<Profile>('profile/', { bearerToken }));
  }

  async updateProfile(changes: UpdateProfileRequest): Promise<Profile> {
    return this.client.patch<Profile>('profile/', { body: changes });
  }

  /** Effective permissions in the active organization (X-Organization-Id). */
  async getActivePermissions(): Promise<ActivePermissions> {
    return this.client.get<ActivePermissions>('permissions/me/');
  }

  /** Effective permissions in every organization the user belongs to. */
  async getOrgPermissions(): Promise<MyOrgPermissions> {
    return withUserSessionIfAvailable(this.session, (bearerToken) =>
      this.client.get<MyOrgPermissions>('permissions/me/orgs/', { bearerToken }),
    );
  }

  async getPermissionCatalog(): Promise<PermissionCatalog> {
    return this.client.get<PermissionCatalog>('permissions/catalog/');
  }

  async listApiKeys(): Promise<ApiKeyDto[]> {
    return withUserSession(this.session, (bearerToken) => this.client.get<ApiKeyDto[]>('profile/api-keys/', { bearerToken }));
  }

  /**
   * Mint a personal API key, bound to organization `orgId` (it works only there). The response
   * holds the raw key exactly once — callers must hand it to its destination immediately and
   * never log or return it.
   */
  async createApiKey(name: string, orgId: number, expiresInDays: number | null | undefined): Promise<CreatedApiKey> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<CreatedApiKey>('profile/api-keys/', {
        bearerToken,
        // Omitting expires_in_days selects the backend's 90-day default; null means "never expires".
        body: { name, org_id: orgId, ...(expiresInDays !== undefined ? { expires_in_days: expiresInDays } : {}) },
      }),
    );
  }

  /** Retire a key: it stops authenticating at once and stays listed as `revoked`. */
  async revokeApiKey(id: number): Promise<ApiKeyDto> {
    return withUserSession(this.session, (bearerToken) =>
      this.client.post<ApiKeyDto>(`profile/api-keys/${id}/revoke/`, { bearerToken, body: {} }),
    );
  }
}
