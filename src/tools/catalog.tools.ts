import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { EpicStaffClient } from '../http/client.js';
import { ApiError } from '../http/errors.js';
import { AgentDefinitionsApi, type CreateAgentDefinitionRequest } from '../api/agent-definitions.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { LlmApi } from '../api/llm.js';
import { SurfacesApi, type CreateSurfaceRequest, type Surface } from '../api/surfaces.js';
import { ToolsApi } from '../api/tools.js';
import { runTool } from './auth-org.tools.js';

/**
 * Standalone CRUD for the org-scoped catalog — agents, surfaces, knowledge
 * collections — managed WITHOUT authoring a flow. Flows then reference these by
 * name via `{ existing: "<name>" }`, so a catalog entity built here is reused,
 * never redefined, at push time.
 *
 * Every reference input (agent.llm_config, agent.default_surfaces,
 * surface.owner_agent, surface tools/knowledge, rag embedder/llm_config) accepts
 * either a numeric backend id or the exact name of an existing entity; names are
 * resolved (case-insensitive) via the same list endpoints the flow pusher uses.
 */

// ---------------------------------------------------------------------------
// Shared Zod pieces (friendly input shapes, modeled on flow-source/schema/*).
// ---------------------------------------------------------------------------

/** A reference: a backend id (number) or the exact name (string) of an existing entity. */
const idOrName = z.union([z.number().int(), z.string().min(1)]);

const toolModeSchema = z
  .enum(['allow', 'deny'])
  .default('allow')
  .describe('Tool permission. "deny" hard-wins over "allow" when surfaces combine.');

const triStateSchema = z
  .enum(['allow', 'unset', 'deny'])
  .default('unset')
  .describe('Tri-state storage permission. When surfaces combine: deny > allow > unset.');

const surfaceToolEntrySchema = z.strictObject({
  tool: idOrName.describe('Python/MCP tool: backend id or exact tool name (see list_tools).'),
  mode: toolModeSchema,
});

const surfaceStorageItemSchema = z.strictObject({
  storage_file: z.number().int().describe('Backend id of the org storage file this entry governs.'),
  can_list: triStateSchema,
  can_view: triStateSchema,
  can_edit: triStateSchema,
  can_delete: triStateSchema,
});

const surfaceKnowledgeEntrySchema = z.strictObject({
  collection: idOrName.describe('Knowledge collection: backend id or exact collection name.'),
  naive_search_config: z.record(z.string(), z.unknown()).optional(),
  graph_basic_search_config: z.record(z.string(), z.unknown()).optional(),
  graph_local_search_config: z.record(z.string(), z.unknown()).optional(),
});

/** Shared editable body of a catalog surface (create replaces, update merges). */
const surfaceBodyShape = {
  description: z.string().optional().describe('What this surface bundles and why.'),
  instructions: z
    .string()
    .optional()
    .describe('Extra instructions injected into an agent when this surface is attached.'),
  owner_agent: idOrName
    .nullable()
    .optional()
    .describe(
      'Owning agent (id or name). Set ⇒ agent-specific (only that agent may attach it). null/omitted ⇒ shared.',
    ),
  allow_creation: z.boolean().optional().describe('Whether the agent may create new files in this surface.'),
  python_tools: z.array(surfaceToolEntrySchema).optional().describe('Python tool grants.'),
  mcp_tools: z.array(surfaceToolEntrySchema).optional().describe('MCP tool grants.'),
  storage_items: z.array(surfaceStorageItemSchema).optional().describe('Per-file storage permissions.'),
  knowledge: z.array(surfaceKnowledgeEntrySchema).optional().describe('Knowledge collections this surface exposes.'),
} as const;

type SurfaceBodyInput = {
  description?: string;
  instructions?: string;
  owner_agent?: number | string | null;
  allow_creation?: boolean;
  python_tools?: Array<{ tool: number | string; mode: 'allow' | 'deny' }>;
  mcp_tools?: Array<{ tool: number | string; mode: 'allow' | 'deny' }>;
  storage_items?: Array<{
    storage_file: number;
    can_list: 'allow' | 'unset' | 'deny';
    can_view: 'allow' | 'unset' | 'deny';
    can_edit: 'allow' | 'unset' | 'deny';
    can_delete: 'allow' | 'unset' | 'deny';
  }>;
  knowledge?: Array<{
    collection: number | string;
    naive_search_config?: Record<string, unknown>;
    graph_basic_search_config?: Record<string, unknown>;
    graph_local_search_config?: Record<string, unknown>;
  }>;
};

