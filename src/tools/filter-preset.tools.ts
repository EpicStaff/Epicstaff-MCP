import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  FILTER_BODY_KEYS,
  type FilterPreset,
  type FilterPresetScope,
  FilterPresetsApi,
  type FilterPresetUpdate,
} from '../api/filter-presets.js';
import { runTool } from './auth-org.tools.js';
import { idOrName, resolveNamedRef } from './catalog-helpers.js';

/**
 * Saved filters of the EpicStaff flows and tools list pages. A preset is private to the user who saved
 * it (in the active organization) and only ever shapes what those pages show — it changes no flow or
 * tool. Useful when a user asks for a ready-made view ("flows labelled billing, newest first").
 */

const scopeSchema = z
  .enum(['flow', 'tool'])
  .describe('Which list page: "flow" (the flows page) or "tool" (the tools page).');

const filterBodySchema = z
  .record(z.unknown())
  .describe(
    'The page filter state. flow keys: sortOrder ("default" | "name_asc" | "name_desc" | "last_modified"), ' +
      'includedFlowIds (number[] | null = all), includedLabelIds (number[] | null = all), customConditions ' +
      '(condition groups | null). tool keys: showFavoriteOnly, showNotFavoriteOnly, sourceBuiltIn, sourceCustom, ' +
      'unusedOnly (booleans), usageBuckets (subset of "agent_surface", "shared_surface", "inline_surface"), ' +
      'sortOrder ("default" | "last_modified" | "name_asc" | "name_desc" | "most_used" | "unused_first"), ' +
      'includedToolIds, includedLabelIds (number[] | null), customConditions. Any other key is rejected.',
  );

const presetRefSchema = idOrName.describe('The preset: its id or exact name (list_filter_presets).');

function summarizePreset(scope: FilterPresetScope, preset: FilterPreset): Record<string, unknown> {
  return {
    scope,
    id: preset.id,
    name: preset.name,
    filter_body: preset.filter_body,
    updated_at: preset.updated_at,
  };
}

export function registerFilterPresetTools(server: McpServer, context: AppContext): void {
  const presets = new FilterPresetsApi(context.client);
  const resolvePreset = (scope: FilterPresetScope, ref: number | string): Promise<number> =>
    resolveNamedRef(ref, `${scope} filter preset`, () => presets.list(scope), (preset) => preset.id, (preset) => preset.name);

  server.registerTool(
    'list_filter_presets',
    {
      title: 'List saved list filters',
      description:
        'List your saved filters of the EpicStaff flows or tools page (private to you, in the active organization). ' +
        `filter_body keys — flow: ${FILTER_BODY_KEYS.flow.join(', ')}; tool: ${FILTER_BODY_KEYS.tool.join(', ')}.`,
      inputSchema: { scope: scopeSchema },
    },
    async ({ scope }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return (await presets.list(scope)).map((preset) => summarizePreset(scope, preset));
      }),
  );

  server.registerTool(
    'create_filter_preset',
    {
      title: 'Save a list filter',
      description:
        'Save a named filter of the EpicStaff flows or tools page for yourself. Names are unique per user and ' +
        'organization. It only shapes what the page lists — no flow or tool changes.',
      inputSchema: {
        scope: scopeSchema,
        name: z.string().min(1).max(150),
        filter_body: filterBodySchema,
      },
    },
    async ({ scope, name, filter_body }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        // A taken name is a 400 that says so ("You already have a preset with this name.").
        return summarizePreset(scope, await presets.create(scope, { name, filter_body }));
      }),
  );

  server.registerTool(
    'update_filter_preset',
    {
      title: 'Update a saved list filter',
      description: 'Rename a saved filter and/or replace its filter_body (the whole body: keys you leave out are dropped).',
      inputSchema: {
        scope: scopeSchema,
        preset: presetRefSchema,
        name: z.string().min(1).max(150).optional(),
        filter_body: filterBodySchema.optional(),
      },
    },
    async ({ scope, preset, name, filter_body }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const changes: FilterPresetUpdate = {
          ...(name !== undefined ? { name } : {}),
          ...(filter_body !== undefined ? { filter_body } : {}),
        };
        if (Object.keys(changes).length === 0) throw new Error('Nothing to change — pass name or filter_body.');
        const presetId = await resolvePreset(scope, preset);
        return summarizePreset(scope, await presets.update(scope, presetId, changes));
      }),
  );

  server.registerTool(
    'delete_filter_preset',
    {
      title: 'Delete a saved list filter',
      description: 'Delete one of your saved filters for good (it is not binned). The flows or tools it matched are untouched.',
      inputSchema: {
        scope: scopeSchema,
        preset: presetRefSchema,
      },
    },
    async ({ scope, preset }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const presetId = await resolvePreset(scope, preset);
        await presets.delete(scope, presetId);
        return { deleted: { scope, id: presetId } };
      }),
  );
}
