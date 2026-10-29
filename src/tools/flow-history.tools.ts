import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { GraphVersionsApi } from '../api/graph-versions.js';
import { GraphsApi } from '../api/graphs.js';
import { ImportExportApi, type TransferKind } from '../api/import-export.js';
import { LabelsApi } from '../api/labels.js';
import { runTool } from './auth-org.tools.js';
import { idOrName, recycleBinHint, resolveNamedRef } from './catalog-helpers.js';

/**
 * Flow lifecycle beyond push: versions (named snapshots + restore), copy, delete, labels on a flow,
 * export / import of flows and tools as EpicStaff export documents, and the persistent variables a
 * flow carries across sessions.
 */

const transferKindSchema = z
  .enum(['flow', 'python_tool', 'mcp_tool'])
  .default('flow')
  .describe('What the export document holds: flows (default), python tools or MCP tools.');

export function registerFlowHistoryTools(server: McpServer, context: AppContext): void {
  const graphs = new GraphsApi(context.client);
  const versions = new GraphVersionsApi(context.client);
  const transfer = new ImportExportApi(context.client);
  const labels = new LabelsApi(context.client);

  const openInEditor = (graphId: number): string => `${context.config.apiUrl.replace(/\/api\/$/, '')}/flows/${graphId}`;

  // ----- Versions -----------------------------------------------------------

  server.registerTool(
    'list_graph_versions',
    {
      title: 'List flow versions',
      description:
        'List the saved versions (named snapshots) of one flow, newest first. Restore one with restore_graph_version.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the flow (list_graphs).'),
      },
    },
    async ({ graph_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return versions.list(graph_id);
      }),
  );

  server.registerTool(
    'create_graph_version',
    {
      title: 'Save a flow version',
      description:
        'Save the current state of a flow as a named version (snapshot) — take one before a risky push or edit so ' +
        'restore_graph_version can roll back. Snapshots never contain secret values.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the flow.'),
        name: z.string().min(1).max(255).describe('Version name, e.g. "before refactor".'),
        description: z.string().optional().describe('What this version captures.'),
      },
    },
    async ({ graph_id, name, description }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const version = await versions.create({ graph_id, name, ...(description !== undefined ? { description } : {}) });
        return { version, next: `Roll back later with restore_graph_version(version_id: ${version.id}).` };
      }),
  );

  server.registerTool(
    'restore_graph_version',
    {
      title: 'Restore a flow version',
      description:
        'Bring a saved version back. mode "overwrite" (default) rewrites the version\'s own flow in place — by ' +
        'default the current state is saved as a backup version first; it is refused when the flow changed since ' +
        'the save_version it was checked against. mode "new_flow" leaves the flow untouched and creates a new, ' +
        'independent flow from the version. Nodes whose dependencies (agents, tools …) are gone are skipped and ' +
        'listed in warnings. After an overwrite, a local flow source of that flow is stale: pull_flow it again.',
      inputSchema: {
        version_id: z.number().int().describe('Backend id of the version (list_graph_versions).'),
        mode: z.enum(['overwrite', 'new_flow']).default('overwrite'),
        backup: z
          .boolean()
          .default(true)
          .describe('overwrite only: save the current state as a version first (default true, like the editor).'),
        save_version: z
          .number()
          .int()
          .optional()
          .describe(
            'overwrite only: the flow save_version you expect. Omitted → the current one is read just before restoring.',
          ),
      },
    },
    async ({ version_id, mode, backup, save_version }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if (mode === 'new_flow') {
          const created = await versions.createGraph(version_id);
          return { ...created, openInEditor: openInEditor(created.graph_id) };
        }
        const version = await versions.get(version_id);
        const expectedSaveVersion = save_version ?? (await graphs.get(version.graph_id)).save_version;
        const restored = await versions.restore(version_id, expectedSaveVersion, backup);
        return {
          ...restored,
          version: { id: version.id, name: version.name },
          openInEditor: openInEditor(restored.graph_id),
          next:
            'The flow was rewritten — a local flow source of it is now stale: pull_flow into a fresh directory ' +
            (restored.auto_backup_version_id != null
              ? `(the previous state is version #${restored.auto_backup_version_id}).`
              : '(no backup version was taken).'),
        };
      }),
  );

  // ----- Copy / delete / labels ------------------------------------------------

  server.registerTool(
    'copy_flow',
    {
      title: 'Copy a flow',
      description:
        'Duplicate a flow under a new name (same nodes, edges and references to org entities). The copy is ' +
        'independent of the source. Copying a flow with trigger nodes needs flow "use" permission.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the flow to copy.'),
        name: z.string().min(1).describe('Name of the new flow.'),
      },
    },
    async ({ graph_id, name }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const copy = await graphs.copy(graph_id, name);
        return { graphId: copy.id, name: copy.name, openInEditor: openInEditor(copy.id) };
      }),
  );

  server.registerTool(
    'delete_flow',
    {
      title: 'Delete a flow',
      description:
        'Delete a flow: it moves to the recycle bin (restorable with restore_from_recycle_bin kind "flow" until ' +
        'purged). Flows that embed it as a subflow are listed in the result — they fail to run while it is binned. ' +
        'A local flow source that pushed it re-creates a new flow on its next push.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the flow to delete.'),
      },
    },
    async ({ graph_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const flow = await graphs.get(graph_id);
        const usage = await graphs.subflowUsage(graph_id);
        await graphs.delete(graph_id);
        return {
          deleted: { id: graph_id, name: flow.name },
          ...(usage.parent_flow_ids.length > 0 ? { usedAsSubflowBy: usage.parent_flow_ids } : {}),
          next: recycleBinHint('flow', graph_id),
        };
      }),
  );

  server.registerTool(
    'set_flow_labels',
    {
      title: 'Set the labels of a flow',
      description:
        'Replace the labels a flow carries (flow labels — list_labels scope "flow"). Pass [] to clear them.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the flow.'),
        labels: z.array(idOrName).describe('Flow labels by id or exact name / full path ("parent/child").'),
      },
    },
    async ({ graph_id, labels: labelRefs }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const flowLabels = labelRefs.length > 0 ? await labels.list('flow') : [];
        const labelIds = await Promise.all(
          labelRefs.map((ref) =>
            resolveNamedRef(ref, 'Flow label', async () => flowLabels, (label) => label.id, (label) => label.full_path),
          ),
        );
        const flow = await graphs.get(graph_id);
        // PATCH is optimistically locked like bulk-save — save_version is mandatory.
        const updated = await graphs.patch(graph_id, { save_version: flow.save_version, label_ids: labelIds });
        return { graphId: graph_id, label_ids: updated.label_ids ?? labelIds, saveVersion: updated.save_version };
      }),
  );

  // ----- Export / import --------------------------------------------------------

  server.registerTool(
    'export_entities',
    {
      title: 'Export flows or tools to a file',
      description:
        'Write an EpicStaff export document (the editor\'s Export) for one or more flows, python tools or MCP tools ' +
        'to a local .json file. It carries everything they depend on (agents, LLM configs, tools …) so import_entities ' +
        'can recreate them in another organization or instance. Secret values are never exported; entities you may ' +
        'not export are left out and listed in `excluded`. Unlike dump_graph this is the portable import/export format. ' +
        'Refuses to overwrite an existing file unless overwrite: true, and never writes through a symbolic link.',
      inputSchema: {
        kind: transferKindSchema,
        ids: z.array(z.number().int()).min(1).max(100).describe('Backend ids to export (one file for all).'),
        output_path: z.string().describe('Absolute path of the .json file to write (parent dirs are created).'),
        overwrite: z
          .boolean()
          .default(false)
          .describe('Replace output_path when it already exists (a symbolic link is still refused).'),
      },
    },
    async ({ kind, ids, output_path, overwrite }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if (!isAbsolute(output_path) || extname(output_path).toLowerCase() !== '.json') {
          throw new Error('output_path must be an absolute path to a .json file.');
        }
        // Checked before the export so a refused path costs no request; writeExportFile re-checks atomically.
        assertWritableExportPath(output_path, overwrite);
        const result = await transfer.export(kind as TransferKind, ids);
        const body = `${JSON.stringify(result.document, null, 2)}\n`;
        mkdirSync(dirname(output_path), { recursive: true });
        writeExportFile(output_path, body, overwrite);
        return {
          output_path,
          kind,
          ids,
          bytes: body.length,
          excluded: result.excluded,
          next: 'Recreate it elsewhere with import_entities(kind, file_path).',
        };
      }),
  );

  server.registerTool(
    'import_entities',
    {
      title: 'Import flows or tools from a file',
      description:
        'Import an EpicStaff export document (from export_entities or the editor\'s Export) into the active ' +
        'organization. inspect_only: true first reports what the import would ask about, creating nothing. Flows: ' +
        'by default every import creates new copies; preserve_uuids + replace_existing overwrite the flows with the ' +
        'same uuid in place (needs flow update permission). Secrets are not in export files — re-attach credentials ' +
        'after importing.',
      inputSchema: {
        kind: transferKindSchema,
        file_path: z.string().describe('Absolute path of the export .json file.'),
        inspect_only: z.boolean().default(false).describe('Dry run: report what would be imported, change nothing.'),
        preserve_uuids: z.boolean().default(false).describe('Flows only: keep the file\'s uuids.'),
        replace_existing: z
          .boolean()
          .default(false)
          .describe('Flows only: overwrite flows with the same uuid in place (requires preserve_uuids).'),
        import_labels: z.boolean().default(true).describe('Recreate the file\'s labels and tag the imports with them.'),
      },
    },
    async ({ kind, file_path, inspect_only, preserve_uuids, replace_existing, import_labels }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if (!isAbsolute(file_path)) throw new Error('file_path must be an absolute path.');
        if (!existsSync(file_path)) throw new Error(`No file at ${file_path}.`);
        if (kind !== 'flow' && (preserve_uuids || replace_existing)) {
          throw new Error('preserve_uuids / replace_existing apply to flow imports only.');
        }
        if (replace_existing && !preserve_uuids) {
          throw new Error('replace_existing requires preserve_uuids: true (the backend matches flows by uuid).');
        }
        if (inspect_only) {
          return { inspected: await transfer.inspect(kind as TransferKind, file_path) };
        }
        const result = await transfer.import(kind as TransferKind, file_path, {
          preserveUuids: preserve_uuids,
          replaceExisting: replace_existing,
          importLabels: import_labels,
        });
        return { imported: result, next: 'Check the created entities (list_graphs / list_tools) and re-attach secrets.' };
      }),
  );

  // ----- Persistent state ---------------------------------------------------------

  server.registerTool(
    'get_flow_persistent_state',
    {
      title: 'Read a flow\'s persistent variables',
      description:
        'Read the values a flow carries across sessions: its organization-scoped persistent variables and the ' +
        'per-member ones (`persistent_variables` in flow source). Read-only — EpicStaff exposes no write route; ' +
        'the values change only when the flow runs. Use it to debug a flow that remembers state.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the flow.'),
      },
    },
    async ({ graph_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const [organizationStates, userStates] = await Promise.all([
          graphs.listOrganizationStates(),
          graphs.listOrganizationUserStates(),
        ]);
        const organization = organizationStates.find((state) => state.graph === graph_id);
        return {
          graphId: graph_id,
          organization: organization
            ? { persistent_variables: organization.persistent_variables, user_variables_seed: organization.user_variables }
            : null,
          users: userStates
            .filter((state) => state.graph === graph_id)
            .map((state) => ({
              organization_user: state.organization_user,
              persistent_variables: state.persistent_variables,
            })),
        };
      }),
  );
}

