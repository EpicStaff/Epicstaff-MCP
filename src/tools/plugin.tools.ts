import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AdminOrganizationsApi } from '../api/admin-organizations.js';
import { PLUGIN_ACTIVITY_PAGE_SIZE_MAX, type PluginActivityEvent, PluginsApi } from '../api/plugins.js';
import {
  type PackageReviewSummary,
  type PluginDetail,
  type PluginGrant,
  PluginsAdminApi,
  type PluginSummary,
} from '../api/plugins-admin.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import {
  assertConfirmed,
  confirmFlag,
  explainRefusals,
  organizationRef,
  pageOf,
  requireSignedInSession,
  resolveOrganizationId,
} from './admin-helpers.js';
import { runTool } from './auth-org.tools.js';

/**
 * EpicStaff plugins: apps a superadmin installs once for the deployment and grants to organizations.
 * Members open them from EpicStaff's sidebar; a plugin backend calls EpicStaff's API as the plugin's
 * service account in each organization it is granted to, within the access its manifest declares.
 *
 * Plugins add no flow node types — a flow has no plugin node, and flow source has no plugin key. The
 * "plugin node" of the backend (shared/models/plugin_nodes.py) is the host that runs plugin backends.
 *
 * Discovery is open to members (and `audit: read` for activity); administration is superadmin-only
 * and needs a signed-in session. Not exposed: package upload / approval (installing third-party code
 * is reviewed by a person in the UI), the irreversible purges, upgrades, backups, settings, limits,
 * restarts and development mode.
 */

const PLUGINS_OFF =
  'the plugin platform is switched off on this deployment (PLUGINS_ENABLED) or no such plugin / grant exists';
const SUPERADMIN = 'superadmin rights and a signed-in session';
const PLUGIN_GRANT_PAGE_SIZE = 200;

const pluginIdentifier = z.string().min(1).max(100).describe('Plugin identifier, e.g. "weather" (list_plugins / admin_list_plugins).');

function summarizePlugin(plugin: PluginSummary): Record<string, unknown> {
  return {
    identifier: plugin.identifier,
    name: plugin.name,
    description: plugin.description,
    state: plugin.state,
    trust: plugin.trust,
    current_version: plugin.current_version,
    active_grants: plugin.grant_count,
    needs_attention: plugin.needs_attention,
    ...(plugin.pending_package ? { pending_package: plugin.pending_package } : {}),
    ...(plugin.upgrade ? { upgrade: plugin.upgrade } : {}),
    ...(plugin.purge_after ? { data_deleted_after: plugin.purge_after } : {}),
  };
}

/** What a package declares, by whitelist — the review also carries base64 icon images the model never needs. */
function summarizePackage(review: PackageReviewSummary): Record<string, unknown> {
  return {
    version: review.version,
    trust: review.trust,
    signature: review.signature,
    publisher: review.publisher,
    contents: review.contents,
    access: review.access.map((entry) => ({ resource_type: entry.resource_type, actions: entry.actions, reason: entry.reason })),
    user_permissions: review.user_permissions.map((permission) => ({ action: permission.action, label: permission.label })),
    outbound_hosts: review.outbound_hosts,
    public_paths: review.public_paths,
    settings: review.settings.map((setting) => ({ key: setting.key, type: setting.type, label: setting.label, required: setting.required })),
    warnings: review.warnings,
  };
}

function summarizeDetail(detail: PluginDetail): Record<string, unknown> {
  return {
    ...summarizePlugin(detail),
    allowed_actions: detail.allowed_actions,
    ...(detail.current_package ? { current_package: summarizePackage(detail.current_package) } : {}),
    ...(detail.uninstall_requested_at ? { uninstall_requested_at: detail.uninstall_requested_at } : {}),
    ...(detail.purge_progress ? { purge_progress: detail.purge_progress } : {}),
    ...(detail.open_upgrade ? { open_upgrade: detail.open_upgrade } : {}),
  };
}

