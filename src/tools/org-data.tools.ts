import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { KeyValueTablesApi, type KeyValueTableEntryListItem } from '../api/key-value-tables.js';
import { SecretsApi } from '../api/secrets.js';
import { credentialEnvName } from '../flow-source/schema/common.js';
import { describeUser } from '../models/authorship.js';
import { readCredentialEnv } from '../pusher/env-secrets.js';
import { runTool } from './auth-org.tools.js';
import { createOrExplainConflict, idOrName, recycleBinHint, resolveNamedRef } from './catalog-helpers.js';

/**
 * Org data that flows read at run time: Secrets (credentials python code, LLM configs and tools
 * read by name/id) and Key-Value tables (state key-value nodes read and write).
 *
 * Secret values never pass through this server's tool surface: create_secret reads the value from
 * an environment variable of the MCP server, and no tool returns any part of a value (EpicStaff
 * sends only the last 4 characters as `tail`; these tools drop even that).
 */

/** Largest key-value page the backend serves (KeyValueTableEntryPagination.max_limit). */
const ENTRY_PAGE_LIMIT = 100;

export function registerOrgDataTools(server: McpServer, context: AppContext): void {
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const secrets = (): SecretsApi => new SecretsApi(context.client, context.auth);
  const tables = new KeyValueTablesApi(context.client);

  const resolveTable = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Key-value table', () => tables.list(), (table) => table.id, (table) => table.name);

  // ----- Secrets ---------------------------------------------------------------

  server.registerTool(
    'list_secrets',
    {
      title: 'List org secrets',
      description:
        'List the org Secrets by name (never their values — EpicStaff does not return them, and not even the ' +
        'masked tail is passed on): id, name, how many configs/tools/nodes use each. Needs a signed-in session ' +
        '(EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD): EpicStaff refuses secrets to API keys.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return (await secrets().list()).map((secret) => ({
          id: secret.id,
          name: secret.name,
          usage_count: secret.usage_count ?? null,
          created_by: describeUser(secret.created_by),
          created_at: secret.created_at,
        }));
      }),
  );

  server.registerTool(
    'create_secret',
    {
      title: 'Create an org secret',
      description:
        'Store the value of an environment variable of the MCP server as an org Secret. The value never appears ' +
        'in the tool call or its result. Secrets are immutable (to rotate: delete_secret, then create again). ' +
        'Python code reads a secret it declares; LLM configs reference one by id (create_llm_config api_key_secret).',
      inputSchema: {
        name: z.string().min(1).max(255).describe('Org-unique secret name.'),
        value_env: credentialEnvName(
          'Environment variable of the MCP server holding the value (export it in the shell that launches ' +
            'Claude Code). EPICSTAFF_* / ES_MCP_* names are refused.',
        ),
      },
    },
    async ({ name, value_env }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const api = secrets();
        if (await api.findByName(name)) {
          throw new Error(
            `A secret named "${name}" already exists. Secrets are immutable — delete_secret it first to replace ` +
              'its value, or pick another name.',
          );
        }
        const value = readCredentialEnv(value_env);
        const created = await createOrExplainConflict(() => api.create(name, value), name, 'delete_secret + create_secret');
        // Only the id and name go back — never the value, not even the backend's masked tail.
        return { secret: { id: created.id, name: created.name }, source: `environment variable ${value_env}` };
      }),
  );

  server.registerTool(
    'delete_secret',
    {
      title: 'Delete an org secret',
      description:
        'Delete an org Secret: it moves to the recycle bin (restorable with restore_from_recycle_bin kind "secret"). ' +
        'Configs, tools and code that use it lose the credential while it is binned — check usage_count ' +
        '(list_secrets) first.',
      inputSchema: {
        secret: idOrName.describe('The secret: backend id or exact name.'),
      },
    },
    async ({ secret }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const api = secrets();
        const all = await api.list();
        const secretId = await resolveNamedRef(secret, 'Secret', async () => all, (row) => row.id, (row) => row.name);
        const current = all.find((row) => row.id === secretId);
        await api.delete(secretId);
        return {
          deleted: { id: secretId, name: current?.name ?? null, usage_count: current?.usage_count ?? null },
          next: recycleBinHint('secret', secretId),
        };
      }),
  );

  // ----- Key-value tables ---------------------------------------------------------

  server.registerTool(
    'list_key_value_tables',
    {
      title: 'List key-value tables',
      description:
        'List the org Key-Value tables (what key-value nodes read and write by table name): id, name, description, ' +
        'entry count, last edit.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return (await tables.list()).map((table) => ({
          id: table.id,
          name: table.name,
          description: table.description ?? '',
          entry_count: table.entry_count ?? 0,
          created_by: describeUser(table.created_by),
          last_edited_by: describeUser(table.last_edited_by),
          last_edited_at: table.last_edited_at ?? null,
        }));
      }),
  );

  server.registerTool(
    'create_key_value_table',
    {
      title: 'Create a key-value table',
      description:
        'Create an org Key-Value table. (push_flow also creates the tables its key-value nodes name when missing.) ' +
        'Names are unique per org, ignoring case.',
      inputSchema: {
        name: z.string().min(1).describe('Table name — what a key-value node\'s `table:` refers to.'),
        description: z.string().optional(),
      },
    },
    async ({ name, description }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return createOrExplainConflict(
          () => tables.create({ name, ...(description !== undefined ? { description } : {}) }),
          name,
          'update_key_value_table',
        );
      }),
  );

  server.registerTool(
    'update_key_value_table',
    {
      title: 'Update a key-value table',
      description:
        'Rename a Key-Value table or change its description. Renaming breaks flow sources whose key-value nodes name ' +
        'the old table (their next push creates a new, empty table under the old name).',
      inputSchema: {
        table: idOrName.describe('The table: backend id or exact name.'),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
      },
    },
    async ({ table, name, description }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if (name === undefined && description === undefined) throw new Error('Nothing to change — pass name and/or description.');
        const tableId = await resolveTable(table);
        return tables.update(tableId, {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
        });
      }),
  );

  server.registerTool(
    'delete_key_value_table',
    {
      title: 'Delete a key-value table',
      description:
        'Delete a Key-Value table with its entries: it moves to the recycle bin (restorable with ' +
        'restore_from_recycle_bin kind "key_value_table"). The result says how many nodes/flows used it.',
      inputSchema: {
        table: idOrName.describe('The table: backend id or exact name.'),
      },
    },
    async ({ table }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const tableId = await resolveTable(table);
        const usage = await tables.usage(tableId);
        await tables.delete(tableId);
        return { deleted: { id: tableId }, usedBy: usage, next: recycleBinHint('key_value_table', tableId) };
      }),
  );

  server.registerTool(
    'list_key_value_entries',
    {
      title: 'List key-value entries',
      description:
        'Read entries of a Key-Value table. Without `key`: a page of entries with a 200-character preview of each ' +
        'value and which flow run wrote it. With `key`: that one entry with its full value.',
      inputSchema: {
        table: idOrName.describe('The table: backend id or exact name.'),
        key: z.string().optional().describe('Exact key to read in full.'),
        search: z.string().optional().describe('Substring of the key (list mode).'),
        limit: z.number().int().min(1).max(ENTRY_PAGE_LIMIT).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ table, key, search, limit, offset }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const tableId = await resolveTable(table);
        if (key !== undefined) {
          const entry = await findEntry(tables, tableId, key);
          if (entry === undefined) return { table: tableId, key, exists: false };
          return { table: tableId, exists: true, entry: await tables.getEntry(entry.id) };
        }
        const page = await tables.listEntries({ table: tableId, limit, offset, ...(search ? { search } : {}) });
        return { table: tableId, count: page.count, offset, entries: page.results };
      }),
  );

  server.registerTool(
    'write_key_value_entries',
    {
      title: 'Write key-value entries',
      description:
        'Hand-edit a Key-Value table: `set` creates or overwrites entries (key → any JSON value), `delete` removes ' +
        'keys. Flows read the new values on their next run. Keys a key-value node reads must match exactly.',
      inputSchema: {
        table: idOrName.describe('The table: backend id or exact name.'),
        set: z.record(z.string().min(1), z.unknown()).optional().describe('Entries to create or overwrite.'),
        delete: z.array(z.string().min(1)).optional().describe('Keys to delete.'),
      },
    },
    async ({ table, set, delete: keysToDelete }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const tableId = await resolveTable(table);
        const created: string[] = [];
        const updated: string[] = [];
        const deleted: string[] = [];
        const missing: string[] = [];
        for (const [key, value] of Object.entries(set ?? {})) {
          const existing = await findEntry(tables, tableId, key);
          if (existing === undefined) {
            await tables.createEntry({ table: tableId, key, value });
            created.push(key);
          } else {
            await tables.updateEntry(existing.id, { value });
            updated.push(key);
          }
        }
        for (const key of keysToDelete ?? []) {
          const existing = await findEntry(tables, tableId, key);
          if (existing === undefined) {
            missing.push(key);
            continue;
          }
          await tables.deleteEntry(existing.id);
          deleted.push(key);
        }
        return { table: tableId, created, updated, deleted, ...(missing.length > 0 ? { notFound: missing } : {}) };
      }),
  );
}

/** The entry whose key is exactly `key` (the list search is a substring match, so filter and page). */
async function findEntry(
  tables: KeyValueTablesApi,
  tableId: number,
  key: string,
): Promise<KeyValueTableEntryListItem | undefined> {
  for (let offset = 0; ; offset += ENTRY_PAGE_LIMIT) {
    const page = await tables.listEntries({ table: tableId, search: key, ordering: 'key', limit: ENTRY_PAGE_LIMIT, offset });
    const match = page.results.find((entry) => entry.key === key);
    if (match !== undefined) return match;
    if (offset + page.results.length >= page.count || page.results.length === 0) return undefined;
  }
}