const ragInputSchema = z.strictObject({
  strategy: z.enum(['naive', 'graph']).describe('RAG strategy: "naive" vector search or "graph" RAG.'),
  embedder: idOrName.optional().describe('Embedding config: id or name. Org default when omitted.'),
  llm_config: idOrName
    .optional()
    .describe('LLM config (id or name) used to build/query the graph. REQUIRED for strategy "graph".'),
  chunk_size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Chunk size in tokens. Backend default when omitted (naive: 1000, graph: 1200).'),
  chunk_overlap: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Chunk overlap in tokens. Backend default when omitted (naive: 150, graph: 100).'),
  entity_types: z
    .array(z.string().min(1))
    .nonempty()
    .optional()
    .describe(
      'Graph strategy only. Entity categories the extraction LLM is instructed to find ' +
        '(backend default ["organization", "person", "geo", "event"]). Match these to the ' +
        'corpus domain — unlisted concept types are often not extracted and stay invisible ' +
        'to graph search.',
    ),
  max_gleanings: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe(
      'Graph strategy only. Re-ask passes for missed entities per chunk (backend default 1). ' +
        'Each increment adds roughly one full extraction pass of LLM cost.',
    ),
});

// ---------------------------------------------------------------------------
// Reference resolution (id-or-name → backend id), mirroring the pusher lookup.
// ---------------------------------------------------------------------------

async function resolveNamedRef<T>(
  ref: number | string,
  entityLabel: string,
  list: () => Promise<T[]>,
  idOf: (item: T) => number | undefined,
  nameOf: (item: T) => string,
): Promise<number> {
  if (typeof ref === 'number') return ref;
  const items = await list();
  const wanted = ref.trim().toLowerCase();
  const match = items.find((item) => nameOf(item).toLowerCase() === wanted);
  const id = match ? idOf(match) : undefined;
  if (id === undefined) {
    const available = items.map(nameOf).filter(Boolean).slice(0, 30).join(', ');
    throw new Error(
      `${entityLabel} "${ref}" not found in the active organization. Available: ${available || '(none)'}. ` +
        'Pass a numeric backend id or an exact existing name.',
    );
  }
  return id;
}

/**
 * Resolve the embedder for a RAG strategy. Number → used as-is; name → matched
 * against embedding-configs; omitted → the org default (ported from EntityPusher).
 */
async function resolveEmbedderRef(
  ref: number | string | undefined,
  llm: LlmApi,
  client: EpicStaffClient,
): Promise<number> {
  const configs = await llm.listEmbeddingConfigs();
  if (typeof ref === 'number') return ref;
  if (typeof ref === 'string') {
    const wanted = ref.trim().toLowerCase();
    const named = configs.find(
      (config) => String(config.custom_name ?? config.name ?? '').toLowerCase() === wanted,
    );
    if (named) return named.id as number;
    const available = configs
      .map((config) => String(config.custom_name ?? config.name ?? ''))
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `Embedding config "${ref}" not found in the organization. Available: ${available || '(none)'}.`,
    );
  }
  return resolveDefaultEmbedderId(configs, client);
}

async function resolveDefaultEmbedderId(
  configs: Array<Record<string, unknown>>,
  client: EpicStaffClient,
): Promise<number> {
  if (configs.length === 0) {
    throw new Error(
      'No embedding config exists in this organization — create one in EpicStaff settings ' +
        '(knowledge indexing needs an embedder), or pass rag.embedder explicitly.',
    );
  }
  const defaultConfig = await client
    .get<{ model?: number } | undefined>('default-embedding-config/')
    .catch(() => undefined);
  const defaultModelId = defaultConfig?.model;
  if (defaultModelId !== undefined) {
    const byModel = configs.find((config) => config.model === defaultModelId);
    if (byModel) return byModel.id as number;
  }
  if (configs.length === 1) return configs[0]!.id as number;
  const available = configs
    .map((config) => String(config.custom_name ?? config.name ?? ''))
    .filter(Boolean)
    .join(', ');
  throw new Error(
    'Cannot pick a default embedding config: the organization has several and none matches the ' +
      `configured default embedding model. Pass rag.embedder as one of: ${available}.`,
  );
}

