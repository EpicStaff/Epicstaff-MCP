import type { ApiClient } from '../http/client.js';
import type { Paginated } from './paging.js';

/**
 * Plugins as a member of the active organization sees them — ported from frontend
 * `features/plugins/services/available-plugins-api.service.ts` and
 * `features/plugins/services/plugin-activity-api.service.ts`, with the DTOs of
 * `features/plugins/models/{available-plugin,plugin-activity}.model.ts`.
 * Backend: plugins/views/{available_plugins,activity}.py — org-scoped (X-Organization-Id).
 *
 * A plugin is an app installed deployment-wide by a superadmin and granted to organizations: a
 * frontend shown in EpicStaff's sidebar, optionally a backend that calls EpicStaff's API as the
 * plugin's service account within the access its manifest declares. With the plugin platform off
 * (PLUGINS_ENABLED) every plugin route answers 404.
 */

/** A plugin user permission. */
export type PluginAction = 'read' | 'create' | 'update' | 'delete' | 'export' | 'use';

/** `AvailablePlugin` — a plugin the caller may open in the active organization. */
export interface AvailablePlugin {
  identifier: string;
  name: string;
  description: string;
  icon_url: string;
  frame_origin: string;
  /** Always contains `read`. */
  permissions: PluginAction[];
  /** `maintenance`: being updated; it can't be opened until then. */
  availability: 'ready' | 'maintenance';
  development: boolean;
  navigation: Array<{ label: string; path: string; icon_url: string }>;
}

/** `PluginActivityEvent` — what a plugin did, or what was done to it. `detail` never holds a secret. */
export interface PluginActivityEvent {
  id: number;
  created_at: string;
  plugin: { identifier: string; name: string | null };
  organization: { id: number; name: string | null } | null;
  actor: { kind: 'plugin' | 'superadmin' | 'platform'; label: string };
  on_behalf_of: { user_id: number | null; label: string } | null;
  action: string;
  request: { method: string; path: string; route: string | null; status: number } | null;
  target: { resource_type: string | null; id: string | null; label: string | null } | null;
  detail: Record<string, unknown>;
}

/** `PluginDeclaredAccess` — what a plugin's service account may do in an organization. */
export interface PluginDeclaredAccess {
  resource_type: string;
  resource_label: string;
  actions: PluginAction[];
  reason: string;
}

/** `OrganizationServiceAccount` — a plugin backend acting in the active organization. */
export interface OrganizationServiceAccount {
  plugin: { identifier: string; name: string; icon_url: string };
  grant_state: string;
  created_at: string;
  key_last_used_at: string | null;
  access: PluginDeclaredAccess[];
  outbound_hosts: Array<{ host: string; reason: string }>;
  has_database: boolean;
}

export interface PluginActivityQuery {
  page?: number;
  page_size?: number;
  plugin?: string;
  action?: string;
}

/** ActivityPagination bounds (plugins/views/activity.py). */
export const PLUGIN_ACTIVITY_PAGE_SIZE_MAX = 200;

export class PluginsApi {
  constructor(private readonly client: ApiClient) {}

  /** The plugins the caller may open in the active organization (empty for a non-member superadmin). */
  async listAvailable(): Promise<AvailablePlugin[]> {
    return this.client.get<AvailablePlugin[]>('plugins/available/');
  }

  /** One page of the active organization's plugin events, newest first (`audit: read`). */
  async listActivity(query: PluginActivityQuery = {}): Promise<Paginated<PluginActivityEvent>> {
    return this.client.get<Paginated<PluginActivityEvent>>('plugins/activity/', {
      query: { page: query.page, page_size: query.page_size, plugin: query.plugin, action: query.action },
    });
  }

  /** The plugin backends acting in the active organization and their declared access (`audit: read`). */
  async listServiceAccounts(): Promise<OrganizationServiceAccount[]> {
    return this.client.get<OrganizationServiceAccount[]>('plugins/service-accounts/');
  }
}
