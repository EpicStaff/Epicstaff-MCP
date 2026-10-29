import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import {
  BUILDING_STATUSES,
  VENV_LIBRARY_SPECIFICATION_PATTERN,
  VENV_LIBRARY_VERSION_PATTERN,
  VENV_NAME_PATTERN,
  type Venv,
  type VenvLib,
  VenvsApi,
} from '../api/venvs.js';
import { runTool } from './auth-org.tools.js';
import { idOrName, resolveNamedRef } from './catalog-helpers.js';

/**
 * Virtual environments — the venvs python nodes and python tools run in (`venv:` in flow source).
 * A venv is built asynchronously by the sandbox after create/update: its status goes
 * declared → processing → completed | failed.
 */

const venvNameSchema = z
  .string()
  .min(1)
  .regex(VENV_NAME_PATTERN, 'venv names contain only letters, digits, spaces, "_" and "-"');

const libraryObjectSchema = z.strictObject({
  name: z.string().min(1).describe('Package name as on PyPI, e.g. "requests".'),
  specification: z
    .string()
    .regex(VENV_LIBRARY_SPECIFICATION_PATTERN, 'a PEP 440 specifier set, e.g. ">=2.31,<3"')
    .optional()
    .describe('PEP 440 specifier set the version must satisfy, e.g. ">=2.31,<3". Empty = any version.'),
  version: z
    .string()
    .regex(VENV_LIBRARY_VERSION_PATTERN, 'a PEP 440 version, e.g. 2.31.0')
    .optional()
    .describe('Exact version to pin. Omit to let the build pick the newest one the specification allows.'),
  description: z.string().optional().describe('Why the venv carries this package.'),
});

const librarySchema = z
  .union([z.string().min(1), libraryObjectSchema])
  .describe(
    'A requirement string ("pandas", "requests>=2.31", "numpy==1.26.4") or {name, specification?, version?, description?}.',
  );

type LibraryInput = z.infer<typeof librarySchema>;

const REQUIREMENT_OPERATOR = /[<>=!~]/;

/**
 * Turn a friendly library entry into the wire `VenvLib` (venv-dialog buildPayload: trimmed name and
 * specification, empty version / description sent as null). A requirement string splits at its
 * first operator: "requests>=2.31" → name "requests", specification ">=2.31".
 */
export function toVenvLib(entry: LibraryInput): VenvLib {
  if (typeof entry !== 'string') {
    return {
      name: entry.name.trim(),
      specification: (entry.specification ?? '').trim(),
      version: entry.version?.trim() || null,
      description: entry.description?.trim() || null,
    };
  }
  const requirement = entry.trim();
  const operatorAt = requirement.search(REQUIREMENT_OPERATOR);
  const name = (operatorAt === -1 ? requirement : requirement.slice(0, operatorAt)).trim();
  const specification = operatorAt === -1 ? '' : requirement.slice(operatorAt).replace(/\s+/g, '');
  if (name === '') {
    throw new Error(`"${entry}" names no package — write it like "requests>=2.31".`);
  }
  if (specification !== '' && !VENV_LIBRARY_SPECIFICATION_PATTERN.test(specification)) {
    throw new Error(`"${entry}": "${specification}" is not a PEP 440 specifier set (e.g. ">=2.31,<3").`);
  }
  return { name, specification, version: null, description: null };
}

/** A venv as tool output: libraries as readable requirement strings. */
export function summarizeVenv(venv: Venv): Record<string, unknown> {
  return {
    id: venv.id,
    name: venv.name,
    status: venv.status,
    ...(venv.error ? { error: venv.error } : {}),
    libraries: venv.libs.map(
      (lib) => `${lib.name}${lib.specification}${lib.version ? ` (installed ${lib.version})` : ''}`,
    ),
    owner: venv.owner ? (venv.owner.display_name ?? venv.owner.email) : null,
    created_at: venv.created_at,
  };
}

function buildStatusNext(venv: Venv): string {
  if (BUILDING_STATUSES.has(venv.status)) {
    return (
      `The venv is building (${venv.status}). Reference it from flow source with venv: "${venv.name}" now — code ` +
      'that runs in it waits for the build; poll list_venvs to see it reach "completed" (or "failed" with an error).'
    );
  }
  return `Reference it from a python node or python tool with venv: "${venv.name}".`;
}