function summarizeGrant(grant: PluginGrant): Record<string, unknown> {
  return {
    id: grant.id,
    organization: grant.organization,
    state: grant.state,
    allowed_actions: grant.allowed_actions,
    installed_version: grant.installed_version,
    granted_at: grant.granted_at,
    granted_by: grant.granted_by?.email ?? null,
    owned_resource_count: grant.owned_resource_count,
    ...(grant.suspended_at ? { suspended_at: grant.suspended_at, suspension_cause: grant.suspension_cause } : {}),
    ...(grant.purge_after ? { data_deleted_after: grant.purge_after } : {}),
    ...(grant.last_hook_error ? { last_hook_error: grant.last_hook_error } : {}),
  };
}

function summarizeEvent(event: PluginActivityEvent): Record<string, unknown> {
  return {
    id: event.id,
    at: event.created_at,
    plugin: event.plugin.identifier,
    organization: event.organization,
    actor: event.actor.label,
    ...(event.on_behalf_of ? { on_behalf_of: event.on_behalf_of.label } : {}),
    action: event.action,
    ...(event.request ? { request: event.request } : {}),
    ...(event.target ? { target: event.target } : {}),
    ...(Object.keys(event.detail).length > 0 ? { detail: event.detail } : {}),
  };
}

export function registerPluginTools(server: McpServer, context: AppContext): void {
  const plugins = new PluginsApi(context.client);
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const admin = (): PluginsAdminApi => new PluginsAdminApi(context.client, context.auth);
  const orgId = (ref: number | string): Promise<number> =>
    resolveOrganizationId(context, new AdminOrganizationsApi(context.client, context.auth), ref);

  /** The grant of `identifier` in an organization, looked for page by page. */
  async function findGrant(api: PluginsAdminApi, identifier: string, organization: number | string): Promise<PluginGrant> {
    const organizationId = await orgId(organization);
    for (let page = 1; ; page += 1) {
      const listed = await api.listGrants(identifier, page, PLUGIN_GRANT_PAGE_SIZE);
      const match = listed.results.find((grant) => grant.organization.id === organizationId);
      if (match) return match;
      if (!listed.next) break;
    }
    throw new Error(`Plugin "${identifier}" is not granted to organization ${organizationId} (admin_list_plugins with plugin).`);
  }

  server.registerTool(
    'list_plugins',
    {
      title: 'List plugins of the active organization',
      description:
        'The plugins (apps) you may open in the active organization, with your permissions in each and whether it ' +
        'is ready or in maintenance. include_service_accounts: true adds the plugin backends acting in the ' +
        'organization and what each may do there (resource → actions, outbound hosts) — needs `audit: read`. ' +
        'Plugins add no flow node types.',
      inputSchema: {
        include_service_accounts: z.boolean().default(false),
      },
    },
    async ({ include_service_accounts }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return explainRefusals({ action: 'list plugins', requirement: 'membership of the active organization', notFound: PLUGINS_OFF }, async () => {
          const available = await plugins.listAvailable();
          const result: Record<string, unknown> = {
            plugins: available.map((plugin) => ({
              identifier: plugin.identifier,
              name: plugin.name,
              description: plugin.description,
              availability: plugin.availability,
              your_permissions: plugin.permissions,
              ...(plugin.development ? { development: true } : {}),
            })),
          };
          if (include_service_accounts) {
            try {
              result.service_accounts = (await plugins.listServiceAccounts()).map((account) => ({
                plugin: account.plugin.identifier,
                grant_state: account.grant_state,
                key_last_used_at: account.key_last_used_at,
                access: account.access.map((entry) => ({ resource_type: entry.resource_type, actions: entry.actions, reason: entry.reason })),
                outbound_hosts: account.outbound_hosts,
                has_database: account.has_database,
              }));
            } catch (error) {
              if (!(error instanceof ApiError && error.status === 403)) throw error;
              result.service_accounts = 'not available — needs the `audit: read` permission in this organization';
            }
          }
          return result;
        });
      }),
  );

  server.registerTool(
    'list_plugin_activity',
    {
      title: 'List plugin activity',
      description:
        "What plugins did and what was done to them, newest first: their service accounts' API requests, grants, " +
        'install hooks, suspensions, upgrades. Default: the active organization (needs `audit: read`). ' +
        'all_organizations: true (superadmin, signed-in session, plugin required) shows one plugin in every ' +
        'organization plus deployment-wide events.',
      inputSchema: {
        plugin: pluginIdentifier.optional(),
        action: z.string().optional().describe('Only this action, e.g. "api_request", "grant_suspended", "install_hook_failed".'),
        all_organizations: z.boolean().default(false),
        organization: organizationRef.optional().describe('With all_organizations: only this organization.'),
        page: z.number().int().min(1).default(1),
        page_size: z.number().int().min(1).max(PLUGIN_ACTIVITY_PAGE_SIZE_MAX).default(50),
      },
    },
    async ({ plugin, action, all_organizations, organization, page, page_size }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        if (all_organizations) {
          requireSignedInSession(context, 'Reading plugin activity across organizations');
          if (plugin === undefined) throw new Error('all_organizations needs plugin: the deployment-wide view is per plugin.');
          return explainRefusals({ action: 'read the plugin activity', requirement: SUPERADMIN, notFound: PLUGINS_OFF }, async () => {
            const organizationId = organization !== undefined ? await orgId(organization) : undefined;
            const listed = await admin().listActivity(plugin, { page, page_size, organization_id: organizationId, action });
            return pageOf(listed, page, summarizeEvent);
          });
        }
        if (organization !== undefined) throw new Error('organization filters all_organizations only; the default view is the active organization.');
        await context.org.requireActiveOrg();
        return explainRefusals(
          { action: 'read the plugin activity', requirement: 'the `audit: read` permission in the active organization', notFound: PLUGINS_OFF },
          async () => pageOf(await plugins.listActivity({ page, page_size, plugin, action }), page, summarizeEvent),
        );
      }),
  );

  server.registerTool(
    'admin_list_plugins',
    {
      title: 'List installed plugins (superadmin)',
      description:
        'Every plugin on the deployment with its state, version, trust and active grants. With plugin: its details ' +
        '— what its package declares (access to EpicStaff resources, outbound hosts, public paths, settings, review ' +
        'warnings), the actions its state allows, and its grants to organizations. Superadmin, signed-in session.',
      inputSchema: {
        plugin: pluginIdentifier.optional(),
        grants_page: z.number().int().min(1).default(1).describe('With plugin: page of its grants.'),
      },
    },
    async ({ plugin, grants_page }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Administering plugins');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'list plugins', requirement: SUPERADMIN, notFound: PLUGINS_OFF }, async () => {
          const api = admin();
          if (plugin === undefined) return { plugins: (await api.list()).map(summarizePlugin) };
          const [detail, grants] = await Promise.all([api.get(plugin), api.listGrants(plugin, grants_page, 50)]);
          return { plugin: summarizeDetail(detail), grants: pageOf(grants, grants_page, summarizeGrant) };
        });
      }),
  );

  server.registerTool(
    'admin_grant_plugin',
    {
      title: 'Grant a plugin to an organization (superadmin)',
      description:
        "Make an installed plugin available in an organization: its members can open it, and its backend's service " +
        'account may act there within the access the plugin declares (admin_list_plugins with plugin shows it) — ' +
        'review that first. Superadmin, signed-in session. Requires confirm: true.',
      inputSchema: {
        plugin: pluginIdentifier,
        organization: organizationRef.describe('The organization: id or name.'),
        confirm: confirmFlag('grant this plugin to the organization'),
      },
    },
    async ({ plugin, organization }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Granting a plugin');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'grant the plugin', requirement: SUPERADMIN, notFound: PLUGINS_OFF }, async () => ({
          grant: summarizeGrant(await admin().createGrant(plugin, await orgId(organization))),
        }));
      }),
  );

  server.registerTool(
    'admin_set_plugin_grant_state',
    {
      title: "Suspend or resume a plugin's grant (superadmin)",
      description:
        'state "suspended": the plugin stops in that organization at once — its runs, keys and pages — and its data ' +
        'there is kept only for the grace period; "active" resumes it. dry_run: true (suspend only) reports what ' +
        'suspending would stop. Superadmin, signed-in session. The real change requires confirm: true.',
      inputSchema: {
        plugin: pluginIdentifier,
        organization: organizationRef.describe('The organization of the grant: id or name.'),
        state: z.enum(['suspended', 'active']),
        dry_run: z.boolean().default(false),
        confirm: z.literal(true).optional().describe('Required unless dry_run: the user explicitly asked for this change.'),
      },
    },
    async ({ plugin, organization, state, dry_run, confirm }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Changing a plugin grant');
        await context.auth.ensureAuthenticated();
        if (dry_run && state !== 'suspended') throw new Error('dry_run previews a suspension only.');
        if (!dry_run) assertConfirmed(confirm, state === 'suspended' ? 'suspend a plugin grant' : 'resume a plugin grant');
        return explainRefusals(
          { action: state === 'suspended' ? 'suspend the grant' : 'resume the grant', requirement: SUPERADMIN, notFound: PLUGINS_OFF },
          async () => {
            const api = admin();
            const grant = await findGrant(api, plugin, organization);
            if (dry_run) return { dry_run: true, grant: summarizeGrant(grant), would_stop: await api.suspendPreview(plugin, grant.id) };
            const updated = state === 'suspended' ? await api.suspendGrant(plugin, grant.id) : await api.resumeGrant(plugin, grant.id);
            return { grant: summarizeGrant(updated) };
          },
        );
      }),
  );

  server.registerTool(
    'admin_uninstall_plugin',
    {
      title: 'Uninstall a plugin (superadmin)',
      description:
        'Take a plugin out of service in EVERY organization at once (pages, backend, service accounts stop); its ' +
        'data is kept until data_kept_until, so admin_reinstall_plugin can bring it back until then — after that it ' +
        'is deleted for good. dry_run: true reports the organizations and data affected. Superadmin, signed-in ' +
        'session. The real uninstall requires confirm: true.',
      inputSchema: {
        plugin: pluginIdentifier,
        dry_run: z.boolean().default(false),
        confirm: z.literal(true).optional().describe('Required unless dry_run: the user explicitly asked to uninstall this plugin.'),
      },
    },
    async ({ plugin, dry_run, confirm }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Uninstalling a plugin');
        await context.auth.ensureAuthenticated();
        if (!dry_run) assertConfirmed(confirm, 'uninstall a plugin');
        return explainRefusals({ action: 'uninstall the plugin', requirement: SUPERADMIN, notFound: PLUGINS_OFF }, async () => {
          const api = admin();
          const { verification_phrase: _phrase, ...preview } = await api.purgePreview(plugin);
          if (dry_run) return { dry_run: true, affects: preview };
          return { plugin: summarizeDetail(await api.uninstall(plugin)), data_kept_until: preview.data_kept_until };
        });
      }),
  );

  server.registerTool(
    'admin_reinstall_plugin',
    {
      title: 'Reinstall an uninstalled plugin (superadmin)',
      description:
        'Bring back a plugin uninstalled with admin_uninstall_plugin while its data is still kept: the grants the ' +
        'uninstall suspended resume (grants suspended on their own stay suspended). Superadmin, signed-in session. ' +
        'Requires confirm: true.',
      inputSchema: {
        plugin: pluginIdentifier,
        confirm: confirmFlag('reinstall this plugin'),
      },
    },
    async ({ plugin }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Reinstalling a plugin');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'reinstall the plugin', requirement: SUPERADMIN, notFound: PLUGINS_OFF }, async () => ({
          plugin: summarizeDetail(await admin().reinstall(plugin)),
        }));
      }),
  );
}
