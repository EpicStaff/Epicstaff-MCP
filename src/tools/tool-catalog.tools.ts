import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { LABEL_COLORS, LabelsApi, type LabelScope, type PatchLabelRequest } from '../api/labels.js';
import { SecretsApi } from '../api/secrets.js';
import {
  type CreateMcpToolRequest,
  type CreatePythonCodeToolRequest,
  type PythonCodeToolCode,
  ToolsApi,
} from '../api/tools.js';
import { VenvsApi } from '../api/venvs.js';
import { describeUser } from '../models/authorship.js';
import { runTool } from './auth-org.tools.js';
import { createOrExplainConflict, idOrName, recycleBinHint, resolveNamedRef } from './catalog-helpers.js';

/**
 * Standalone tool catalog: custom python tools, MCP tools and the label trees (flow labels and tool
 * labels). Surfaces grant tools to agents; flows reference tools via existing: "<name>".
 */

const labelScopeSchema = z
  .enum(['flow', 'tool'])
  .describe('Which label tree: "flow" labels tag flows, "tool" labels tag python and MCP tools.');

const pythonCodeShape = {
  code: z.string().optional().describe('Inline Python source defining the entrypoint. Exactly one of code / code_file.'),
  code_file: z.string().optional().describe('Absolute path of a local .py file to upload as the code.'),
  entrypoint: z.string().optional().describe('Function the tool calls (default "main").'),
  venv: idOrName
    .nullable()
    .optional()
    .describe('Virtual environment the code runs in (list_venvs): id or name; null = the default venv.'),
  secrets: z
    .array(idOrName)
    .optional()
    .describe('Org secrets the code may read (id or name). Code that reads an undeclared secret is refused.'),
  execution_timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Seconds one run may take (get_settings → execution_timeout_limits; above the max is saved as the max).'),
} as const;

const toolLabelsSchema = z.array(idOrName).optional().describe('Tool labels (list_labels scope "tool"): id or name/full path.');