// ---------------------------------------------------------------------------
// Org-unique-name handling on create.
// ---------------------------------------------------------------------------

/**
 * Detect a "name already exists" failure. Agents return 409
 * (agent_definition_conflict); surfaces surface a 400 whose body carries the
 * Django uniqueness message. Neither uses the structured errors[] array.
 */
function isAlreadyExistsError(error: ApiError): boolean {
  if (error.status === 409) return true;
  const haystack = [
    error.message,
    error.bodyExcerpt ?? '',
    ...(error.validationErrors?.map((issue) => `${issue.field} ${issue.reason}`) ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return /already exist|must be unique|unique constraint|duplicate|conflict/.test(haystack);
}

async function createOrExplainConflict<T>(
  create: () => Promise<T>,
  name: string,
  updateToolName: string,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (error instanceof ApiError && isAlreadyExistsError(error)) {
      throw new Error(
        `An entity named "${name}" already exists in this organization (catalog names are org-unique). ` +
          `Use ${updateToolName} to modify the existing one, or choose a different name.`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

export function registerCatalogTools(server: McpServer, context: AppContext): void {
  const surfaces = new SurfacesApi(context.client);
  const agents = new AgentDefinitionsApi(context.client);
  const knowledge = new KnowledgeApi(context.client);
  const llm = new LlmApi(context.client);
  const tools = new ToolsApi(context.client);

  const resolveAgent = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Agent', () => agents.list(), (agent) => agent.id, (agent) => agent.name);
  const resolveSurface = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Surface', () => surfaces.list(), (surface) => surface.id, (surface) => surface.name);
  const resolveLlmConfig = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'LLM config', () => llm.listConfigs(), (config) => config.id, (config) => config.custom_name);
  const resolveCollection = (ref: number | string): Promise<number> =>
    resolveNamedRef(
      ref,
      'Knowledge collection',
      () => knowledge.listCollections(),
      (collection) => collection.collection_id ?? collection.id,
      (collection) => collection.collection_name,
    );
  const resolvePythonTool = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Python tool', () => tools.listPythonCodeTools(), (tool) => tool.id, (tool) => tool.name);
  const resolveMcpTool = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'MCP tool', () => tools.listMcpTools(), (tool) => tool.id, (tool) => tool.name);

  /** Resolve a friendly surface body into the backend `CreateSurfaceRequest` wire shape. */
  async function buildSurfaceRequest(name: string, body: SurfaceBodyInput): Promise<CreateSurfaceRequest> {
    const request: CreateSurfaceRequest = { name };
    if (body.description !== undefined) request.description = body.description;
    if (body.instructions !== undefined) request.instructions = body.instructions;
    if (body.allow_creation !== undefined) request.allow_creation = body.allow_creation;
    if (body.owner_agent !== undefined) {
      request.owner_agent = body.owner_agent === null ? null : await resolveAgent(body.owner_agent);
    }
    if (body.python_tools !== undefined) {
      request.python_tools = await Promise.all(
        body.python_tools.map(async (entry) => ({
          python_tool: await resolvePythonTool(entry.tool),
          mode: entry.mode,
        })),
      );
    }
    if (body.mcp_tools !== undefined) {
      request.mcp_tools = await Promise.all(
        body.mcp_tools.map(async (entry) => ({
          mcp_tool: await resolveMcpTool(entry.tool),
          mode: entry.mode,
        })),
      );
    }
    if (body.storage_items !== undefined) {
      request.storage_items = body.storage_items.map((item) => ({ ...item }));
    }
    if (body.knowledge !== undefined) {
      const knowledgeEntries = await Promise.all(
        body.knowledge.map(async (entry) => ({
          collection: await resolveCollection(entry.collection),
          ...(entry.naive_search_config !== undefined && { naive_search_config: entry.naive_search_config }),
          ...(entry.graph_basic_search_config !== undefined && {
            graph_basic_search_config: entry.graph_basic_search_config,
          }),
          ...(entry.graph_local_search_config !== undefined && {
            graph_local_search_config: entry.graph_local_search_config,
          }),
        })),
      );
      // Search configs are opaque passthrough overrides at this layer; the backend
      // validates their shape. Widen from the structured wire type at the boundary.
      request.knowledge = knowledgeEntries as unknown as CreateSurfaceRequest['knowledge'];
    }
    return request;
  }

  // ----- Surfaces ----------------------------------------------------------

  server.registerTool(
    'create_surface',
    {
      title: 'Create a catalog surface',
      description:
        'Create a reusable catalog surface (a named bundle of tool/storage/knowledge grants + instructions ' +
        'that agents attach). Standalone — no flow needed. Reference it later from a flow via existing: "<name>". ' +
        'Names are org-unique; on a name clash use update_surface. ' +
        'Connect-both-ends recipe for an agent with a private surface: (1) create_surface, ' +
        '(2) create_agent with default_surfaces: [<surfaceId or name>], ' +
        '(3) update_surface owner_agent: <agentId> to make the surface agent-specific.',
      inputSchema: {
        name: z.string().min(1).describe('Org-unique surface name; the handle flows reference via existing:.'),
        ...surfaceBodyShape,
      },
    },
    async ({ name, ...body }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const request = await buildSurfaceRequest(name, body as SurfaceBodyInput);
        const created = await createOrExplainConflict(() => surfaces.create(request), name, 'update_surface');
        return {
          surface: created,
          next:
            'Reference this surface from a flow with existing: "' +
            name +
            '". To bind it to one agent: create_agent(default_surfaces:[' +
            created.id +
            ']) then update_surface(owner_agent: <agentId>).',
        };
      }),
  );

  server.registerTool(
    'update_surface',
    {
      title: 'Update a catalog surface',
      description:
        'Update an existing catalog surface. Fetches the current surface and merges the fields you provide ' +
        '(the backend PUT replaces the whole record, so unspecified fields are preserved from the current state). ' +
        'Provided list fields (python_tools, mcp_tools, storage_items, knowledge) REPLACE the existing list, not append.',
      inputSchema: {
        surface: idOrName.describe('The surface to update: backend id or exact current name.'),
        name: z.string().min(1).optional().describe('New name (rename). Omit to keep the current name.'),
        ...surfaceBodyShape,
      },
    },
    async ({ surface, name, ...body }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const surfaceId = await resolveSurface(surface);
        const current = await surfaces.get(surfaceId);
        const merged = mergeSurfaceBody(current, name, body as SurfaceBodyInput);
        const request = await buildSurfaceRequest(merged.name, merged.body);
        const updated = await surfaces.update(surfaceId, request);
        return { surface: updated };
      }),
  );

  server.registerTool(
    'get_surface',
    {
      title: 'Get a catalog surface',
      description: 'Fetch one catalog surface in full (tools, storage items, knowledge, owner) by id or exact name.',
      inputSchema: {
        surface: idOrName.describe('The surface to fetch: backend id or exact name.'),
      },
    },
    async ({ surface }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const surfaceId = await resolveSurface(surface);
        return surfaces.get(surfaceId);
      }),
  );

  server.registerTool(
    'delete_surface',
    {
      title: 'Delete a catalog surface',
      description:
        'Delete a catalog surface by id or exact name. IRREVERSIBLE and NOT flow-aware: any flow that references ' +
        'this surface via existing: "<name>" will FAIL its next push_flow (the reference will not resolve). ' +
        'Verify no flow depends on it first.',
      inputSchema: {
        surface: idOrName.describe('The surface to delete: backend id or exact name.'),
      },
    },
    async ({ surface }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const surfaceId = await resolveSurface(surface);
        const current = await surfaces.get(surfaceId);
        await surfaces.delete(surfaceId);
        return {
          deleted: { id: surfaceId, name: current.name },
          next:
            'WARNING: any flow referencing this surface via existing: "' +
            current.name +
            '" will fail its next push_flow. Update or remove those references.',
        };
      }),
  );

  // ----- Agents ------------------------------------------------------------

  server.registerTool(
    'create_agent',
    {
      title: 'Create an agent definition',
      description:
        'Create a reusable AgentDefinition (the first-class Agent entity) standalone — no flow needed. ' +
        'Reference it later from a flow agent node via existing: "<name>". Names are org-unique; on a clash use update_agent. ' +
        'llm_config and default_surfaces[].surface accept a backend id OR an existing name. ' +
        'Connect-both-ends recipe: create_surface first, then create_agent(default_surfaces:[<surface>]), ' +
        'then update_surface(owner_agent: <this agent>) to make the surface agent-specific.',
      inputSchema: {
        name: z.string().min(1).describe('Org-unique agent name; the handle flows reference via existing:.'),
        instructions: z.string().describe('Boot instructions — the agent system prompt.'),
        description: z.string().optional().describe('One-line summary of what this agent is for.'),
        llm_config: idOrName.describe('LLM config the agent thinks with: backend id or exact name (list_llm_configs).'),
        fcm_llm_config: idOrName.optional().describe('Separate LLM config for function calling: id or name.'),
        default_surfaces: z
          .array(
            z.strictObject({
              surface: idOrName.describe('Surface to attach by default: id or exact name.'),
              place: z.enum(['all', 'flow', 'chat']).default('all').describe('Where it applies.'),
            }),
          )
          .optional()
          .describe('Surfaces assigned to this agent by default, per usage place.'),
        max_iter: z.number().int().positive().optional().describe('Max reasoning/tool-call iterations per run.'),
        max_rpm: z.number().int().positive().optional().describe('Max LLM requests per minute (unlimited when omitted).'),
        max_execution_time: z.number().int().positive().optional().describe('Max execution time per run (seconds).'),
        cache: z.boolean().optional().describe('Whether tool-result caching is enabled.'),
        max_retry_limit: z.number().int().nonnegative().optional().describe('Max retries when an LLM call fails.'),
        default_temperature: z.number().optional().describe('Default sampling temperature.'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form metadata stored with the agent.'),
      },
    },
    async ({ name, ...body }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const request = await buildAgentRequest(name, body, {
          resolveLlmConfig,
          resolveSurface,
        });
        const created = await createOrExplainConflict(() => agents.create(request), name, 'update_agent');
        return {
          agent: created,
          next:
            'Reference this agent from a flow agent node with existing: "' +
            name +
            '". If it should own a private surface, call update_surface(owner_agent: ' +
            created.id +
            ').',
        };
      }),
  );

  server.registerTool(
    'update_agent',
    {
      title: 'Update an agent definition',
      description:
        'Partially update an existing AgentDefinition (PATCH — only the fields you pass change). ' +
        'default_surfaces, when provided, REPLACES the current list. llm_config and surfaces accept id or name.',
      inputSchema: {
        agent: idOrName.describe('The agent to update: backend id or exact current name.'),
        name: z.string().min(1).optional().describe('New name (rename).'),
        instructions: z.string().optional(),
        description: z.string().optional(),
        llm_config: idOrName.optional(),
        fcm_llm_config: idOrName.optional(),
        default_surfaces: z
          .array(
            z.strictObject({
              surface: idOrName,
              place: z.enum(['all', 'flow', 'chat']).default('all'),
            }),
          )
          .optional(),
        max_iter: z.number().int().positive().optional(),
        max_rpm: z.number().int().positive().optional(),
        max_execution_time: z.number().int().positive().optional(),
        cache: z.boolean().optional(),
        max_retry_limit: z.number().int().nonnegative().optional(),
        default_temperature: z.number().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ agent, ...body }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const agentId = await resolveAgent(agent);
        const request = await buildAgentPatch(body, { resolveLlmConfig, resolveSurface });
        const updated = await agents.update(agentId, request);
        return { agent: updated };
      }),
  );

  server.registerTool(
    'get_agent',
    {
      title: 'Get an agent definition',
      description: 'Fetch one AgentDefinition in full (instructions, llm configs, default surfaces) by id or exact name.',
      inputSchema: {
        agent: idOrName.describe('The agent to fetch: backend id or exact name.'),
      },
    },
    async ({ agent }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const agentId = await resolveAgent(agent);
        return agents.get(agentId);
      }),
  );

  server.registerTool(
    'delete_agent',
    {
      title: 'Delete an agent definition',
      description:
        'Delete an AgentDefinition by id or exact name. IRREVERSIBLE and NOT flow-aware: any flow that references ' +
        'this agent via existing: "<name>" will FAIL its next push_flow. Surfaces owned by this agent are ' +
        'cascade-deleted with it. Verify no flow depends on it first.',
      inputSchema: {
        agent: idOrName.describe('The agent to delete: backend id or exact name.'),
      },
    },
    async ({ agent }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const agentId = await resolveAgent(agent);
        const current = await agents.get(agentId);
        await agents.delete(agentId);
        return {
          deleted: { id: agentId, name: current.name },
          next:
            'WARNING: any flow referencing this agent via existing: "' +
            current.name +
            '" will fail its next push_flow. Surfaces owned by this agent were cascade-deleted.',
        };
      }),
  );

  // ----- Knowledge collections --------------------------------------------

  server.registerTool(
    'create_collection',
    {
      title: 'Create a knowledge collection',
      description:
        'Create a knowledge (RAG) source collection standalone — no flow needed — optionally uploading documents ' +
        'and attaching a RAG strategy in one call. Composes: create collection → upload documents → attach ' +
        'naive/graph RAG → start indexing. Reference it later from a surface via existing: "<name>". ' +
        'A standalone collection must FINISH indexing (poll wait_for_collections) before any flow that ' +
        'references it will retrieve from it. Collection names are not strictly unique, but reuse a name and ' +
        'documents accumulate — prefer upload_documents to add to an existing one.',
      inputSchema: {
        name: z.string().min(1).describe('Collection name; the handle surfaces/flows reference via existing:.'),
        documents: z
          .array(z.string().min(1))
          .optional()
          .describe('Absolute paths of local files to upload as documents.'),
        rag: ragInputSchema
          .optional()
          .describe('RAG strategy to attach and index. Omit to create an empty, un-indexed collection.'),
      },
    },
    async ({ name, documents, rag }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();

        // Validate document paths up front so a bad path never orphans an empty collection.
        if (documents && documents.length > 0) {
          const missing = documents.filter((path) => !existsSync(path));
          if (missing.length > 0) {
            throw new Error(`file(s) not found: ${missing.join(', ')}`);
          }
        }

        const collection = await knowledge.createCollection(name);
        const collectionId = collection.collection_id ?? collection.id;
        if (collectionId === undefined) {
          throw new Error('Backend did not return an id for the created collection.');
        }

        if (documents && documents.length > 0) {
          await knowledge.uploadDocuments(collectionId, documents);
        }

        const attached = rag ? await attachAndIndexRag(collectionId, rag, { knowledge, llm, client: context.client, resolveLlmConfig }) : undefined;

        return {
          collectionId,
          ragId: attached?.ragId,
          ragType: attached?.ragType,
          indexingStarted: attached !== undefined,
          next: attached
            ? `Indexing started. Poll wait_for_collections(collection_ids:[${collectionId}]) until complete — ` +
              'only then will a flow referencing this collection retrieve from it.'
            : 'Collection created empty. Add a RAG strategy with attach_rag, then wait_for_collections before use.',
        };
      }),
  );

  server.registerTool(
    'attach_rag',
    {
      title: 'Attach a RAG strategy to a collection',
      description:
        'Create (or idempotently update) a RAG strategy on an existing collection and start indexing it. ' +
        'Use after create_collection (when rag was omitted) or to add a second strategy. ' +
        'embedder and llm_config accept a backend id or an existing name; graph RAG requires llm_config.',
      inputSchema: {
        collection_id: z.number().int().describe('Backend id of the source collection (see list_source_collections).'),
        strategy: z.enum(['naive', 'graph']).describe('RAG strategy to attach.'),
        embedder: idOrName.optional().describe('Embedding config: id or name. Org default when omitted.'),
        llm_config: idOrName.optional().describe('LLM config (id or name). REQUIRED for strategy "graph".'),
        chunk_size: ragInputSchema.shape.chunk_size,
        chunk_overlap: ragInputSchema.shape.chunk_overlap,
        entity_types: ragInputSchema.shape.entity_types,
        max_gleanings: ragInputSchema.shape.max_gleanings,
      },
    },
    async ({ collection_id, strategy, embedder, llm_config, chunk_size, chunk_overlap, entity_types, max_gleanings }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        const attached = await attachAndIndexRag(
          collection_id,
          { strategy, embedder, llm_config, chunk_size, chunk_overlap, entity_types, max_gleanings },
          { knowledge, llm, client: context.client, resolveLlmConfig },
        );
        return {
          collectionId: collection_id,
          ragId: attached.ragId,
          ragType: attached.ragType,
          indexingStarted: true,
          next: `Indexing started. Poll wait_for_collections(collection_ids:[${collection_id}]) until complete.`,
        };
      }),
  );

  server.registerTool(
    'delete_collection',
    {
      title: 'Delete a knowledge collection',
      description:
        'Delete a knowledge source collection by id. IRREVERSIBLE: its documents, attached RAG strategies, and ' +
        'the pgvector index are dropped permanently. NOT flow-aware: any flow whose surface references this ' +
        'collection via existing: "<name>" will FAIL its next push_flow, and retrieval stops immediately. ' +
        'Verify no surface/flow depends on it first.',
      inputSchema: {
        collection_id: z.number().int().describe('Backend id of the source collection to delete.'),
      },
    },
    async ({ collection_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        context.org.requireActiveOrg();
        await knowledge.deleteCollection(collection_id);
        return {
          deleted: { collectionId: collection_id },
          next:
            'WARNING: the pgvector index was dropped irreversibly. Any surface/flow referencing this collection ' +
            'via existing: "<name>" will fail its next push_flow, and retrieval has stopped.',
        };
      }),
  );
}

