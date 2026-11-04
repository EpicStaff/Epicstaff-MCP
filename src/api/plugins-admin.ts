import type { ApiClient } from '../http/client.js';
import type { Paginated } from './paging.js';
import type { PluginActivityEvent, PluginActivityQuery, PluginDeclaredAccess } from './plugins.js';
import { type UserSession, withUserSession } from './user-session.js';

/**
 * The superadmin's plugin administration — ported (in part) from frontend
 * `features/plugins/services/plugins-admin-api.service.ts` and the admin half of
 * `plugin-activity-api.service.ts`, with the DTOs of
 * `features/plugins/models/{plugin-admin,plugin-purge-preview,plugin-suspend-preview}.model.ts`.
 * Backend: plugins/views/admin_*.py — deployment-wide, superadmin-only and JWT-only
 * (ADMIN_PERMISSIONS = IsSuperadmin + DenyApiKeyAuth), so every call carries the user-session
 * bearer from {@link UserSession}. The organization is the grant's, never the X-Organization-Id header.
 *
 * Ported: list / detail, uninstall / reinstall with the preview of what they affect, grants (list,
 * create, suspend / resume with its preview) and a plugin's activity. Deliberately not ported (see
 * the es-admin skill): package upload / approve / reject, the irreversible purges, upgrades and
 * backups, settings / limits / runtime / restart and development mode.
 */

export type PluginState = 'uploaded' | 'provisioning' | 'running' | 'failed' | 'maintenance' | 'uninstalling' | 'purging';

export type PluginGrantState =
  | 'granting'
  | 'active'
  | 'install_failed'
  | 'upgrading'
  | 'upgrade_failed'
  | 'suspended'
  | 'purging';

/** `PluginSummary`. */
export interface PluginSummary {
  identifier: string;
  name: string;
  description: string;
  state: PluginState;
  trust: 'trusted' | 'untrusted' | null;
  current_version: string | null;
  icon_url: string | null;
  frame_origin: string;
  /** Grants in state `active`. */
  grant_count: number;
  pending_package: { id: number; version: string; trust: 'trusted' | 'untrusted' } | null;
  created_at: string;
  purge_after: string | null;
  needs_attention: boolean;
  upgrade: { to_version: string; stage: string; failed: boolean } | null;
  development: { backend_port: number | null; spa_port: number | null } | null;
}

/** The parts of `PackageReview` the MCP shows — never the icon data URLs (base64 images). */
export interface PackageReviewSummary {
  id: number;
  version: string;
  trust: 'trusted' | 'untrusted';
  signature: string;
  publisher: { name: string; url: string | null };
  contents: Record<string, unknown>;
  access: PluginDeclaredAccess[];
  user_permissions: Array<{ action: string; label: string; description: string }>;
  outbound_hosts: Array<{ host: string; reason: string }>;
  public_paths: Array<Record<string, unknown>>;
  settings: Array<{ key: string; type: string; label: string; required: boolean }>;
  warnings: Array<{ code: string; message: string }>;
  icon_data_url?: string;
  navigation?: Array<Record<string, unknown>>;
}

/** `PluginDetail`. */
export interface PluginDetail extends PluginSummary {
  current_package: PackageReviewSummary | null;
  /** What the plugin allows in its current state — the server decides. */
  allowed_actions: string[];
  uninstall_requested_at: string | null;
  purge_started_at: string | null;
  purge_progress: Record<string, unknown> | null;
  open_upgrade: Record<string, unknown> | null;
  last_upgrade: Record<string, unknown> | null;
  upgrade_hooks: { upgrading: number; upgrade_failed: number };
  development_mode: boolean;
}

/** `PluginGrant` — one organization's grant of a plugin. */
export interface PluginGrant {
  id: number;
  plugin_identifier: string;
  organization: { id: number; name: string };
  state: PluginGrantState;
  /** What the grant allows in its current state — the server decides. */
  allowed_actions: string[];
  granted_by: { id: number; email: string } | null;
  granted_at: string;
  suspended_at: string | null;
  purge_after: string | null;
  last_hook_error: string | null;
  owned_resource_count: number;
  suspension_cause: 'grant' | 'uninstall' | null;
  installed_version: string | null;
}

/** `PluginPurgePreview` — what uninstalling (or deleting) the plugin affects. */
export interface PluginPurgePreview {
  plugin: { identifier: string; name: string; state: PluginState };
  verification_phrase: string;
  data_kept_until: string;
  organizations: { total: number; items: Array<Record<string, unknown>> };
  owned_resources: Array<Record<string, unknown>>;
  data_removals_open: number;
  has_org_removed_hook: boolean;
  database: { name: string; size_bytes: number | null } | null;
  has_backend: boolean;
  has_spa: boolean;
  package_count: number;
}

