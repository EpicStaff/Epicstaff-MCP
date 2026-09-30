import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import { GraphsApi } from '../api/graphs.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { LlmApi } from '../api/llm.js';
import { SurfacesApi } from '../api/surfaces.js';
import { ToolsApi } from '../api/tools.js';
import type { GraphDto } from '../models/graph.js';
import { NODE_REFERENCE } from '../reference/node-reference.js';
import { introspectNodeSchemas } from '../reference/node-schema-introspect.js';
import { runTool } from './auth-org.tools.js';

/**
 * Read-only reference lookups — the discovery layer behind the reuse-first policy.
 * es-write-flow consults these before defining anything new, so flow sources can
 * use `existing: "<name>"` references instead of duplicating entities.
 */
const NODE_LIST_KEYS = [
  'start_node_list',
  'agent_node_list',
  'task_node_list',
  'python_node_list',
  'crew_node_list',
  'end_node_list',
  'graph_note_list',
  'file_extractor_node_list',
  'subgraph_node_list',
  'webhook_trigger_node_list',
  'telegram_trigger_node_list',
  'schedule_trigger_node_list',
  'decision_table_node_list',
  'classification_decision_table_node_list',
  'audio_transcription_node_list',
] as const;

function summarizeGraph(graph: GraphDto): Record<string, unknown> {
  const raw = graph as unknown as Record<string, unknown>;
  const nodes: Record<string, Array<Record<string, unknown>>> = {};
  for (const key of NODE_LIST_KEYS) {
    const list = raw[key];
    if (Array.isArray(list) && list.length > 0) {
      nodes[key] = list.map((node: Record<string, unknown>) => ({
        id: node.id,
        node_name: node.node_name,
        ...(node.agent_definition !== undefined && { agent_definition: node.agent_definition }),
        ...(node.surface_list !== undefined && { surface_list: node.surface_list }),
        ...(node.crew_id !== undefined && { crew_id: node.crew_id }),
      }));
    }
  }
  return {
    id: graph.id,
    name: graph.name,
    description: graph.description,
    save_version: graph.save_version,
    nodes,
    edges: (graph.edge_list ?? []).map((edge) => ({
      id: edge.id,
      start_node_id: edge.start_node_id,
      end_node_id: edge.end_node_id,
    })),
    conditional_edges: (graph.conditional_edge_list ?? []).length,
  };
}

