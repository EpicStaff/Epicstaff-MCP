import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type AdminApiKey, AdminApiKeysApi } from '../api/admin-api-keys.js';
import { type AdminMembership, AdminMembershipsApi } from '../api/admin-memberships.js';
import { type AdminOrganization, AdminOrganizationsApi } from '../api/admin-organizations.js';
import { AdminRolesApi, type RolePermission } from '../api/admin-roles.js';
import { ADMIN_PAGE_SIZE_MAX, type AdminUser, AdminUsersApi } from '../api/admin-users.js';
import { ProfileApi, apiKeyPrefix } from '../api/profile.js';
import type { AppContext } from '../context.js';
import { logger } from '../util/logger.js';
import { assertNewSecretFilePath, writeNewSecretFile } from '../util/secret-file.js';
import {
  assertConfirmed,
  confirmFlag,
  explainRefusals,
  organizationRef,
  pageOf,
  requireSignedInSession,
  resolveOrganizationId,
  resolveRoleId,
  resolveUserId,
  roleRef,
  summarizeRole,
  userRef,
} from './admin-helpers.js';
import { runTool } from './auth-org.tools.js';

/**
 * Workspace administration (EpicStaff `/api/admin/**`): users, organization memberships, roles, every
 * user's API keys and organizations. Cross-org — the organization is an argument, not the active
 * organization. Reads work with the MCP's API key; every change needs a signed-in session and
 * confirm: true. Records of organizations the caller can't administer answer 404, never 403.
 *
 * Deliberately not exposed: hard deletes of users and organizations (irreversible; the UI makes a
 * human type a verification phrase the server derives from the name — an agent would just fill it
 * in), the admin password reset, and the per-type retention settings.
 */

const SUPERADMIN = 'superadmin rights';
const ACCOUNT_STATUSES = ['active', 'inactive'] as const;

const pageShape = {
  page: z.number().int().min(1).default(1).describe('Page number (1-based).'),
  page_size: z.number().int().min(1).max(ADMIN_PAGE_SIZE_MAX).default(50).describe(`Page size (max ${ADMIN_PAGE_SIZE_MAX}).`),
};

/** A role's permissions as a tool argument: resource type → actions. */
const permissionMapSchema = z
  .record(z.string().min(1), z.array(z.string().min(1)))
  .describe(
    'Resource type → actions, e.g. { "flows": ["read", "use"], "agents": ["read"] }. Resource types and the ' +
      'actions each accepts: admin_list_roles(include_catalog: true). A role cannot grant more than you hold.',
  );

function toRolePermissions(map: Record<string, string[]>): RolePermission[] {
  return Object.entries(map).map(([resource_type, actions]) => ({ resource_type, actions }));
}

function summarizeUser(user: AdminUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_superadmin: user.is_superadmin,
    is_active: user.is_active,
    memberships: user.memberships.map((membership) => ({
      organization: { id: membership.organization.id, name: membership.organization.name },
      role: membership.role.name,
    })),
    created_at: user.created_at,
  };
}

function summarizeMembership(membership: AdminMembership): Record<string, unknown> {
  return {
    id: membership.id,
    organization: membership.org,
    user: { id: membership.user.id, email: membership.user.email, display_name: membership.user.display_name, is_active: membership.user.is_active },
    role: membership.role,
    joined_at: membership.joined_at,
  };
}

function summarizeAdminKey(key: AdminApiKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    status: key.status,
    owner: key.owner ? { id: key.owner.id, email: key.owner.email } : null,
    organization_ids: key.org_ids,
    created_at: key.created_at,
    expires_at: key.expires_at,
    last_used_at: key.last_used_at,
    ...(key.revoked_at ? { revoked_at: key.revoked_at } : {}),
  };
}

function summarizeOrganization(org: AdminOrganization): Record<string, unknown> {
  return {
    id: org.id,
    name: org.name,
    is_active: org.is_active,
    member_count: org.member_count,
    ...(org.admins ? { admins: org.admins.map((admin) => admin.email) } : {}),
    created_at: org.created_at,
  };
}