/** `PluginSuspendPreview` — what suspending a grant stops in its organization. */
export type PluginSuspendPreview = Record<string, unknown>;

export interface PluginAdminActivityQuery extends Omit<PluginActivityQuery, 'plugin'> {
  organization_id?: number;
}

export class PluginsAdminApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  async list(): Promise<PluginSummary[]> {
    return this.call((bearerToken) => this.client.get<PluginSummary[]>('admin/plugins/', { bearerToken }));
  }

  async get(identifier: string): Promise<PluginDetail> {
    return this.call((bearerToken) => this.client.get<PluginDetail>(pluginPath(identifier), { bearerToken }));
  }

  /** What uninstalling or deleting the plugin affects. Read-only. */
  async purgePreview(identifier: string): Promise<PluginPurgePreview> {
    return this.call((bearerToken) =>
      this.client.get<PluginPurgePreview>(`admin/plugins/${encodeURIComponent(identifier)}/purge-preview/`, { bearerToken }),
    );
  }

  /** Take the plugin out of service everywhere; its data is kept for the grace period (409 `plugin_not_uninstallable`). */
  async uninstall(identifier: string): Promise<PluginDetail> {
    return this.call((bearerToken) => this.client.post<PluginDetail>(`admin/plugins/${encodeURIComponent(identifier)}/uninstall/`, { bearerToken }));
  }

  /** Bring an uninstalled plugin back (409 `plugin_not_uninstalling`). */
  async reinstall(identifier: string): Promise<PluginDetail> {
    return this.call((bearerToken) => this.client.post<PluginDetail>(`admin/plugins/${encodeURIComponent(identifier)}/reinstall/`, { bearerToken }));
  }

  /** One page of the plugin's grants, sorted by organization name. */
  async listGrants(identifier: string, page: number, pageSize: number): Promise<Paginated<PluginGrant>> {
    return this.call((bearerToken) =>
      this.client.get<Paginated<PluginGrant>>(`admin/plugins/${encodeURIComponent(identifier)}/grants/`, {
        bearerToken,
        query: { page, page_size: pageSize },
      }),
    );
  }

  async createGrant(identifier: string, organizationId: number): Promise<PluginGrant> {
    return this.call((bearerToken) =>
      this.client.post<PluginGrant>(`admin/plugins/${encodeURIComponent(identifier)}/grants/`, {
        bearerToken,
        body: { organization_id: organizationId },
      }),
    );
  }

  /** What suspending the grant would stop in its organization. Read-only. */
  async suspendPreview(identifier: string, grantId: number): Promise<PluginSuspendPreview> {
    return this.call((bearerToken) =>
      this.client.get<PluginSuspendPreview>(`admin/plugins/${encodeURIComponent(identifier)}/grants/${grantId}/suspend-preview/`, { bearerToken }),
    );
  }

  /** Its runs, keys and pages stop at once; its data stays for the grace period (409 `grant_not_suspendable`). */
  async suspendGrant(identifier: string, grantId: number): Promise<PluginGrant> {
    return this.call((bearerToken) => this.client.post<PluginGrant>(`admin/plugins/${encodeURIComponent(identifier)}/grants/${grantId}/suspend/`, { bearerToken }));
  }

  /** Back to `active` — or `install_failed` when its install never finished (409 `grant_not_suspended`). */
  async resumeGrant(identifier: string, grantId: number): Promise<PluginGrant> {
    return this.call((bearerToken) => this.client.post<PluginGrant>(`admin/plugins/${encodeURIComponent(identifier)}/grants/${grantId}/resume/`, { bearerToken }));
  }

  /** One page of the plugin's events in every organization and deployment-wide. */
  async listActivity(identifier: string, query: PluginAdminActivityQuery = {}): Promise<Paginated<PluginActivityEvent>> {
    return this.call((bearerToken) =>
      this.client.get<Paginated<PluginActivityEvent>>(`admin/plugins/${encodeURIComponent(identifier)}/activity/`, {
        bearerToken,
        query: {
          page: query.page,
          page_size: query.page_size,
          organization_id: query.organization_id,
          action: query.action,
        },
      }),
    );
  }

  private call<T>(request: (bearerToken: string) => Promise<T>): Promise<T> {
    return withUserSession(this.session, request);
  }
}

function pluginPath(identifier: string): string {
  return `admin/plugins/${encodeURIComponent(identifier)}/`;
}