/** Same wording as pull_flow's refusal to overwrite a flow source. */
function existingFileError(outputPath: string): Error {
  return new Error(
    `${outputPath} already exists — export to a new path, or pass overwrite: true if you really want to replace it.`,
  );
}

/**
 * Refuse a path that exists unless `overwrite` is set, and always refuse a symbolic link (writing
 * through it would replace whatever file it points at).
 */
function assertWritableExportPath(outputPath: string, overwrite: boolean): void {
  let stats;
  try {
    stats = lstatSync(outputPath);
  } catch {
    return; // nothing there yet
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${outputPath} is a symbolic link — refusing to write through it. Pick a regular file path.`);
  }
  if (!overwrite) throw existingFileError(outputPath);
  if (!stats.isFile()) throw new Error(`${outputPath} exists and is not a regular file.`);
}

/**
 * Write the export: `wx` (create-only, fails on any existing entry — a symlink included) by default;
 * with `overwrite`, truncate in place without following a symbolic link where the platform has O_NOFOLLOW.
 */
function writeExportFile(outputPath: string, body: string, overwrite: boolean): void {
  const flags = overwrite
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0)
    : 'wx';
  let descriptor: number;
  try {
    descriptor = openSync(outputPath, flags, 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw existingFileError(outputPath);
    if (code === 'ELOOP') throw new Error(`${outputPath} is a symbolic link — refusing to write through it.`);
    throw error;
  }
  try {
    // writeFileSync on a descriptor writes until the whole body is out.
    writeFileSync(descriptor, body, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}