// ---------------------------------------------------------------------------
// Body-building helpers (kept outside register for testability / brevity).
// ---------------------------------------------------------------------------

interface AgentResolvers {
  resolveLlmConfig: (ref: number | string) => Promise<number>;
  resolveSurface: (ref: number | string) => Promise<number>;
}

interface AgentBodyInput {
  instructions?: string;
  description?: string;
  llm_config?: number | string;
  fcm_llm_config?: number | string;
  default_surfaces?: Array<{ surface: number | string; place: 'all' | 'flow' | 'chat' }>;
  max_iter?: number;
  max_rpm?: number;
  max_execution_time?: number;
  cache?: boolean;
  max_retry_limit?: number;
  default_temperature?: number;
  metadata?: Record<string, unknown>;
}

async function resolveDefaultSurfaces(
  entries: Array<{ surface: number | string; place: 'all' | 'flow' | 'chat' }>,
  resolveSurface: (ref: number | string) => Promise<number>,
): Promise<Array<{ surface: number; place: 'all' | 'flow' | 'chat' }>> {
  return Promise.all(
    entries.map(async (entry) => ({ surface: await resolveSurface(entry.surface), place: entry.place })),
  );
}

async function buildAgentRequest(
  name: string,
  body: AgentBodyInput & { instructions: string; llm_config: number | string },
  resolvers: AgentResolvers,
): Promise<CreateAgentDefinitionRequest> {
  const request: CreateAgentDefinitionRequest = {
    name,
    instructions: body.instructions,
    llm_config: await resolvers.resolveLlmConfig(body.llm_config),
  };
  if (body.description !== undefined) request.description = body.description;
  if (body.fcm_llm_config !== undefined) request.fcm_llm_config = await resolvers.resolveLlmConfig(body.fcm_llm_config);
  if (body.default_surfaces !== undefined) {
    request.default_surfaces = await resolveDefaultSurfaces(body.default_surfaces, resolvers.resolveSurface);
  }
  assignAgentKnobs(request, body);
  return request;
}

