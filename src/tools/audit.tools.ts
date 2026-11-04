import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AuditApi, type AuditMatchScope, type AuditSearchRequest } from '../api/audit.js';
import { type AuditPreset, type AuditPresetBody, AuditPresetsApi } from '../api/audit-presets.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { explainRefusals } from './admin-helpers.js';
import { idOrName, resolveNamedRef } from './catalog-helpers.js';
import { runTool } from './auth-org.tools.js';

/**
 * The audit trail of the active organization — what ran in its flow sessions (sessions, nodes,
 * events, with inputs, outputs, errors, agents, tools, prompts) — searched through the auditor service
 * with a short-lived audit token the MCP mints and keeps to itself, plus the organization's saved
 * search filters (audit presets). Everything here needs the `audit: read` permission.
 */

/** Longest string value returned per field; event inputs/outputs can be whole documents. */
export const AUDIT_VALUE_MAX_CHARS = 2000;
const AUDIT_PAGE_SIZE_MAX = 200;

const AUDITOR_UNREACHABLE =
  'the audit trail is not reachable at <EpicStaff address>/auditor/. It runs only where the deployment enables it ' +
  '(COMPOSE_PROFILES with "auditor", AUDIT_TRAIL_ENABLED=true), and the MCP must reach EpicStaff through its web ' +
  'entry point (EPICSTAFF_BASE_URL = the address of the UI, not the Django port)';

const filtersSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'A filter tree: {"op": "and"|"or", "children": [...]} | {"op": "not", "child": {...}} | ' +
      '{"field": "...", "op": "...", "value": ...}. Fields: id, session_id, status (completed|failed), kind ' +
      '(session|node|event), name, flow_name, node_type, run_type, event_time, error, agent, tool, task, prompt, ' +
      'message_text, duration, and input.<key> / output.<key> / details.<key>. Ops: equals, not_equal, in, not_in, ' +
      'contains, not_contains, starts_with, ends_with, gt, gte, lt, lte, is_empty, is_not_empty (+ key_exists, ' +
      'key_not_exists, key_equals_value, key_not_equals, null, not_null on input/output/details paths).',
  );

const querySchema = z
  .string()
  .min(1)
  .describe(
    'Text form of the same filter, e.g. `status = "failed" and flow_name : "Quote"` or ' +
      '`(tool = "Web_Search_Tool" or agent = "Researcher") and not duration < 10`. Operators: = != : !: > < >= <= ' +
      'in (…) / not in (…), is empty, is not empty, starts with, ends with; and / or / not; parentheses.',
  );

const matchScopeSchema = z
  .object({
    ancestors: z.boolean().optional().describe('Add the session / node rows that own each returned row.'),
    children: z.boolean().optional().describe('A matched session brings its whole tree; a matched node its events.'),
    rows_before: z.number().int().min(0).max(20).optional().describe('Add the N rows before each match in its session.'),
    full_session_history: z.boolean().optional().describe('Return the full tree of every session with a match.'),
  })
  .describe('Which rows come back around a match (not filter conditions).');

/** Cut every long string in an audit row (recursively) so one event cannot flood the context. */
export function clipAuditValues(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > AUDIT_VALUE_MAX_CHARS
      ? `${value.slice(0, AUDIT_VALUE_MAX_CHARS)}… (+${value.length - AUDIT_VALUE_MAX_CHARS} chars)`
      : value;
  }
  if (Array.isArray(value)) return value.map(clipAuditValues);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipAuditValues(item)]));
  }
  return value;
}

/** A preset's search, as the auditor takes it: the frontend-only `ui_state` never goes there. */
function searchBodyOf(preset: AuditPreset): AuditSearchRequest {
  const { ui_state: _uiState, cursor: _cursor, size: _size, ...search } = preset.filter_body;
  return search;
}

function summarizePreset(preset: AuditPreset): Record<string, unknown> {
  return {
    id: preset.id,
    name: preset.name,
    shared: preset.is_shared,
    yours: preset.is_owner,
    author: preset.created_by_name,
    search: searchBodyOf(preset),
    updated_at: preset.updated_at,
  };
}