export function registerToolCatalogTools(server: McpServer, context: AppContext): void {
  const tools = new ToolsApi(context.client);
  const labels = new LabelsApi(context.client);
  const venvs = new VenvsApi(context.client);
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const secrets = (): SecretsApi => new SecretsApi(context.client, context.auth);

  const resolvePythonTool = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Python tool', () => tools.listPythonCodeTools(), (tool) => tool.id, (tool) => tool.name);
  const resolveMcpTool = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'MCP tool', () => tools.listMcpTools(), (tool) => tool.id, (tool) => tool.name);
  const resolveLabel = (scope: LabelScope, ref: number | string): Promise<number> =>
    resolveNamedRef(ref, `${scope} label`, () => labels.list(scope), (label) => label.id, (label) => label.full_path);
  const resolveLabels = (refs: Array<number | string> | undefined): Promise<number[] | undefined> =>
    refs === undefined ? Promise.resolve(undefined) : Promise.all(refs.map((ref) => resolveLabel('tool', ref)));
  const resolveVenvId = async (ref: number | string | null | undefined): Promise<number | null | undefined> =>
    ref === undefined || ref === null
      ? ref
      : resolveNamedRef(ref, 'Venv', () => venvs.list(), (venv) => venv.id, (venv) => venv.name);
  const resolveSecretIds = async (refs: Array<number | string> | undefined): Promise<number[] | undefined> => {
    if (refs === undefined) return undefined;
    if (refs.every((ref) => typeof ref === 'number')) return refs as number[];
    const all = await secrets().list();
    return Promise.all(
      refs.map((ref) => resolveNamedRef(ref, 'Secret', async () => all, (secret) => secret.id, (secret) => secret.name)),
    );
  };

  /** The python_code fields the caller stated (create fills the rest with the frontend defaults). */
  async function buildPythonCode(input: {
    code?: string;
    code_file?: string;
    entrypoint?: string;
    venv?: number | string | null;
    secrets?: Array<number | string>;
    execution_timeout?: number;
  }): Promise<Partial<PythonCodeToolCode>> {
    if (input.code !== undefined && input.code_file !== undefined) {
      throw new Error('Pass either code or code_file, not both.');
    }
    let code = input.code;
    if (input.code_file !== undefined) {
      if (!isAbsolute(input.code_file)) throw new Error('code_file must be an absolute path.');
      if (!existsSync(input.code_file)) throw new Error(`No file at ${input.code_file}.`);
      code = readFileSync(input.code_file, 'utf8');
    }
    const venvId = await resolveVenvId(input.venv);
    const secretIds = await resolveSecretIds(input.secrets);
    return {
      ...(code !== undefined ? { code } : {}),
      ...(input.entrypoint !== undefined ? { entrypoint: input.entrypoint } : {}),
      ...(venvId !== undefined ? { venv_id: venvId } : {}),
      ...(secretIds !== undefined ? { secret_ids: secretIds } : {}),
      ...(input.execution_timeout !== undefined ? { execution_timeout: input.execution_timeout } : {}),
    };
  }

  // ----- Python tools ----------------------------------------------------------

  server.registerTool(
    'create_python_tool',
    {
      title: 'Create a python tool',
      description:
        'Create a custom python tool agents can call (granted through a surface). Its code runs in the sandbox, in ' +
        'the venv you name (third-party packages come from the venv). Names are org-unique. Flows reference it via ' +
        'existing: "<name>".',
      inputSchema: {
        name: z.string().min(1).describe('Org-unique tool name — what the LLM sees as the tool name.'),
        description: z.string().min(1).describe('What the tool does — shown to the LLM deciding whether to call it.'),
        ...pythonCodeShape,
        variables: z.array(z.unknown()).optional().describe('Tool variables (free-form JSON list), default [].'),
        use_storage: z.boolean().optional().describe('Whether the code may access org file storage.'),
        labels: toolLabelsSchema,
      },
    },
    async ({ name, description, variables, use_storage, labels: labelRefs, ...codeInput }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const pythonCode = await buildPythonCode(codeInput);
        if (pythonCode.code === undefined) throw new Error('Pass code or code_file.');
        const labelIds = await resolveLabels(labelRefs);
        // CreatePythonCodeBody: the frontend always sends venv_id (null = default) and global_kwargs.
        const request: CreatePythonCodeToolRequest = {
          name,
          description,
          variables: variables ?? [],
          python_code: {
            code: pythonCode.code,
            entrypoint: pythonCode.entrypoint ?? 'main',
            venv_id: pythonCode.venv_id ?? null,
            global_kwargs: {},
            ...(pythonCode.secret_ids !== undefined ? { secret_ids: pythonCode.secret_ids } : {}),
            ...(pythonCode.execution_timeout !== undefined ? { execution_timeout: pythonCode.execution_timeout } : {}),
          },
          ...(use_storage !== undefined ? { use_storage } : {}),
          ...(labelIds !== undefined ? { labels: labelIds } : {}),
        };
        const created = await createOrExplainConflict(() => tools.createPythonCodeTool(request), name, 'update_python_tool');
        return { tool: { id: created.id, name: created.name }, next: `Grant it to agents through a surface (python_tools: ["${name}"]).` };
      }),
  );

  server.registerTool(
    'update_python_tool',
    {
      title: 'Update a python tool',
      description:
        'Change a custom python tool (PATCH — only what you pass changes; secrets and labels, when passed, replace ' +
        'the current lists). Built-in catalog tools accept label changes only.',
      inputSchema: {
        tool: idOrName.describe('The tool: backend id or exact name (list_tools).'),
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        ...pythonCodeShape,
        variables: z.array(z.unknown()).optional(),
        use_storage: z.boolean().optional(),
        labels: toolLabelsSchema,
      },
    },
    async ({ tool, name, description, variables, use_storage, labels: labelRefs, ...codeInput }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const toolId = await resolvePythonTool(tool);
        const pythonCode = await buildPythonCode(codeInput);
        const labelIds = await resolveLabels(labelRefs);
        const request: Partial<CreatePythonCodeToolRequest> = {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(variables !== undefined ? { variables } : {}),
          ...(use_storage !== undefined ? { use_storage } : {}),
          ...(labelIds !== undefined ? { labels: labelIds } : {}),
          // A partial python_code: the backend applies only the fields it receives.
          ...(Object.keys(pythonCode).length > 0 ? { python_code: pythonCode as PythonCodeToolCode } : {}),
        };
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass at least one field.');
        const updated = await tools.updatePythonCodeTool(toolId, request);
        return {
          tool: {
            id: updated.id,
            name: updated.name,
            venv_id: updated.python_code?.venv_id ?? null,
            labels: updated.labels ?? [],
            last_edited_by: describeUser(updated.last_edited_by),
          },
        };
      }),
  );

  server.registerTool(
    'delete_python_tool',
    {
      title: 'Delete a python tool',
      description:
        'Delete a custom python tool: it moves to the recycle bin (restorable with restore_from_recycle_bin kind ' +
        '"python_tool"). Surfaces and flows granting it lose it while it is binned; a flow referencing it via ' +
        'existing: fails its next push. Built-in tools cannot be deleted.',
      inputSchema: {
        tool: idOrName.describe('The tool: backend id or exact name.'),
      },
    },
    async ({ tool }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const toolId = await resolvePythonTool(tool);
        const current = await tools.getPythonCodeTool(toolId);
        if (current.built_in === true) throw new Error(`"${current.name}" is a built-in catalog tool and cannot be deleted.`);
        await tools.deletePythonCodeTool(toolId);
        return { deleted: { id: toolId, name: current.name }, next: recycleBinHint('python_tool', toolId) };
      }),
  );

  // ----- MCP tools ---------------------------------------------------------------

  const mcpToolShape = {
    transport: z.string().url().describe('http(s) URL of the remote MCP server (SSE).'),
    tool_name: z.string().min(1).describe('Name of the tool on that MCP server.'),
    timeout: z.number().min(1).max(1800).optional().describe('Request timeout in seconds (1–1800, default 30).'),
    init_timeout: z.number().positive().optional().describe('Connection/initialisation timeout in seconds.'),
    auth_secret: idOrName
      .nullable()
      .optional()
      .describe('Org secret holding the server credential (id or name); null removes it.'),
    labels: toolLabelsSchema,
  } as const;

  async function buildMcpToolBody(input: {
    transport?: string;
    tool_name?: string;
    timeout?: number;
    init_timeout?: number;
    auth_secret?: number | string | null;
    labels?: Array<number | string>;
  }): Promise<Partial<CreateMcpToolRequest>> {
    const secretIds = input.auth_secret == null ? undefined : await resolveSecretIds([input.auth_secret]);
    const labelIds = await resolveLabels(input.labels);
    return {
      ...(input.transport !== undefined ? { transport: input.transport } : {}),
      ...(input.tool_name !== undefined ? { tool_name: input.tool_name } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
      ...(input.init_timeout !== undefined ? { init_timeout: input.init_timeout } : {}),
      ...(input.auth_secret === null ? { auth_secret_id: null } : {}),
      ...(secretIds?.[0] !== undefined ? { auth_secret_id: secretIds[0] } : {}),
      ...(labelIds !== undefined ? { labels: labelIds } : {}),
    };
  }

  server.registerTool(
    'create_mcp_tool',
    {
      title: 'Create an MCP tool',
      description:
        'Register one tool of a remote MCP server (reached over http(s)/SSE) so agents can call it through a surface. ' +
        'Names are org-unique. stdio MCP servers cannot be registered — EpicStaff connects to a URL.',
      inputSchema: {
        name: z.string().min(1).describe('Org-unique name of this tool entry.'),
        ...mcpToolShape,
      },
    },
    async ({ name, ...input }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const request = { name, ...(await buildMcpToolBody(input)) } as CreateMcpToolRequest;
        const created = await createOrExplainConflict(() => tools.createMcpTool(request), name, 'update_mcp_tool');
        return { tool: created, next: `Grant it to agents through a surface (mcp_tools: ["${name}"]).` };
      }),
  );

  server.registerTool(
    'update_mcp_tool',
    {
      title: 'Update an MCP tool',
      description: 'Change an MCP tool entry (PATCH — only what you pass changes; labels, when passed, replace the list).',
      inputSchema: {
        tool: idOrName.describe('The tool: backend id or exact name (list_tools).'),
        name: z.string().min(1).optional(),
        transport: mcpToolShape.transport.optional(),
        tool_name: mcpToolShape.tool_name.optional(),
        timeout: mcpToolShape.timeout,
        init_timeout: mcpToolShape.init_timeout,
        auth_secret: mcpToolShape.auth_secret,
        labels: mcpToolShape.labels,
      },
    },
    async ({ tool, name, ...input }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const toolId = await resolveMcpTool(tool);
        const request = { ...(name !== undefined ? { name } : {}), ...(await buildMcpToolBody(input)) };
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass at least one field.');
        return { tool: await tools.updateMcpTool(toolId, request) };
      }),
  );

  server.registerTool(
    'delete_mcp_tool',
    {
      title: 'Delete an MCP tool',
      description:
        'Delete an MCP tool entry: it moves to the recycle bin (restorable with restore_from_recycle_bin kind ' +
        '"mcp_tool"). Surfaces granting it lose it while it is binned.',
      inputSchema: {
        tool: idOrName.describe('The tool: backend id or exact name.'),
      },
    },
    async ({ tool }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const toolId = await resolveMcpTool(tool);
        const current = await tools.getMcpTool(toolId);
        await tools.deleteMcpTool(toolId);
        return { deleted: { id: toolId, name: current.name }, next: recycleBinHint('mcp_tool', toolId) };
      }),
  );

  // ----- Labels -------------------------------------------------------------------

  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description:
        'List the flow labels or tool labels of the active organization (a tree: full_path is "parent/child"). ' +
        'Tag flows with set_flow_labels, tools with the labels field of create/update_python_tool / _mcp_tool.',
      inputSchema: { scope: labelScopeSchema },
    },
    async ({ scope }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return (await labels.list(scope)).map((label) => ({
          id: label.id,
          name: label.name,
          full_path: label.full_path,
          parent: label.parent,
          color: label.metadata?.color ?? 'default',
        }));
      }),
  );

  server.registerTool(
    'create_label',
    {
      title: 'Create a label',
      description: 'Create a flow or tool label, optionally nested under a parent label. Names are unique per parent.',
      inputSchema: {
        scope: labelScopeSchema,
        name: z.string().min(1).max(100),
        parent: idOrName.optional().describe('Parent label of the same scope: id or full path.'),
        color: z.enum(LABEL_COLORS).optional(),
      },
    },
    async ({ scope, name, parent, color }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const parentId = parent !== undefined ? await resolveLabel(scope, parent) : undefined;
        return createOrExplainConflict(
          () =>
            labels.create(scope, {
              name,
              ...(parentId !== undefined ? { parent: parentId } : {}),
              ...(color !== undefined ? { metadata: { color } } : {}),
            }),
          name,
          'update_label',
        );
      }),
  );

  server.registerTool(
    'update_label',
    {
      title: 'Update a label',
      description: 'Rename a label, move it under another parent (null = top level) or change its color.',
      inputSchema: {
        scope: labelScopeSchema,
        label: idOrName.describe('The label: id or full path.'),
        name: z.string().min(1).max(100).optional(),
        parent: idOrName.nullable().optional(),
        color: z.enum(LABEL_COLORS).optional(),
      },
    },
    async ({ scope, label, name, parent, color }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const labelId = await resolveLabel(scope, label);
        const request: PatchLabelRequest = {
          ...(name !== undefined ? { name } : {}),
          ...(parent === null ? { parent: null } : {}),
          ...(parent != null ? { parent: await resolveLabel(scope, parent) } : {}),
          ...(color !== undefined ? { metadata: { color } } : {}),
        };
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass name, parent or color.');
        return labels.patch(scope, labelId, request);
      }),
  );

  server.registerTool(
    'delete_label',
    {
      title: 'Delete a label',
      description:
        'Delete a label for good together with its child labels. Flows/tools keep existing — they only lose the tag.',
      inputSchema: {
        scope: labelScopeSchema,
        label: idOrName.describe('The label: id or full path.'),
      },
    },
    async ({ scope, label }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const labelId = await resolveLabel(scope, label);
        await labels.delete(scope, labelId);
        return { deleted: { scope, id: labelId } };
      }),
  );
}