async function buildAgentPatch(
  body: AgentBodyInput & { name?: string },
  resolvers: AgentResolvers,
): Promise<Partial<CreateAgentDefinitionRequest>> {
  const request: Partial<CreateAgentDefinitionRequest> = {};
  if (body.name !== undefined) request.name = body.name;
  if (body.instructions !== undefined) request.instructions = body.instructions;
  if (body.description !== undefined) request.description = body.description;
  if (body.llm_config !== undefined) request.llm_config = await resolvers.resolveLlmConfig(body.llm_config);
  if (body.fcm_llm_config !== undefined) request.fcm_llm_config = await resolvers.resolveLlmConfig(body.fcm_llm_config);
  if (body.default_surfaces !== undefined) {
    request.default_surfaces = await resolveDefaultSurfaces(body.default_surfaces, resolvers.resolveSurface);
  }
  assignAgentKnobs(request, body);
  return request;
}

function assignAgentKnobs(request: Partial<CreateAgentDefinitionRequest>, body: AgentBodyInput): void {
  if (body.max_iter !== undefined) request.max_iter = body.max_iter;
  if (body.max_rpm !== undefined) request.max_rpm = body.max_rpm;
  if (body.max_execution_time !== undefined) request.max_execution_time = body.max_execution_time;
  if (body.cache !== undefined) request.cache = body.cache;
  if (body.max_retry_limit !== undefined) request.max_retry_limit = body.max_retry_limit;
  if (body.default_temperature !== undefined) request.default_temperature = body.default_temperature;
  if (body.metadata !== undefined) request.metadata = body.metadata;
}