export function registerReferenceTools(server: McpServer, context: AppContext): void {
  const llm = new LlmApi(context.client);
  const tools = new ToolsApi(context.client);
  const knowledge = new KnowledgeApi(context.client);
  const surfaces = new SurfacesApi(context.client);
  const agentDefinitions = new AgentDefinitionsApi(context.client);
  const graphs = new GraphsApi(context.client);

  server.registerTool(
    'describe_node_types',
    {
      title: 'Describe flow node types',
      description:
        'The catalog of node types you can write in flow source: each type\'s fields (name, description, ' +
        'required) derived from the schema, plus a summary, when to use it, and runtime caveats the ' +
        'compiler does not catch. Offline — needs no backend or auth. Call this before authoring a node ' +
        'type you are unsure about. Pass `type` for one node; omit for the full catalog.',
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe('A single node type to describe, e.g. "agent" or "decision-table". Omit for all.'),
      },
    },
    async ({ type }) =>
      runTool(async () => {
        const catalog = introspectNodeSchemas().map((info) => ({
          ...info,
          ...NODE_REFERENCE[info.type],
        }));
        if (type !== undefined) {
          const one = catalog.find((node) => node.type === type);
          if (one === undefined) {
            throw new Error(
              `unknown node type '${type}'. Available: ${catalog.map((node) => node.type).join(', ')}`,
            );
          }
          return one;
        }
        return { node_types: catalog };
      }),
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List agent definitions',
      description:
        'List AgentDefinitions in the active organization (id, name, instructions excerpt, llm_config, default surfaces). ' +
        'Check here before defining a new agent in flow source — reuse via existing: "<name>".',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const definitions = await agentDefinitions.list();
        return definitions.map((definition) => ({
          id: definition.id,
          name: definition.name,
          description: definition.description,
          instructions:
            definition.instructions.length > 200
              ? `${definition.instructions.slice(0, 200)}…`
              : definition.instructions,
          llm_config: definition.llm_config,
          default_surfaces: definition.default_surfaces,
        }));
      }),
  );

  server.registerTool(
    'list_surfaces',
    {
      title: 'List surfaces',
      description:
        'List catalog surfaces (reusable tool/file/knowledge bundles agents are allowed to touch). ' +
        'owner_agent set = agent-specific (attachable only to that agent); null = shared. ' +
        'Check here before defining a new surface — reuse via existing: "<name>".',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const list = await surfaces.list();
        return list.map((surface) => ({
          id: surface.id,
          name: surface.name,
          description: surface.description,
          owner_agent: surface.owner_agent,
          python_tools: surface.python_tools.length,
          mcp_tools: surface.mcp_tools.length,
          storage_items: surface.storage_items.length,
          knowledge: surface.knowledge.length,
        }));
      }),
  );

  server.registerTool(
    'list_llm_configs',
    {
      title: 'List LLM configs',
      description:
        'List LLM configs (what agents reference as llm_config). Includes the org default when available.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const [configs, defaultConfig] = await Promise.all([llm.listConfigs(), llm.getDefaultConfig()]);
        return {
          default: defaultConfig ? { id: defaultConfig.id, custom_name: defaultConfig.custom_name } : null,
          configs: configs.map((config) => ({
            id: config.id,
            custom_name: config.custom_name,
            model: config.model,
          })),
        };
      }),
  );

  server.registerTool(
    'list_llm_models',
    {
      title: 'List LLM models and providers',
      description:
        'List available LLM models with their providers — needed when creating a new llm_config. ' +
        'The full catalog is large (thousands of models), so results are filtered and capped: pass ' +
        '`search` to match model name (case-insensitive substring) and/or `provider` to match provider ' +
        'name, and `limit` to cap the count (default 50). The response reports total matches and how many ' +
        'were returned so you can narrow the search.',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring to match against the model name.'),
        provider: z.string().optional().describe('Case-insensitive substring to match against the provider name.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max models to return (default 50).'),
      },
    },
    async ({ search, provider, limit }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const [providers, models] = await Promise.all([llm.listProviders(), llm.listModels()]);
        const providerName = new Map(providers.map((p) => [p.id, p.name]));

        const searchLower = search?.toLowerCase();
        const providerLower = provider?.toLowerCase();
        const cap = limit ?? 50;

        const matches = models
          .map((model) => ({
            id: model.id,
            name: model.name,
            provider: providerName.get(model.llm_provider) ?? String(model.llm_provider),
          }))
          .filter((model) => {
            if (searchLower && !model.name.toLowerCase().includes(searchLower)) return false;
            if (providerLower && !model.provider.toLowerCase().includes(providerLower)) return false;
            return true;
          });

        return {
          total_matches: matches.length,
          returned: Math.min(matches.length, cap),
          truncated: matches.length > cap,
          models: matches.slice(0, cap),
        };
      }),
  );

  server.registerTool(
    'list_tools',
    {
      title: 'List tools',
      description:
        'List all three tool kinds agents can use: configured built-in tools, python-code tools, MCP tools. ' +
        'Surfaces reference python/MCP tools by id.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const [toolConfigs, pythonCodeTools, mcpTools] = await Promise.all([
          tools.listToolConfigs(),
          tools.listPythonCodeTools(),
          tools.listMcpTools(),
        ]);
        return {
          tool_configs: toolConfigs.map((tool) => ({ id: tool.id, name: tool.name, tool: tool.tool })),
          python_code_tools: pythonCodeTools.map((tool) => ({ id: tool.id, name: tool.name, description: tool.description })),
          mcp_tools: mcpTools.map((tool) => ({ id: tool.id, name: tool.name, tool_name: tool.tool_name })),
        };
      }),
  );

  server.registerTool(
    'list_graphs',
    {
      title: 'List flows (graphs)',
      description: 'List flow graphs in the active organization (id, name, description, tags, save_version).',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const list = await graphs.listLight();
        return list.map((graph) => ({
          id: graph.id,
          name: graph.name,
          description: graph.description,
          tags: graph.tags,
          save_version: graph.save_version,
        }));
      }),
  );

  server.registerTool(
    'describe_graph',
    {
      title: 'Describe a flow graph',
      description:
        'Human-readable structural summary of a remote flow graph: nodes per type, edges, and the entities ' +
        'its agent/task nodes reference. Use to inspect a flow before pulling or editing it.',
      inputSchema: {
        graph_id: z.number().int(),
      },
    },
    async ({ graph_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const graph = await graphs.get(graph_id);
        return summarizeGraph(graph);
      }),
  );

  server.registerTool(
    'list_source_collections',
    {
      title: 'List knowledge collections',
      description:
        'List knowledge (RAG) source collections with their indexing status. ' +
        'Surfaces reference collections in their knowledge[] entries.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return knowledge.listCollections();
      }),
  );
}