function exclusiveFilter(query: string | undefined, filters: Record<string, unknown> | undefined): Pick<AuditPresetBody, 'query' | 'filters'> {
  if (query !== undefined && filters !== undefined) {
    throw new Error('Pass query or filters, not both — they are two forms of the same filter.');
  }
  return query !== undefined ? { query } : filters !== undefined ? { filters } : {};
}

export function registerAuditTools(server: McpServer, context: AppContext): void {
  // One instance for the server's life: it caches the audit token (per organization) in memory.
  const audit = new AuditApi(context.client);
  const presets = new AuditPresetsApi(context.client);
  const resolvePreset = async (ref: number | string): Promise<AuditPreset> => {
    const listed = await presets.list();
    const id = await resolveNamedRef(ref, 'Audit preset', async () => listed, (preset) => preset.id, (preset) => preset.name);
    const preset = listed.find((candidate) => candidate.id === id);
    if (!preset) throw new Error(`Audit preset ${ref} not found among yours and the shared ones (list_audit_presets).`);
    return preset;
  };
  const auditRead = { requirement: 'the `audit: read` permission in the active organization' };

  server.registerTool(
    'search_audit_log',
    {
      title: 'Search the audit trail',
      description:
        "Search the active organization's session audit trail — sessions, node runs and events with their inputs, " +
        'outputs, errors, agents, tools and prompts — newest first. Filter with query (text) or filters (tree), or ' +
        'reuse a saved preset (list_audit_presets); none of them lists everything. Long values are cut to ' +
        `${AUDIT_VALUE_MAX_CHARS} characters. Page on with cursor = next_cursor. Needs \`audit: read\`; the trail ` +
        'only reaches back as far as your retention allows.',
      inputSchema: {
        query: querySchema.optional(),
        filters: filtersSchema.optional(),
        preset: idOrName.optional().describe('A saved audit preset (id or name) to search with.'),
        match_scope: matchScopeSchema.optional(),
        size: z.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).default(20).describe(`Rows per page (max ${AUDIT_PAGE_SIZE_MAX}).`),
        cursor: z.string().optional().describe('next_cursor of the previous page.'),
      },
    },
    async ({ query, filters, preset, match_scope, size, cursor }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const orgId = await context.org.requireActiveOrg();
        if (preset !== undefined && (query !== undefined || filters !== undefined)) {
          throw new Error('Pass a preset or a query / filters, not both.');
        }
        return explainRefusals({ action: 'search the audit trail', ...auditRead, notFound: AUDITOR_UNREACHABLE }, async () => {
          const base: AuditSearchRequest = preset !== undefined ? searchBodyOf(await resolvePreset(preset)) : exclusiveFilter(query, filters);
          const request: AuditSearchRequest = {
            ...base,
            ...(match_scope !== undefined ? { match_scope: match_scope satisfies AuditMatchScope } : {}),
            size,
            ...(cursor !== undefined ? { cursor } : {}),
          };
          let page;
          try {
            page = await audit.searchSessions(orgId, request);
          } catch (error) {
            if (error instanceof ApiError && [502, 503, 504].includes(error.status)) {
              throw new Error(`Could not search the audit trail (HTTP ${error.status}): ${AUDITOR_UNREACHABLE}.`);
            }
            throw error;
          }
          return {
            returned: page.items.length,
            items: page.items.map(clipAuditValues),
            next_cursor: page.next_cursor,
            ...(page.partial
              ? {
                  partial: true,
                  note:
                    'Fewer rows than size: the duration filter hit its scan limit before filling the page — continue ' +
                    'with next_cursor, or narrow the other conditions.',
                }
              : {}),
          };
        });
      }),
  );

  server.registerTool(
    'list_audit_presets',
    {
      title: 'List audit presets',
      description:
        "Saved audit searches of the active organization: yours and the ones colleagues shared. Use one with " +
        'search_audit_log(preset). Needs `audit: read`.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return explainRefusals({ action: 'list audit presets', ...auditRead }, async () => ({
          presets: (await presets.list()).map(summarizePreset),
        }));
      }),
  );

  server.registerTool(
    'create_audit_preset',
    {
      title: 'Save an audit search',
      description:
        'Save an audit search (query or filters, plus match_scope) under a name, private to you or shared with the ' +
        'organization (sharing cannot be undone). Names are unique per author. Needs `audit: read`.',
      inputSchema: {
        name: z.string().min(1).max(150),
        query: querySchema.optional(),
        filters: filtersSchema.optional(),
        match_scope: matchScopeSchema.optional(),
        shared: z.boolean().default(false).describe('Share with everyone in the organization who may read the audit trail.'),
      },
    },
    async ({ name, query, filters, match_scope, shared }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const body: AuditPresetBody = { ...exclusiveFilter(query, filters), ...(match_scope !== undefined ? { match_scope } : {}) };
        return explainRefusals({ action: 'save the audit preset', ...auditRead }, async () => ({
          preset: summarizePreset(await presets.create(name, body, shared)),
        }));
      }),
  );

  server.registerTool(
    'update_audit_preset',
    {
      title: 'Update an audit preset',
      description:
        'Rename one of YOUR audit presets, replace its search (query / filters / match_scope — the editor\'s saved ' +
        'panel layout is dropped with it), or share it (one-way). Needs `audit: read`.',
      inputSchema: {
        preset: idOrName.describe('Your preset: id or name.'),
        name: z.string().min(1).max(150).optional(),
        query: querySchema.optional(),
        filters: filtersSchema.optional(),
        match_scope: matchScopeSchema.optional(),
        share: z.literal(true).optional().describe('Share it with the organization (cannot be undone).'),
      },
    },
    async ({ preset, name, query, filters, match_scope, share }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const filter = exclusiveFilter(query, filters);
        const searchChanged = Object.keys(filter).length > 0 || match_scope !== undefined;
        if (name === undefined && !searchChanged && share === undefined) {
          throw new Error('Nothing to change — pass name, query / filters / match_scope and/or share.');
        }
        return explainRefusals({ action: 'update the audit preset', ...auditRead, notFound: 'only the author can change a preset' }, async () => {
          const current = await resolvePreset(preset);
          if (!current.is_owner) throw new Error(`"${current.name}" is ${current.created_by_name}'s preset — only its author can change it.`);
          const currentSearch = searchBodyOf(current);
          const filterBody: AuditPresetBody | undefined = searchChanged
            ? {
                // A new filter replaces the old one entirely; otherwise the old one stays.
                ...(Object.keys(filter).length > 0
                  ? filter
                  : currentSearch.query !== undefined
                    ? { query: currentSearch.query }
                    : currentSearch.filters !== undefined
                      ? { filters: currentSearch.filters }
                      : {}),
                ...((match_scope ?? currentSearch.match_scope) !== undefined ? { match_scope: match_scope ?? currentSearch.match_scope } : {}),
              }
            : undefined;
          const updated = await presets.update(current.id, {
            ...(name !== undefined ? { name } : {}),
            ...(filterBody !== undefined ? { filter_body: filterBody } : {}),
            ...(share ? { is_shared: true as const } : {}),
          });
          return { preset: summarizePreset(updated) };
        });
      }),
  );

  server.registerTool(
    'delete_audit_preset',
    {
      title: 'Delete an audit preset',
      description: 'Delete one of YOUR audit presets for good (no recycle bin); colleagues lose it too if it was shared.',
      inputSchema: {
        preset: idOrName.describe('Your preset: id or name.'),
      },
    },
    async ({ preset }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return explainRefusals({ action: 'delete the audit preset', ...auditRead, notFound: 'only the author can delete a preset' }, async () => {
          const current = await resolvePreset(preset);
          if (!current.is_owner) throw new Error(`"${current.name}" is ${current.created_by_name}'s preset — only its author can delete it.`);
          await presets.delete(current.id);
          return { deleted: { id: current.id, name: current.name } };
        });
      }),
  );
}