/**
 * Merge a partial update body over the current surface. Because the backend
 * update is a full PUT, unspecified scalar fields are re-sent from the current
 * record so they are not wiped; specified list fields replace outright.
 */
function mergeSurfaceBody(
  current: Surface,
  newName: string | undefined,
  body: SurfaceBodyInput,
): { name: string; body: SurfaceBodyInput } {
  const merged: SurfaceBodyInput = {
    description: body.description ?? current.description,
    instructions: body.instructions ?? current.instructions,
    allow_creation: body.allow_creation ?? current.allow_creation,
    owner_agent: body.owner_agent !== undefined ? body.owner_agent : current.owner_agent,
    python_tools:
      body.python_tools ?? current.python_tools.map((entry) => ({ tool: entry.python_tool, mode: entry.mode })),
    mcp_tools: body.mcp_tools ?? current.mcp_tools.map((entry) => ({ tool: entry.mcp_tool, mode: entry.mode })),
    storage_items: body.storage_items ?? current.storage_items.map((item) => ({ ...item })),
    // Re-send existing knowledge unchanged when the caller did not override it;
    // search configs are opaque passthrough here, so widen at the boundary.
    knowledge:
      body.knowledge ??
      (current.knowledge.map((entry) => ({
        collection: entry.collection,
        ...(entry.naive_search_config != null && { naive_search_config: entry.naive_search_config }),
        ...(entry.graph_basic_search_config != null && { graph_basic_search_config: entry.graph_basic_search_config }),
        ...(entry.graph_local_search_config != null && { graph_local_search_config: entry.graph_local_search_config }),
      })) as unknown as SurfaceBodyInput['knowledge']),
  };
  return { name: newName ?? current.name, body: merged };
}