export function registerVenvTools(server: McpServer, context: AppContext): void {
  const venvs = new VenvsApi(context.client);
  const resolveVenv = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Venv', () => venvs.list(), (venv) => venv.id, (venv) => venv.name);

  server.registerTool(
    'list_venvs',
    {
      title: 'List virtual environments',
      description:
        'List the virtual environments (venvs) of the active organization: name, build status, libraries. ' +
        'Python nodes and python tools run in a venv (flow source `venv: "<name>"`; omitted = the default venv). ' +
        'Check here before create_venv — reuse a venv that already has the packages.',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring of the venv name.'),
      },
    },
    async ({ search }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return (await venvs.list(search ? { search } : {})).map(summarizeVenv);
      }),
  );

  server.registerTool(
    'create_venv',
    {
      title: 'Create a virtual environment',
      description:
        'Create a venv holding third-party Python packages, for python nodes / python tools to run in. ' +
        'The sandbox builds it asynchronously (status declared → processing → completed | failed). ' +
        'Reference it from flow source with venv: "<name>" (the replacement for the removed `libraries:` list).',
      inputSchema: {
        name: venvNameSchema.describe('Venv name (letters, digits, spaces, "_" and "-"). Keep it unique in the org.'),
        libraries: z
          .array(librarySchema)
          .default([])
          .describe('Packages to install, e.g. ["pandas", "requests>=2.31"]. A package may appear once.'),
      },
    },
    async ({ name, libraries }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const libs = libraries.map(toVenvLib);
        const sameName = (await venvs.findByName(name)).length;
        const venv = await venvs.create({ name, libs });
        return {
          venv: summarizeVenv(venv),
          ...(sameName > 0
            ? {
                warning:
                  `${sameName} other venv(s) already carry the name "${name}" — venv: "${name}" in flow source is now ` +
                  'ambiguous and refused at push. Rename one with update_venv.',
              }
            : {}),
          next: buildStatusNext(venv),
        };
      }),
  );

  server.registerTool(
    'update_venv',
    {
      title: 'Update a virtual environment',
      description:
        'Rename a venv and/or replace its library list (PATCH). A changed library list triggers a rebuild; code ' +
        'that runs in the venv waits for it. Renaming breaks flow sources that reference the old name via venv:.',
      inputSchema: {
        venv: idOrName.describe('The venv to update: backend id or exact name (list_venvs).'),
        name: venvNameSchema.optional().describe('New name.'),
        libraries: z
          .array(librarySchema)
          .optional()
          .describe('The COMPLETE new library list — it replaces the current one, it does not append.'),
      },
    },
    async ({ venv, name, libraries }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if (name === undefined && libraries === undefined) {
          throw new Error('Nothing to change — pass name and/or libraries.');
        }
        const venvId = await resolveVenv(venv);
        const updated = await venvs.update(venvId, {
          ...(name !== undefined ? { name } : {}),
          ...(libraries !== undefined ? { libs: libraries.map(toVenvLib) } : {}),
        });
        return { venv: summarizeVenv(updated), next: buildStatusNext(updated) };
      }),
  );

  server.registerTool(
    'delete_venv',
    {
      title: 'Delete a virtual environment',
      description:
        'Delete a venv for good (venvs have no recycle bin). Refused while any python code still runs in it — ' +
        'including tools or nodes sitting in the recycle bin. Move that code to another venv first.',
      inputSchema: {
        venv: idOrName.describe('The venv to delete: backend id or exact name.'),
      },
    },
    async ({ venv }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const venvId = await resolveVenv(venv);
        const current = await venvs.get(venvId);
        try {
          await venvs.delete(venvId);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            throw new Error(
              `venv "${current.name}" is still in use and was not deleted: ${error.bodyExcerpt ?? error.message}`,
            );
          }
          throw error;
        }
        return {
          deleted: { id: venvId, name: current.name },
          next: `Flow sources that reference venv: "${current.name}" now fail to push — change or remove that key.`,
        };
      }),
  );
}
