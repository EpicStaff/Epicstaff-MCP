import { z } from 'zod';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import { GraphsApi } from '../api/graphs.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { LlmApi } from '../api/llm.js';
import { SurfacesApi } from '../api/surfaces.js';
import { ToolsApi } from '../api/tools.js';
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
];
function summarizeGraph(graph) {
    const raw = graph;
    const nodes = {};
    for (const key of NODE_LIST_KEYS) {
        const list = raw[key];
        if (Array.isArray(list) && list.length > 0) {
            nodes[key] = list.map((node) => ({
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
export function registerReferenceTools(server, context) {
    const llm = new LlmApi(context.client);
    const tools = new ToolsApi(context.client);
    const knowledge = new KnowledgeApi(context.client);
    const surfaces = new SurfacesApi(context.client);
    const agentDefinitions = new AgentDefinitionsApi(context.client);
    const graphs = new GraphsApi(context.client);
    server.registerTool('list_agents', {
        title: 'List agent definitions',
        description: 'List AgentDefinitions in the active organization (id, name, instructions excerpt, llm_config, default surfaces). ' +
            'Check here before defining a new agent in flow source — reuse via existing: "<name>".',
        inputSchema: {},
    }, async () => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const definitions = await agentDefinitions.list();
        return definitions.map((definition) => ({
            id: definition.id,
            name: definition.name,
            description: definition.description,
            instructions: definition.instructions.length > 200
                ? `${definition.instructions.slice(0, 200)}…`
                : definition.instructions,
            llm_config: definition.llm_config,
            default_surfaces: definition.default_surfaces,
        }));
    }));
    server.registerTool('list_surfaces', {
        title: 'List surfaces',
        description: 'List catalog surfaces (reusable tool/file/knowledge bundles agents are allowed to touch). ' +
            'owner_agent set = agent-specific (attachable only to that agent); null = shared. ' +
            'Check here before defining a new surface — reuse via existing: "<name>".',
        inputSchema: {},
    }, async () => runTool(async () => {
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
    }));
    server.registerTool('list_llm_configs', {
        title: 'List LLM configs',
        description: 'List LLM configs (what agents reference as llm_config). Includes the org default when available.',
        inputSchema: {},
    }, async () => runTool(async () => {
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
    }));
    server.registerTool('list_llm_models', {
        title: 'List LLM models and providers',
        description: 'List available LLM models with their providers — needed when creating a new llm_config.',
        inputSchema: {},
    }, async () => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const [providers, models] = await Promise.all([llm.listProviders(), llm.listModels()]);
        const providerName = new Map(providers.map((provider) => [provider.id, provider.name]));
        return models.map((model) => ({
            id: model.id,
            name: model.name,
            provider: providerName.get(model.llm_provider) ?? model.llm_provider,
        }));
    }));
    server.registerTool('list_tools', {
        title: 'List tools',
        description: 'List all three tool kinds agents can use: configured built-in tools, python-code tools, MCP tools. ' +
            'Surfaces reference python/MCP tools by id.',
        inputSchema: {},
    }, async () => runTool(async () => {
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
    }));
    server.registerTool('list_graphs', {
        title: 'List flows (graphs)',
        description: 'List flow graphs in the active organization (id, name, description, tags, save_version).',
        inputSchema: {},
    }, async () => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const list = await graphs.listLight();
        return list.map((graph) => ({
            id: graph.id,
            name: graph.name,
            description: graph.description,
            tags: graph.tags,
            save_version: graph.save_version,
        }));
    }));
    server.registerTool('describe_graph', {
        title: 'Describe a flow graph',
        description: 'Human-readable structural summary of a remote flow graph: nodes per type, edges, and the entities ' +
            'its agent/task nodes reference. Use to inspect a flow before pulling or editing it.',
        inputSchema: {
            graph_id: z.number().int(),
        },
    }, async ({ graph_id }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const graph = await graphs.get(graph_id);
        return summarizeGraph(graph);
    }));
    server.registerTool('list_source_collections', {
        title: 'List knowledge collections',
        description: 'List knowledge (RAG) source collections with their indexing status. ' +
            'Surfaces reference collections in their knowledge[] entries.',
        inputSchema: {},
    }, async () => runTool(async () => {
        await context.auth.ensureAuthenticated();
        return knowledge.listCollections();
    }));
}
