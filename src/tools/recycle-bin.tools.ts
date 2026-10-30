import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { describeUser } from '../models/authorship.js';
import {
  type GetRecycleBinEntryResponse,
  RECYCLE_BIN_BULK_ID_LIMIT,
  RECYCLE_BIN_MAX_PAGE_SIZE,
  RECYCLE_BIN_SOURCE_KEYS,
  RECYCLE_BIN_SOURCES,
  RecycleBinApi,
  type RecycleBinSourceKey,
} from '../api/recycle-bin.js';
import { runTool } from './auth-org.tools.js';

/**
 * Recycle bin — deleted flows, agents, surfaces, tools, collections, key-value tables, secrets,
 * webhook triggers, voice channels and storage files stay restorable for the deployment's retention
 * period. Listing and restoring follow the user's permissions; purging is irreversible and
 * superadmin-only.
 */

const binKindSchema = z
  .enum(RECYCLE_BIN_SOURCE_KEYS as [RecycleBinSourceKey, ...RecycleBinSourceKey[]])
  .describe(
    'Which bin: flow, agent, surface, python_tool, mcp_tool, collection, key_value_table, secret, webhook_trigger, ' +
      'realtime_channel (voice channel) or storage (files and folders).',
  );

const idsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(RECYCLE_BIN_BULK_ID_LIMIT)
  .describe(`Ids of binned items of that kind (list_recycle_bin), at most ${RECYCLE_BIN_BULK_ID_LIMIT}.`);

/** A bin entry as tool output: the editor's detail lines flattened to label → value. */
export function summarizeBinEntry(kind: RecycleBinSourceKey, entry: GetRecycleBinEntryResponse): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const detail of entry.details) {
    // A user line is a user summary; anything else in it (an older backend's plain id) passes through.
    details[detail.label] =
      detail.format === 'user' && typeof detail.value === 'object' ? describeUser(detail.value) : detail.value;
  }
  const hidden = entry.hidden_contents.reduce((total, item) => total + item.count, 0);
  return {
    kind,
    id: entry.id,
    name: entry.name,
    ...(entry.item_type !== undefined ? { item_type: entry.item_type } : {}),
    deleted_at: entry.deleted_at,
    days_left: entry.days_left,
    details,
    // What a restore brings back with the item.
    contents_total: entry.contents_total,
    ...(entry.contents.length > 0
      ? { contents: entry.contents.slice(0, 20).map((content) => `${content.kind}: ${content.name}`) }
      : {}),
    ...(hidden > 0 ? { hidden_contents: hidden } : {}),
  };
}

export function registerRecycleBinTools(server: McpServer, context: AppContext): void {
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const recycleBin = (): RecycleBinApi => new RecycleBinApi(context.client, context.auth);

  server.registerTool(
    'list_recycle_bin',
    {
      title: 'List the recycle bin',
      description:
        'List deleted items that can still be restored (newest deletion first), with days left before they are ' +
        'purged automatically and what a restore brings back with them. Pass kind for one bin (paged), or omit it ' +
        'for the first page of every bin you may read.',
      inputSchema: {
        kind: binKindSchema.optional(),
        search: z.string().optional().describe('Case-insensitive substring of the item name.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(RECYCLE_BIN_MAX_PAGE_SIZE)
          .optional()
          .describe(`Page size (default 50 for one kind, 20 per kind for all; max ${RECYCLE_BIN_MAX_PAGE_SIZE}).`),
        offset: z.number().int().min(0).default(0).describe('Page offset (one kind only).'),
      },
    },
    async ({ kind, search, limit, offset }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const bin = recycleBin();
        const settings = await bin.getSettings();
        if (kind !== undefined) {
          const page = await bin.list(kind, { limit: limit ?? 50, offset, ...(search ? { search } : {}) });
          return {
            retention_days: settings.retention_days,
            kind,
            count: page.count,
            offset,
            items: page.results.map((entry) => summarizeBinEntry(kind, entry)),
          };
        }
        const perKind = limit ?? 20;
        const bins: Record<string, unknown> = {};
        const unavailable: Record<string, string> = {};
        await Promise.all(
          RECYCLE_BIN_SOURCE_KEYS.map(async (source) => {
            try {
              const page = await bin.list(source, { limit: perKind, offset: 0, ...(search ? { search } : {}) });
              if (page.count > 0) {
                bins[source] = {
                  count: page.count,
                  items: page.results.map((entry) => summarizeBinEntry(source, entry)),
                };
              }
            } catch (error) {
              // A bin the user may not read (or a feature switched off) must not hide the others.
              if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
                unavailable[source] = error.status === 403 ? 'no permission' : 'not available';
                return;
              }
              throw error;
            }
          }),
        );
        return {
          retention_days: settings.retention_days,
          bins,
          ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
          next: 'Restore with restore_from_recycle_bin(kind, ids). Pass kind for more than the first page of a bin.',
        };
      }),
  );

  server.registerTool(
    'restore_from_recycle_bin',
    {
      title: 'Restore deleted items',
      description:
        'Restore binned items of one kind, with what they owned (a flow\'s nodes, an agent\'s own surfaces …). ' +
        'An item whose name was taken meanwhile comes back renamed (renamed_from). links_restored tells whether ' +
        'everything that used it is connected again. Failures are reported per item; the rest go ahead. Pass ids, ' +
        'or all: true to restore every item of that kind in the bin (only when the user asks for the whole bin).',
      inputSchema: {
        kind: binKindSchema,
        ids: idsSchema.optional(),
        all: z
          .literal(true)
          .optional()
          .describe('Restore every binned item of this kind instead of the listed ids.'),
      },
    },
    async ({ kind, ids, all }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if ((ids === undefined) === (all === undefined)) {
          throw new Error('Pass either ids (list_recycle_bin) or all: true, not both and not neither.');
        }
        const result = await recycleBin().restore(kind, ids !== undefined ? { ids } : { all: true });
        const renamed = result.restored.filter((item) => item.renamed_from !== null);
        return {
          kind: RECYCLE_BIN_SOURCES[kind].kind,
          ...result,
          ...(renamed.length > 0
            ? {
                note:
                  'Some items came back under a new name — flow sources that reference the old name via existing: ' +
                  `need updating${kind === 'secret' ? ', and code that reads a renamed secret by name must use the new name' : ''}.`,
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    'purge_from_recycle_bin',
    {
      title: 'Permanently delete binned items',
      description:
        'IRREVERSIBLE: delete binned items of one kind for good — they can never be restored. EpicStaff allows ' +
        'it to superadmins only, through a signed-in session (never an API key); everyone else gets a 403. Items ' +
        'are purged automatically when their retention runs out anyway, so purge only on an explicit user request, ' +
        'naming the exact items. Requires confirm: true.',
      inputSchema: {
        kind: binKindSchema,
        ids: idsSchema,
        confirm: z
          .literal(true)
          .describe('Must be true: the user explicitly asked to delete exactly these items forever.'),
      },
    },
    async ({ kind, ids }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        try {
          const result = await recycleBin().purge(kind, ids);
          return { kind: RECYCLE_BIN_SOURCES[kind].kind, ...result };
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            throw new Error(
              'Purging was refused: EpicStaff lets only a superadmin purge, and only from a signed-in session ' +
                '(EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD, not EPICSTAFF_API_TOKEN). Nothing was deleted; the items ' +
                'expire on their own when their retention runs out.',
            );
          }
          throw error;
        }
      }),
  );
}