/** A strong initial password: 144 random bits, printable ASCII (passes PrintableAsciiPasswordValidator). */
function generateInitialPassword(): string {
  return randomBytes(18).toString('base64url');
}

export function registerAdminRbacTools(server: McpServer, context: AppContext): void {
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const users = (): AdminUsersApi => new AdminUsersApi(context.client, context.auth);
  const roles = (): AdminRolesApi => new AdminRolesApi(context.client, context.auth);
  const memberships = (): AdminMembershipsApi => new AdminMembershipsApi(context.client, context.auth);
  const apiKeys = (): AdminApiKeysApi => new AdminApiKeysApi(context.client, context.auth);
  const organizations = (): AdminOrganizationsApi => new AdminOrganizationsApi(context.client, context.auth);
  const orgId = (ref: number | string): Promise<number> => resolveOrganizationId(context, organizations(), ref);

  /** The membership of `user` in `organization` (one per pair); an id is looked for page by page. */
  async function findMembership(user: number | string, organization: number | string): Promise<AdminMembership> {
    const organizationId = await orgId(organization);
    const api = memberships();
    const isTarget = (membership: AdminMembership): boolean =>
      typeof user === 'number' ? membership.user.id === user : membership.user.email.toLowerCase() === user.toLowerCase();
    for (let page = 1; ; page += 1) {
      const listed = await api.list({
        org_ids: [organizationId],
        ...(typeof user === 'string' ? { search: user } : {}),
        page,
        page_size: ADMIN_PAGE_SIZE_MAX,
      });
      const match = listed.results.find(isTarget);
      if (match) return match;
      if (!listed.next) break;
    }
    throw new Error(`${user} is not a member of organization ${organizationId} (admin_list_memberships).`);
  }

  // ----- users ---------------------------------------------------------------

  server.registerTool(
    'admin_list_users',
    {
      title: 'List workspace users (superadmin)',
      description:
        'Every account on the EpicStaff instance with its memberships, newest first. Superadmin only — an ' +
        'organization admin manages people through admin_list_memberships instead.',
      inputSchema: {
        search: z.string().optional().describe('Substring of the email or display name.'),
        status: z.enum(ACCOUNT_STATUSES).optional().describe('Only active or only deactivated accounts.'),
        superadmins_only: z.boolean().optional().describe('true: only superadmins; false: only non-superadmins.'),
        organization: organizationRef.optional().describe('Only members of this organization (id or name).'),
        role: roleRef.optional().describe('Only users holding this role (id or name).'),
        ...pageShape,
      },
    },
    async ({ search, status, superadmins_only, organization, role, page, page_size }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'list users', requirement: SUPERADMIN }, async () => {
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          const roleId = role !== undefined ? await resolveRoleId(roles(), role, organizationId) : undefined;
          const listed = await users().list({
            search,
            status,
            is_superadmin: superadmins_only,
            role_id: roleId,
            org_ids: organizationId !== undefined ? [organizationId] : undefined,
            page,
            page_size,
          });
          return pageOf(listed, page, summarizeUser);
        });
      }),
  );

  server.registerTool(
    'admin_create_user',
    {
      title: 'Create a user account (superadmin)',
      description:
        'Create an EpicStaff account, optionally with its first organization membership. A strong initial ' +
        'password is generated and written to a NEW file at password_file (mode 0600) — it never appears in the ' +
        'conversation; hand it to the person over a safe channel and have them change it. Superadmin only; to add ' +
        'an EXISTING account to an organization use admin_add_membership. Requires confirm: true.',
      inputSchema: {
        email: z.string().email().describe('Login email of the new account.'),
        display_name: z.string().max(255).optional().describe('Display name; omitted → derived from the email.'),
        organization: organizationRef.optional().describe('Organization (id or name) to add the account to.'),
        role: roleRef
          .optional()
          .describe('Role in that organization (id or name); default the built-in Member. Needs organization.'),
        password_file: z.string().min(1).describe('Absolute path of the NEW file to write the initial password into.'),
        confirm: confirmFlag('create this account'),
      },
    },
    async ({ email, display_name, organization, role, password_file }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Creating a user');
        await context.auth.ensureAuthenticated();
        if (role !== undefined && organization === undefined) {
          throw new Error('role needs organization: a role is held in an organization.');
        }
        assertNewSecretFilePath(password_file);
        return explainRefusals({ action: 'create the user', requirement: SUPERADMIN, notFound: 'the organization or role was not found' }, async () => {
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          const roleId =
            role !== undefined && organizationId !== undefined ? await resolveRoleId(roles(), role, organizationId) : undefined;
          const password = generateInitialPassword();
          // The file first: if the account were created and the write then failed, nobody would know its password.
          writeNewSecretFile(password_file, `${password}\n`);
          let created: AdminUser;
          try {
            created = await users().create({
              email,
              password,
              ...(display_name !== undefined ? { display_name } : {}),
              ...(organizationId !== undefined ? { organization_id: organizationId } : {}),
              ...(roleId !== undefined ? { role_id: roleId } : {}),
            });
          } catch (error) {
            try {
              unlinkSync(password_file);
            } catch (unlinkError) {
              logger.warn(`Could not remove ${password_file} after the account creation failed`, unlinkError);
            }
            throw error;
          }
          return {
            user: summarizeUser(created),
            initial_password_written_to: password_file,
            note: 'The password is only in that file (mode 0600). Delete the file once it has been handed over.',
          };
        });
      }),
  );

  server.registerTool(
    'admin_set_user_active',
    {
      title: 'Deactivate or reactivate an account (superadmin)',
      description:
        'active: false DEACTIVATES the account — the person can no longer sign in and their sessions and API keys ' +
        'stop working (nothing is deleted); active: true restores it. Refuses to deactivate the account this MCP ' +
        'server signs in with. Superadmin only. Requires confirm: true.',
      inputSchema: {
        user: userRef.describe('The account: id or email.'),
        active: z.boolean().describe('false = deactivate, true = reactivate.'),
        confirm: confirmFlag('change whether this account can sign in'),
      },
    },
    async ({ user, active }) =>
      runTool(async () => {
        requireSignedInSession(context, active ? 'Reactivating a user' : 'Deactivating a user');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: active ? 'reactivate the user' : 'deactivate the user', requirement: SUPERADMIN }, async () => {
          const api = users();
          const userId = await resolveUserId(api, user);
          // The backend only keeps the last superadmin active; it would let the MCP lock out its own account.
          if (!active && (await new ProfileApi(context.client, context.auth).getProfile()).id === userId) {
            throw new Error(
              'That is the account this MCP server signs in with — deactivating it would lock the server (and you) out. ' +
                'Do it in the EpicStaff UI from another administrator account if you really mean to.',
            );
          }
          return { user: summarizeUser(active ? await api.reactivate(userId) : await api.deactivate(userId)) };
        });
      }),
  );

  server.registerTool(
    'admin_set_user_superadmin',
    {
      title: 'Grant or revoke superadmin (superadmin)',
      description:
        'superadmin: true makes the account a SUPERADMIN — unrestricted access to every organization, user, plugin ' +
        'and setting of the instance; false takes that back. Superadmin only. Grant it only on an explicit request ' +
        'naming the person. Requires confirm: true.',
      inputSchema: {
        user: userRef.describe('The account: id or email.'),
        superadmin: z.boolean().describe('true = grant, false = revoke.'),
        confirm: confirmFlag('change superadmin rights of this account'),
      },
    },
    async ({ user, superadmin }) =>
      runTool(async () => {
        requireSignedInSession(context, superadmin ? 'Granting superadmin' : 'Revoking superadmin');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: superadmin ? 'grant superadmin' : 'revoke superadmin', requirement: SUPERADMIN }, async () => {
          const api = users();
          const userId = await resolveUserId(api, user);
          return { user: summarizeUser(superadmin ? await api.grantSuperadmin(userId) : await api.revokeSuperadmin(userId)) };
        });
      }),
  );

  // ----- memberships ------------------------------------------------------------

  server.registerTool(
    'admin_list_memberships',
    {
      title: 'List organization members',
      description:
        'Who belongs to which organization with which role, across the organizations whose members you may read ' +
        '(the `memberships: read` permission). Filter by organization, role, account status or a search on email/name.',
      inputSchema: {
        organization: organizationRef.optional().describe('Only this organization (id or name).'),
        role: roleRef.optional().describe('Only members holding this role (id or name).'),
        status: z.enum(ACCOUNT_STATUSES).optional().describe('Only active or only deactivated accounts.'),
        search: z.string().optional().describe('Substring of the email or display name.'),
        ...pageShape,
      },
    },
    async ({ organization, role, status, search, page, page_size }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'list memberships', requirement: 'the `memberships: read` permission' }, async () => {
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          const roleId = role !== undefined ? await resolveRoleId(roles(), role, organizationId) : undefined;
          const listed = await memberships().list({
            org_ids: organizationId !== undefined ? [organizationId] : undefined,
            role_id: roleId,
            status,
            search,
            page,
            page_size,
          });
          return pageOf(listed, page, summarizeMembership);
        });
      }),
  );

  server.registerTool(
    'admin_add_membership',
    {
      title: 'Add a user to an organization',
      description:
        'Give an EXISTING account (by email or id) access to an organization with a role. Needs the ' +
        '`memberships: create` permission there; a role above your own is refused. New accounts: admin_create_user. ' +
        'Requires confirm: true.',
      inputSchema: {
        user: userRef.describe('The account: email or id.'),
        organization: organizationRef.describe('The organization: id or name.'),
        role: roleRef.describe('Role in that organization: id or name (built-in: Org Admin, Member, Viewer).'),
        confirm: confirmFlag('give this account access to the organization'),
      },
    },
    async ({ user, organization, role }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Adding a member');
        await context.auth.ensureAuthenticated();
        return explainRefusals(
          { action: 'add the member', requirement: 'the `memberships: create` permission in that organization' },
          async () => {
            const organizationId = await orgId(organization);
            const roleId = await resolveRoleId(roles(), role, organizationId);
            const created = await memberships().create({
              org_id: organizationId,
              role_id: roleId,
              ...(typeof user === 'number' ? { user_id: user } : { email: user }),
            });
            return { membership: summarizeMembership(created) };
          },
        );
      }),
  );

  server.registerTool(
    'admin_change_membership_role',
    {
      title: "Change a member's role",
      description:
        "Change the role a user holds in an organization (what they may do there changes at once). Needs the " +
        '`memberships: update` permission; an organization keeps at least one admin. Requires confirm: true.',
      inputSchema: {
        user: userRef.describe('The member: email or id.'),
        organization: organizationRef.describe('The organization: id or name.'),
        role: roleRef.describe('The new role: id or name.'),
        confirm: confirmFlag("change this member's role"),
      },
    },
    async ({ user, organization, role }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Changing a role');
        await context.auth.ensureAuthenticated();
        return explainRefusals(
          { action: "change the member's role", requirement: 'the `memberships: update` permission in that organization' },
          async () => {
            const membership = await findMembership(user, organization);
            const roleId = await resolveRoleId(roles(), role, membership.org.id);
            return { membership: summarizeMembership(await memberships().changeRole(membership.id, roleId)) };
          },
        );
      }),
  );

  server.registerTool(
    'admin_remove_membership',
    {
      title: 'Remove a user from an organization',
      description:
        "Take a user's access to an organization away (the account itself stays; re-add with admin_add_membership). " +
        'Needs the `memberships: delete` permission; an organization keeps at least one admin. Requires confirm: true.',
      inputSchema: {
        user: userRef.describe('The member: email or id.'),
        organization: organizationRef.describe('The organization: id or name.'),
        confirm: confirmFlag('remove this user from the organization'),
      },
    },
    async ({ user, organization }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Removing a member');
        await context.auth.ensureAuthenticated();
        return explainRefusals(
          { action: 'remove the member', requirement: 'the `memberships: delete` permission in that organization' },
          async () => {
            const membership = await findMembership(user, organization);
            await memberships().remove(membership.id);
            return { removed: summarizeMembership(membership) };
          },
        );
      }),
  );

  // ----- roles -------------------------------------------------------------------

  server.registerTool(
    'admin_list_roles',
    {
      title: 'List roles',
      description:
        'The built-in role templates (Superadmin, Org Admin, Member, Viewer) and the custom roles of the ' +
        'organizations you may read roles in, each with its permissions (resource → actions) and how many members ' +
        'hold it. include_catalog: true adds every resource type and the actions it accepts — what admin_create_role ' +
        'and admin_update_role take.',
      inputSchema: {
        organization: organizationRef.optional().describe('Only roles of this organization (id or name).'),
        assignable_only: z.boolean().default(false).describe('With organization: only roles you may assign there.'),
        search: z.string().optional().describe('Substring of the role name.'),
        include_catalog: z.boolean().default(false).describe('Add the permission catalog.'),
        ...pageShape,
      },
    },
    async ({ organization, assignable_only, search, include_catalog, page, page_size }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'list roles', requirement: 'the `roles: read` permission' }, async () => {
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          const scope = organizationId !== undefined ? [organizationId] : undefined;
          const listed = await roles().list({
            ...(assignable_only ? { assignable_org_ids: scope } : { org_ids: scope }),
            search,
            page,
            page_size,
          });
          const catalog = include_catalog ? await new ProfileApi(context.client, context.auth).getPermissionCatalog() : undefined;
          return {
            built_in_roles: listed.built_in_roles.map(summarizeRole),
            custom_roles: pageOf(listed, page, summarizeRole),
            ...(catalog
              ? {
                  permission_catalog: catalog.resource_types.map((type) => ({
                    resource_type: type.code,
                    label: type.label,
                    actions: type.applicable_actions,
                    ...(type.platform_actions.length > 0 ? { superadmin_only_actions: type.platform_actions } : {}),
                  })),
                }
              : {}),
          };
        });
      }),
  );

  server.registerTool(
    'admin_get_role',
    {
      title: 'Show a role',
      description: 'One role with its permissions (resource → actions) and how many members hold it.',
      inputSchema: {
        role: roleRef.describe('The role: id or exact name.'),
        organization: organizationRef.optional().describe('Organization of a custom role given by name (disambiguates).'),
      },
    },
    async ({ role, organization }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'read the role', requirement: 'the `roles: read` permission' }, async () => {
          const api = roles();
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          return { role: summarizeRole(await api.get(await resolveRoleId(api, role, organizationId))) };
        });
      }),
  );

  server.registerTool(
    'admin_create_role',
    {
      title: 'Create a custom role',
      description:
        'Create a custom role in one organization from a permission map (resource type → actions). Needs the ' +
        '`roles: create` permission there, and a role cannot grant more than you hold. Assign it with ' +
        'admin_add_membership / admin_change_membership_role. Requires confirm: true.',
      inputSchema: {
        organization: organizationRef.describe('The organization the role belongs to: id or name.'),
        name: z.string().min(1).describe('Role name, unique in the organization (built-in names are reserved).'),
        description: z.string().nullable().optional(),
        permissions: permissionMapSchema,
        confirm: confirmFlag('create this role'),
      },
    },
    async ({ organization, name, description, permissions }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Creating a role');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'create the role', requirement: 'the `roles: create` permission in that organization' }, async () => {
          const created = await roles().create({
            org_id: await orgId(organization),
            name,
            ...(description !== undefined ? { description } : {}),
            permissions: toRolePermissions(permissions),
          });
          return { role: summarizeRole(created) };
        });
      }),
  );

  server.registerTool(
    'admin_update_role',
    {
      title: 'Update a custom role',
      description:
        'Rename a custom role, change its description, or REPLACE its permissions (the map you pass becomes the ' +
        'whole set — every member holding it gains or loses access at once). Built-in roles are immutable. Needs ' +
        'the `roles: update` permission. Requires confirm: true.',
      inputSchema: {
        role: roleRef.describe('The role: id or exact name.'),
        organization: organizationRef.optional().describe('Organization of a role given by name (disambiguates).'),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        permissions: permissionMapSchema.optional(),
        confirm: confirmFlag('change this role'),
      },
    },
    async ({ role, organization, name, description, permissions }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Updating a role');
        await context.auth.ensureAuthenticated();
        if (name === undefined && description === undefined && permissions === undefined) {
          throw new Error('Nothing to change — pass name, description and/or permissions.');
        }
        return explainRefusals({ action: 'update the role', requirement: 'the `roles: update` permission in its organization' }, async () => {
          const api = roles();
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          const roleId = await resolveRoleId(api, role, organizationId);
          const updated = await api.update(roleId, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(permissions !== undefined ? { permissions: toRolePermissions(permissions) } : {}),
          });
          return { role: summarizeRole(updated) };
        });
      }),
  );

  server.registerTool(
    'admin_delete_role',
    {
      title: 'Delete a custom role',
      description:
        'Delete a custom role FOR GOOD (roles have no recycle bin); its members fall back to the built-in Viewer ' +
        'role. dry_run: true lists who would be reassigned without deleting. Needs the `roles: delete` permission. ' +
        'The real delete requires confirm: true.',
      inputSchema: {
        role: roleRef.describe('The role: id or exact name.'),
        organization: organizationRef.optional().describe('Organization of a role given by name (disambiguates).'),
        dry_run: z.boolean().default(false).describe('Only report the members that would be reassigned.'),
        confirm: z.literal(true).optional().describe('Required unless dry_run: the user explicitly asked to delete this role.'),
      },
    },
    async ({ role, organization, dry_run, confirm }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Deleting a role');
        await context.auth.ensureAuthenticated();
        if (!dry_run) assertConfirmed(confirm, 'delete a role');
        return explainRefusals({ action: 'delete the role', requirement: 'the `roles: delete` permission in its organization' }, async () => {
          const api = roles();
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          const roleId = await resolveRoleId(api, role, organizationId);
          if (dry_run) return { dry_run: true, preview: await api.previewDelete(roleId) };
          return { deleted_role_id: roleId, ...(await api.delete(roleId)), reassigned_to: 'Viewer' };
        });
      }),
  );

  // ----- API keys (everyone's) -------------------------------------------------------

  server.registerTool(
    'admin_list_api_keys',
    {
      title: "List users' API keys",
      description:
        "Every user's API keys you may oversee (the `api_keys: read` permission), with owner, status and last use — " +
        'never the keys themselves. Needs a signed-in session: EpicStaff does not let an API key list keys.',
      inputSchema: {
        owner_id: z.number().int().positive().optional().describe('Only keys of this user id.'),
        status: z.enum(['active', 'expired', 'revoked']).optional(),
        search: z.string().optional().describe('Substring of the key name or prefix.'),
        organization: organizationRef.optional().describe('Only keys of members of this organization (id or name).'),
        ...pageShape,
      },
    },
    async ({ owner_id, status, search, organization, page, page_size }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Listing API keys');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'list API keys', requirement: 'the `api_keys: read` permission' }, async () => {
          const organizationId = organization !== undefined ? await orgId(organization) : undefined;
          const listed = await apiKeys().list({
            user: owner_id,
            status,
            search,
            org_ids: organizationId !== undefined ? [organizationId] : undefined,
            page,
            page_size,
          });
          return pageOf(listed, page, summarizeAdminKey);
        });
      }),
  );

  server.registerTool(
    'admin_revoke_api_key',
    {
      title: "Revoke a user's API key",
      description:
        'Revoke any user\'s API key you may oversee (the `api_keys: delete` permission): it stops authenticating at ' +
        'once and whatever uses it breaks. Refuses the key this MCP server itself runs on. Requires confirm: true.',
      inputSchema: {
        key_id: z.number().int().positive().describe('Key id (admin_list_api_keys).'),
        confirm: confirmFlag('revoke this API key'),
      },
    },
    async ({ key_id }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Revoking an API key');
        await context.auth.ensureAuthenticated();
        const { apiKey } = context.store.get();
        if (apiKey) {
          const inUse = apiKeyPrefix(apiKey);
          const own = (await new ProfileApi(context.client, context.auth).listApiKeys()).find((key) => key.prefix === inUse);
          if (own?.id === key_id) {
            throw new Error(
              `Key ${own.prefix}… is the one this MCP server authenticates with — revoking it would cut the server off. ` +
                'Revoke it in the EpicStaff UI if you really mean to.',
            );
          }
        }
        return explainRefusals({ action: 'revoke the API key', requirement: 'the `api_keys: delete` permission' }, async () => ({
          api_key: summarizeAdminKey(await apiKeys().revoke(key_id)),
        }));
      }),
  );

  // ----- organizations ---------------------------------------------------------------

  server.registerTool(
    'admin_list_organizations',
    {
      title: 'List organizations (admin view)',
      description:
        'Organizations you may administer (superadmin: all, deactivated ones included) with member counts and ' +
        'admins. For the organizations you work in and the active one, use list_organizations.',
      inputSchema: {
        search: z.string().optional().describe('Substring of the organization name.'),
        is_active: z.boolean().optional().describe('Only active (true) or only deactivated (false) organizations.'),
        ...pageShape,
      },
    },
    async ({ search, is_active, page, page_size }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'list organizations', requirement: 'the `organizations: read` permission' }, async () =>
          pageOf(await organizations().list({ search, is_active, page, page_size }), page, summarizeOrganization),
        );
      }),
  );

  server.registerTool(
    'admin_create_organization',
    {
      title: 'Create an organization (superadmin)',
      description:
        'Create a new, empty organization. Superadmin only. Add people with admin_add_membership (give at least one ' +
        'person Org Admin). Requires confirm: true.',
      inputSchema: {
        name: z.string().min(1).max(255).describe('Organization name, unique on the instance.'),
        confirm: confirmFlag('create this organization'),
      },
    },
    async ({ name }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Creating an organization');
        await context.auth.ensureAuthenticated();
        return explainRefusals({ action: 'create the organization', requirement: SUPERADMIN }, async () => ({
          organization: summarizeOrganization(await organizations().create(name)),
        }));
      }),
  );

  server.registerTool(
    'admin_rename_organization',
    {
      title: 'Rename an organization',
      description: 'Rename an organization (the `organizations: update` permission there). Requires confirm: true.',
      inputSchema: {
        organization: organizationRef.describe('The organization: id or current name.'),
        name: z.string().min(1).max(255).describe('The new name, unique on the instance.'),
        confirm: confirmFlag('rename this organization'),
      },
    },
    async ({ organization, name }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Renaming an organization');
        await context.auth.ensureAuthenticated();
        return explainRefusals(
          { action: 'rename the organization', requirement: 'the `organizations: update` permission in it' },
          async () => ({ organization: summarizeOrganization(await organizations().rename(await orgId(organization), name)) }),
        );
      }),
  );

  server.registerTool(
    'admin_set_organization_active',
    {
      title: 'Deactivate or reactivate an organization (superadmin)',
      description:
        'active: false DEACTIVATES an organization — its members lose access to everything in it until it is ' +
        'reactivated (nothing is deleted); active: true restores it. The last active organization cannot be ' +
        'deactivated. Superadmin only. Requires confirm: true.',
      inputSchema: {
        organization: organizationRef.describe('The organization: id or name.'),
        active: z.boolean().describe('false = deactivate, true = reactivate.'),
        confirm: confirmFlag('change whether this organization is usable'),
      },
    },
    async ({ organization, active }) =>
      runTool(async () => {
        requireSignedInSession(context, active ? 'Reactivating an organization' : 'Deactivating an organization');
        await context.auth.ensureAuthenticated();
        return explainRefusals(
          { action: active ? 'reactivate the organization' : 'deactivate the organization', requirement: SUPERADMIN },
          async () => {
            const organizationId = await orgId(organization);
            const api = organizations();
            const updated = active ? await api.reactivate(organizationId) : await api.deactivate(organizationId);
            const wasActiveContext = !active && context.store.get().activeOrgId === organizationId;
            return {
              organization: summarizeOrganization(updated),
              ...(wasActiveContext
                ? { warning: 'This was the active organization of this MCP session — pick another with set_active_organization.' }
                : {}),
            };
          },
        );
      }),
  );
}