interface RagContext {
  knowledge: KnowledgeApi;
  llm: LlmApi;
  client: EpicStaffClient;
  resolveLlmConfig: (ref: number | string) => Promise<number>;
}

async function attachAndIndexRag(
  collectionId: number,
  rag: {
    strategy: 'naive' | 'graph';
    embedder?: number | string;
    llm_config?: number | string;
    chunk_size?: number;
    chunk_overlap?: number;
    entity_types?: string[];
    max_gleanings?: number;
  },
  ctx: RagContext,
): Promise<{ ragId: number; ragType: 'naive' | 'graph' }> {
  const embedderId = await resolveEmbedderRef(rag.embedder, ctx.llm, ctx.client);
  if (rag.strategy === 'naive') {
    if (rag.entity_types !== undefined || rag.max_gleanings !== undefined) {
      throw new Error('entity_types and max_gleanings apply to graph RAG only — remove them or use strategy "graph".');
    }
    const ragId = await ctx.knowledge.createNaiveRag(collectionId, embedderId);
    await ctx.knowledge.applyNaiveDocumentChunking(ragId, {
      ...(rag.chunk_size !== undefined ? { chunk_size: rag.chunk_size } : {}),
      ...(rag.chunk_overlap !== undefined ? { chunk_overlap: rag.chunk_overlap } : {}),
    });
    await ctx.knowledge.startIndexing(ragId, 'naive');
    return { ragId, ragType: 'naive' };
  }
  if (rag.llm_config === undefined) {
    throw new Error('graph RAG requires llm_config (backend id or name of an LLM config).');
  }
  const llmId = await ctx.resolveLlmConfig(rag.llm_config);
  const ragId = await ctx.knowledge.createGraphRag(collectionId, embedderId, llmId);
  const indexConfig = {
    ...(rag.chunk_size !== undefined ? { chunk_size: rag.chunk_size } : {}),
    ...(rag.chunk_overlap !== undefined ? { chunk_overlap: rag.chunk_overlap } : {}),
    ...(rag.entity_types !== undefined ? { entity_types: rag.entity_types } : {}),
    ...(rag.max_gleanings !== undefined ? { max_gleanings: rag.max_gleanings } : {}),
  };
  if (Object.keys(indexConfig).length > 0) {
    await ctx.knowledge.updateGraphRagIndexConfig(ragId, indexConfig);
  }
  await ctx.knowledge.startIndexing(ragId, 'graph');
  return { ragId, ragType: 'graph' };
}
