import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { API_KEY_MAX_EXPIRES_IN_DAYS, type ApiKeyDto, ProfileApi, apiKeyPrefix } from '../api/profile.js';
import type { AppContext } from '../context.js';
import { logger } from '../util/logger.js';
import { assertNewSecretFilePath, writeNewSecretFile } from '../util/secret-file.js';
import { confirmFlag, requireSignedInSession } from './admin-helpers.js';
import { runTool } from './auth-org.tools.js';

/**
 * The signed-in user's own account: who they are, what they may do where, and their personal API
 * keys. A minted key is written to a new 0600 file and never appears in a tool result.
 */

function summarizeKey(key: ApiKeyDto): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    status: key.status,
    created_at: key.created_at,
    expires_at: key.expires_at,
    last_used_at: key.last_used_at,
    ...(key.revoked_at ? { revoked_at: key.revoked_at } : {}),
  };
}

export function registerAccountTools(server: McpServer, context: AppContext): void {
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const profile = (): ProfileApi => new ProfileApi(context.client, context.auth);

  /** The prefix of the key this server authenticates with — the backend lists keys by it. */
  const ownKeyPrefix = (): string | null => {
    const { apiKey } = context.store.get();
    return apiKey ? apiKeyPrefix(apiKey) : null;
  };

  server.registerTool(
    'get_my_account',
    {
      title: 'Show my account and permissions',
      description:
        'Who the configured EpicStaff user is (email, display name, superadmin or not), the organizations they ' +
        'belong to with their role in each, and the effective permissions there (resource → actions). Use it to ' +
        'check what an administration tool will be allowed to do before calling it.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const api = profile();
        const [me, capabilities] = await Promise.all([api.getProfile(), api.getOrgPermissions()]);
        return {
          user: {
            id: me.id,
            email: me.email,
            display_name: me.display_name,
            is_superadmin: me.is_superadmin,
            is_active: me.is_active,
          },
          active_organization_id: me.active_organization_id,
          memberships: me.memberships.map((membership) => ({
            organization: { id: membership.organization.id, name: membership.organization.name },
            role: membership.role.name,
            joined_at: membership.joined_at,
          })),
          permissions: capabilities.is_superadmin
            ? 'superadmin: every action in every organization'
            : (capabilities.orgs ?? []).map((scope) => ({
                organization: scope.org,
                role: scope.role?.name ?? null,
                permissions: scope.permissions,
              })),
        };
      }),
  );

  server.registerTool(
    'update_my_profile',
    {
      title: 'Update my profile',
      description: "Change the configured user's display name (the name EpicStaff shows as author and in chats).",
      inputSchema: {
        display_name: z
          .string()
          .max(255)
          .nullable()
          .describe('New display name; null derives it from the email again.'),
      },
    },
    async ({ display_name }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const updated = await profile().updateProfile({ display_name });
        return { user: { id: updated.id, email: updated.email, display_name: updated.display_name } };
      }),
  );

  server.registerTool(
    'list_my_api_keys',
    {
      title: 'List my API keys',
      description:
        "The configured user's personal API keys — name, prefix, status, expiry, last use; never the keys " +
        'themselves (EpicStaff stores only a hash). The key this MCP server runs on is marked in_use_by_mcp. ' +
        'Needs a signed-in session (EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD): EpicStaff does not let an API key list keys.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        requireSignedInSession(context, 'Listing API keys');
        await context.auth.ensureAuthenticated();
        const inUse = ownKeyPrefix();
        const keys = await profile().listApiKeys();
        return {
          keys: keys.map((key) => ({ ...summarizeKey(key), ...(key.prefix === inUse ? { in_use_by_mcp: true } : {}) })),
        };
      }),
  );

  server.registerTool(
    'create_my_api_key',
    {
      title: 'Create a personal API key',
      description:
        'Mint a personal API key for the configured user — it acts with all of that user\'s permissions. The raw ' +
        'key is written to a NEW file at output_file (mode 0600; an existing path or symbolic link is refused) and ' +
        'is never shown in the conversation; the result names only its prefix. Use it to give an app or script its ' +
        'own EpicStaff credential (X-Api-Key header). Keep the file out of version control. Requires confirm: true.',
      inputSchema: {
        name: z.string().min(1).max(255).describe('What the key is for, e.g. "pallet-quote backend".'),
        output_file: z.string().min(1).describe('Absolute path of the new file to write the key into.'),
        env_var_name: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name')
          .optional()
          .describe('Write the key as a dotenv line NAME=<key> instead of the bare key.'),
        expires_in_days: z
          .number()
          .int()
          .min(1)
          .max(API_KEY_MAX_EXPIRES_IN_DAYS)
          .nullable()
          .optional()
          .describe(`Lifetime in days (1–${API_KEY_MAX_EXPIRES_IN_DAYS}); omit for EpicStaff's 90-day default, null for a key that never expires.`),
        confirm: confirmFlag('create this API key'),
      },
    },
    async ({ name, output_file, env_var_name, expires_in_days }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Creating an API key');
        // Before minting: a bad destination must fail while no credential exists yet.
        assertNewSecretFilePath(output_file);
        await context.auth.ensureAuthenticated();
        const api = profile();
        const created = await api.createApiKey(name, expires_in_days);
        try {
          writeNewSecretFile(output_file, env_var_name ? `${env_var_name}=${created.api_key}\n` : `${created.api_key}\n`);
        } catch (error) {
          // Nobody can ever see this key again — retire it rather than leave a live, unreachable credential.
          await api.revokeApiKey(created.id).catch((revokeError: unknown) => {
            logger.warn(`Could not revoke API key ${created.prefix}… after failing to write it`, revokeError);
          });
          throw new Error(
            `The key was minted but could not be written to ${output_file} (${error instanceof Error ? error.message : String(error)}); ` +
              `it was revoked again. Nothing usable was created.`,
          );
        }
        return {
          api_key: summarizeKey(created),
          written_to: output_file,
          format: env_var_name ? `dotenv line ${env_var_name}=…` : 'the bare key',
          note: 'The key is only in that file (mode 0600) — send it as the X-Api-Key header. Revoke it with revoke_my_api_key.',
        };
      }),
  );

  server.registerTool(
    'revoke_my_api_key',
    {
      title: 'Revoke one of my API keys',
      description:
        'Revoke a personal API key: it stops authenticating at once (apps using it break) and stays listed as ' +
        'revoked. Refuses the key this MCP server itself runs on. Requires confirm: true.',
      inputSchema: {
        key: z
          .union([z.number().int().positive(), z.string().min(1)])
          .describe('The key: id, exact name, or prefix (list_my_api_keys).'),
        confirm: confirmFlag('revoke this API key'),
      },
    },
    async ({ key }) =>
      runTool(async () => {
        requireSignedInSession(context, 'Revoking an API key');
        await context.auth.ensureAuthenticated();
        const api = profile();
        const keys = await api.listApiKeys();
        const matches = keys.filter((candidate) =>
          typeof key === 'number' ? candidate.id === key : candidate.name === key || candidate.prefix === key,
        );
        if (matches.length > 1) {
          throw new Error(`"${key}" matches ${matches.length} keys (ids ${matches.map((match) => match.id).join(', ')}) — pass the id.`);
        }
        const target = matches[0];
        if (!target) throw new Error(`No API key "${key}" among yours (list_my_api_keys).`);
        if (target.prefix === ownKeyPrefix()) {
          throw new Error(
            `Key ${target.prefix}… is the one this MCP server authenticates with — revoking it would cut the server off. ` +
              'Revoke it in the EpicStaff UI if you really mean to.',
          );
        }
        if (target.status === 'revoked') return { api_key: summarizeKey(target), note: 'Already revoked.' };
        return { api_key: summarizeKey(await api.revokeApiKey(target.id)) };
      }),
  );
}
