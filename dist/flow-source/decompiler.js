/**
 * Flow decompiler — the pull path. Inverse of the compiler's emit
 * (src/compiler/emit.ts): where emit maps flow source → entity plans + graph
 * state, this maps a remote `GraphDto` (plus the entities its nodes reference)
 * back into flow-source YAML and a seeded lockfile, so a remote flow can be
 * edited locally and repushed in place.
 *
 * Strategy — SHALLOW PULL: every referenced entity (agent definition, surface,
 * llm config, python/MCP tool, knowledge collection, subgraph flow, crew) is
 * written as an `{existing: "<remote name>"}` reference. Those entities exist
 * remotely by definition, so referencing them is both simpler and safer than
 * re-authoring: the next push resolves them by name, never re-creates them,
 * and no entity content hashes have to be reconstructed — which guarantees an
 * unedited pull repushes as a no-op. Only the flow graph itself (nodes, edges,
 * pinned positions) is materialized locally. A "deep pull" that materializes
 * entity definitions locally is a future enhancement.
 *
 * Known lossy pulls (each emits a warning; none affect graph topology):
 *  - agent-node sub-tasks; task-node output_schema / remember_output;
 *  - python-node test_input / stream_config / use_storage;
 *  - webhook-trigger python code + input map; telegram-trigger bot token
 *    (a secret — set `bot_token_env` locally) and field mappings;
 *  - schedule-trigger schedule blocks (flow source only holds a cron string;
 *    a repush recreates the node as an inactive draft);
 *  - inline-surface storage items (numeric storage-file ids cannot be mapped
 *    back to paths without the storage API);
 *  - decision-table grid condition groups (flattened into one expression),
 *    manipulations and error routes; CDT prompts / pre-post computation /
 *    route codes; note background colors; edge waypoints.
 *
 * Lock seeding matches what the pusher writes (src/pusher/graph.ts): node
 * entries under `nodes.<node_name>` carry the backend id and `contentHash({})`
 * (the pusher never hashes node content), and conditional-edge entries under
 * `conditional_edges.<source_node_name>` hash the exact request body the next
 * compile + push would produce.
 */
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { contentHash, setEntity, writeLock, LOCKFILE_NAME } from './lockfile.js';
import { SYMBOLIC_NAME_PATTERN } from './schema/common.js';
export const FLOW_SOURCE_FILE_NAME = 'flow.yaml';
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function decompileFlow(deps, graphId, targetDir) {
    refuseExistingFlowFiles(targetDir);
    const dto = await deps.graphs.get(graphId);
    const warnings = [];
    const names = await fetchReferencedEntityNames(deps, dto);
    const registry = collectNodes(dto, warnings);
    const nodes = {};
    for (const collected of registry.nodes) {
        nodes[collected.name] = buildNodeBody(collected, registry, names, warnings);
    }
    const plainEdges = buildPlainEdges(dto, registry, warnings);
    const conditional = buildConditionalEdges(dto, registry, warnings);
    const document = {
        meta: {
            name: dto.name,
            ...(dto.description ? { description: dto.description } : {}),
        },
        flow: {
            nodes,
            edges: [...plainEdges, ...conditional.map((edge) => edge.edge)],
        },
    };
    let lock = {
        flowName: dto.name,
        graphId: dto.id,
        saveVersion: dto.save_version,
        entities: {},
        documents: {},
    };
    for (const collected of registry.nodes) {
        lock = setEntity(lock, 'nodes', collected.name, {
            backendId: collected.backendId,
            // The pusher never hashes node content — it writes contentHash({}) for
            // every saved node (src/pusher/graph.ts), so the seed must match.
            contentHash: contentHash({}),
        });
    }
    for (const edge of conditional) {
        lock = setEntity(lock, 'conditional_edges', edge.lockName, edge.lockEntry);
    }
    await fs.mkdir(targetDir, { recursive: true });
    const flowPath = path.join(targetDir, FLOW_SOURCE_FILE_NAME);
    const header = `# Pulled from EpicStaff graph #${dto.id} — edit locally, then diff_flow / push_flow.\n`;
    await fs.writeFile(flowPath, header + stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false }), 'utf8');
    await writeLock(targetDir, lock);
    return { files: [flowPath, path.join(targetDir, LOCKFILE_NAME)], warnings, lock };
}
function refuseExistingFlowFiles(targetDir) {
    for (const fileName of [FLOW_SOURCE_FILE_NAME, LOCKFILE_NAME]) {
        if (existsSync(path.join(targetDir, fileName))) {
            throw new Error(`${path.join(targetDir, fileName)} already exists — pull into an empty directory, ` +
                'or delete the local flow source first if you really want to re-pull.');
        }
    }
}
async function fetchReferencedEntityNames(deps, dto) {
    const agentIds = new Set();
    const surfaceIds = new Set();
    const inlineSurfaces = [];
    for (const node of [...(dto.agent_node_list ?? []), ...dto.task_node_list]) {
        if (node.agent_definition != null) {
            agentIds.add(node.agent_definition);
        }
        for (const surfaceId of node.surface_list ?? []) {
            surfaceIds.add(surfaceId);
        }
        if (node.inline_surface != null) {
            inlineSurfaces.push(node.inline_surface);
        }
    }
    const needsLlmConfigs = dto.classification_decision_table_node_list.some((node) => node.default_llm_config != null);
    const needsPythonTools = inlineSurfaces.some((surface) => (surface.python_tools ?? []).length > 0);
    const needsMcpTools = inlineSurfaces.some((surface) => (surface.mcp_tools ?? []).length > 0);
    const needsCollections = inlineSurfaces.some((surface) => (surface.knowledge ?? []).length > 0);
    const needsGraphList = dto.subgraph_node_list.some((node) => !node.subgraph_detail?.name);
    const emptyMap = () => new Map();
    const [agents, surfaces, llmConfigs, pythonTools, mcpTools, collections, graphNames] = await Promise.all([
        mapFromFetches([...agentIds], (id) => deps.agentDefinitions.get(id), (agent) => agent.name),
        mapFromFetches([...surfaceIds], (id) => deps.surfaces.get(id), (surface) => surface.name),
        needsLlmConfigs
            ? deps.llm
                .listConfigs()
                .then((configs) => new Map(configs.map((config) => [config.id, config.custom_name])))
            : Promise.resolve(emptyMap()),
        needsPythonTools
            ? deps.tools
                .listPythonCodeTools()
                .then((tools) => new Map(tools.map((tool) => [tool.id, tool.name])))
            : Promise.resolve(emptyMap()),
        needsMcpTools
            ? deps.tools
                .listMcpTools()
                .then((tools) => new Map(tools.map((tool) => [tool.id, tool.name])))
            : Promise.resolve(emptyMap()),
        needsCollections
            ? deps.knowledge.listCollections().then((list) => new Map(list
                .map((collection) => [collection.collection_id ?? collection.id, collection.collection_name])
                .filter((pair) => typeof pair[0] === 'number')))
            : Promise.resolve(emptyMap()),
        needsGraphList
            ? deps.graphs.listLight().then((graphs) => new Map(graphs.map((graph) => [graph.id, graph.name])))
            : Promise.resolve(emptyMap()),
    ]);
    // Nested subgraph_detail objects resolve names without the extra list call.
    const subgraphs = new Map(graphNames);
    for (const node of dto.subgraph_node_list) {
        if (node.subgraph_detail?.name) {
            subgraphs.set(node.subgraph, node.subgraph_detail.name);
        }
    }
    return { agents, surfaces, llmConfigs, pythonTools, mcpTools, collections, subgraphs };
}
async function mapFromFetches(ids, fetchOne, nameOf) {
    const pairs = await Promise.all(ids.map(async (id) => [id, nameOf(await fetchOne(id))]));
    return new Map(pairs);
}
function metadataOf(dto) {
    return (dto.metadata ?? {});
}
function positionOf(metadata) {
    const position = metadata['position'];
    return {
        x: typeof position?.x === 'number' ? position.x : 0,
        y: typeof position?.y === 'number' ? position.y : 0,
    };
}
function nodeNumberOf(metadata) {
    const nodeNumber = metadata['nodeNumber'];
    return typeof nodeNumber === 'number' ? nodeNumber : Number.MAX_SAFE_INTEGER;
}
function sanitizeSymbolicName(raw, fallback) {
    let cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+$/g, '');
    if (cleaned === '') {
        return fallback;
    }
    if (!/^[A-Za-z_]/.test(cleaned)) {
        cleaned = `node_${cleaned}`;
    }
    return cleaned;
}
/**
 * Collect every node in canonical wire-list order, sorted by the #N badge
 * (`metadata.nodeNumber`) so the YAML reads in authoring order, with unique
 * schema-legal symbolic names. Backend node ids are assumed unique across node
 * types — the same assumption `buildRemoteState` documents.
 */
function collectNodes(dto, warnings) {
    const entries = [
        ...dto.start_node_list.map((node) => ({ type: 'start', dto: node })),
        ...(dto.agent_node_list ?? []).map((node) => ({ type: 'agent', dto: node })),
        ...dto.task_node_list.map((node) => ({ type: 'task', dto: node })),
        ...dto.python_node_list.map((node) => ({ type: 'python', dto: node })),
        ...dto.end_node_list.map((node) => ({ type: 'end', dto: node })),
        ...dto.graph_note_list.map((node) => ({ type: 'note', dto: node })),
        ...dto.file_extractor_node_list.map((node) => ({ type: 'file-extractor', dto: node })),
        ...dto.audio_transcription_node_list.map((node) => ({ type: 'audio-to-text', dto: node })),
        ...dto.subgraph_node_list.map((node) => ({ type: 'subgraph', dto: node })),
        ...dto.crew_node_list.map((node) => ({ type: 'crew', dto: node })),
        ...dto.webhook_trigger_node_list.map((node) => ({ type: 'webhook-trigger', dto: node })),
        ...dto.telegram_trigger_node_list.map((node) => ({ type: 'telegram-trigger', dto: node })),
        ...dto.schedule_trigger_node_list.map((node) => ({ type: 'schedule-trigger', dto: node })),
        ...dto.decision_table_node_list.map((node) => ({ type: 'decision-table', dto: node })),
        ...dto.classification_decision_table_node_list.map((node) => ({ type: 'classification-decision-table', dto: node })),
    ];
    const sorted = [...entries].sort((a, b) => nodeNumberOf(metadataOf(a.dto)) - nodeNumberOf(metadataOf(b.dto)));
    const usedLowercase = new Set();
    const nodes = [];
    const nameByBackendId = new Map();
    const typeByBackendId = new Map();
    for (const entry of sorted) {
        const rawName = ('node_name' in entry.dto ? entry.dto.node_name : undefined) ?? '';
        let base;
        if (SYMBOLIC_NAME_PATTERN.test(rawName)) {
            base = rawName;
        }
        else {
            base = sanitizeSymbolicName(rawName, entry.type);
            if (rawName !== '') {
                warnings.push(`flow.nodes: node name '${rawName}' is not a valid symbolic name — renamed to '${base}' (the node is renamed on the next push)`);
            }
        }
        let name = base;
        let suffix = 2;
        while (usedLowercase.has(name.toLowerCase())) {
            name = `${base}_${suffix}`;
            suffix += 1;
        }
        if (name !== base && rawName !== '') {
            warnings.push(`flow.nodes: node name '${rawName}' collides with another node (names are unique ignoring case) — renamed to '${name}'`);
        }
        usedLowercase.add(name.toLowerCase());
        nodes.push({ entry, backendId: entry.dto.id, name, position: positionOf(metadataOf(entry.dto)) });
        nameByBackendId.set(entry.dto.id, name);
        typeByBackendId.set(entry.dto.id, entry.type);
    }
    return { nodes, nameByBackendId, typeByBackendId };
}
// ---------------------------------------------------------------------------
// Node bodies
// ---------------------------------------------------------------------------
function existingRef(name) {
    return { existing: name };
}
/** Flow-source input maps are string → string; non-string values cannot round-trip. */
function coerceInputMap(raw, atPath, warnings) {
    const result = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
        if (typeof value === 'string') {
            result[key] = value;
        }
        else {
            warnings.push(`${atPath}.input_map.${key}: non-string value dropped — flow-source input maps are string → string`);
        }
    }
    return result;
}
function inputMapField(raw, atPath, warnings) {
    const inputMap = coerceInputMap(raw, atPath, warnings);
    return Object.keys(inputMap).length > 0 ? { input_map: inputMap } : {};
}
function outputVariablePathField(value) {
    return value ? { output_variable_path: value } : {};
}
function agentRefField(agentDefinitionId, names, atPath, warnings) {
    if (agentDefinitionId == null) {
        warnings.push(`${atPath}.agent: the remote node has no agent definition assigned — replace the 'UNASSIGNED' placeholder before pushing`);
        return existingRef('UNASSIGNED');
    }
    // The map is fetched from the ids on this very DTO, so the entry exists.
    return existingRef(names.agents.get(agentDefinitionId));
}
function surfacesField(surfaceList, names) {
    const ids = surfaceList ?? [];
    if (ids.length === 0) {
        return {};
    }
    return { surfaces: ids.map((id) => existingRef(names.surfaces.get(id))) };
}
function inlineSurfaceField(surface, names, atPath, warnings) {
    if (surface == null) {
        return {};
    }
    const body = {};
    if (surface.instructions) {
        body['instructions'] = surface.instructions;
    }
    if ((surface.python_tools ?? []).length > 0) {
        body['python_tools'] = surface.python_tools.map((entry) => ({
            tool: existingRef(names.pythonTools.get(entry.python_tool) ?? missingToolName('python', entry.python_tool, atPath, warnings)),
            mode: entry.mode,
        }));
    }
    if ((surface.mcp_tools ?? []).length > 0) {
        body['mcp_tools'] = surface.mcp_tools.map((entry) => ({
            tool: existingRef(names.mcpTools.get(entry.mcp_tool) ?? missingToolName('mcp', entry.mcp_tool, atPath, warnings)),
            mode: entry.mode,
        }));
    }
    for (const item of surface.storage_items ?? []) {
        warnings.push(`${atPath}.storage: storage item (file #${item.storage_file}) dropped — storage-file ids cannot be mapped back to paths yet`);
    }
    if ((surface.knowledge ?? []).length > 0) {
        body['knowledge'] = surface.knowledge.map((entry) => {
            const collectionName = names.collections.get(entry.collection) ??
                missingName(`knowledge collection #${entry.collection}`, atPath, warnings);
            return {
                collection: existingRef(collectionName),
                ...(entry.naive_search_config != null
                    ? { naive_config: entry.naive_search_config }
                    : {}),
            };
        });
    }
    return { inline_surface: body };
}
function missingToolName(kind, toolId, atPath, warnings) {
    return missingName(`${kind} tool #${toolId}`, atPath, warnings);
}
function missingName(what, atPath, warnings) {
    warnings.push(`${atPath}: referenced ${what} was not found in the active organization — replace the 'UNRESOLVED' placeholder before pushing`);
    return 'UNRESOLVED';
}
function buildNodeBody(collected, registry, names, warnings) {
    const { entry, name, position } = collected;
    const atPath = `flow.nodes.${name}`;
    switch (entry.type) {
        case 'start': {
            const variables = entry.dto.variables ?? {};
            return {
                type: 'start',
                position,
                ...(Object.keys(variables).length > 0 ? { initial_state: variables } : {}),
            };
        }
        case 'agent': {
            const remoteTasks = [...(entry.dto.tasks ?? [])].sort((a, b) => a.order - b.order);
            if (remoteTasks.some((task) => task.context_tasks.length > 0)) {
                warnings.push(`${atPath}.tasks: inter-task context references are not representable in flow source — dropped on the next push`);
            }
            if (remoteTasks.length === 0) {
                warnings.push(`${atPath}.tasks: the remote agent node has no tasks (the runtime cannot execute it) — a placeholder task was written, fill it in`);
            }
            return {
                type: 'agent',
                position,
                agent: agentRefField(entry.dto.agent_definition, names, atPath, warnings),
                tasks: remoteTasks.length
                    ? remoteTasks.map((task) => ({
                        name: task.name,
                        instructions: task.instructions,
                        ...(Object.keys(task.output_schema).length > 0 ? { output_schema: task.output_schema } : {}),
                    }))
                    : [{ instructions: 'TODO: describe what this agent must do at this node.' }],
                ...surfacesField(entry.dto.surface_list, names),
                ...inlineSurfaceField(entry.dto.inline_surface, names, `${atPath}.inline_surface`, warnings),
                ...inputMapField(entry.dto.input_map, atPath, warnings),
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        }
        case 'task': {
            let task = entry.dto.instructions;
            if (task.trim() === '') {
                warnings.push(`${atPath}.task: the remote task has no instructions — placeholder written, fill it in`);
                task = 'TODO: describe the task';
            }
            if (Object.keys(entry.dto.output_schema ?? {}).length > 0) {
                warnings.push(`${atPath}: output_schema is not representable in flow source and is dropped on the next push`);
            }
            if (entry.dto.remember_output) {
                warnings.push(`${atPath}: remember_output is not representable in flow source and resets on the next push`);
            }
            return {
                type: 'task',
                position,
                agent: agentRefField(entry.dto.agent_definition, names, atPath, warnings),
                task,
                ...surfacesField(entry.dto.surface_list, names),
                ...inlineSurfaceField(entry.dto.inline_surface, names, `${atPath}.inline_surface`, warnings),
                ...inputMapField(entry.dto.input_map, atPath, warnings),
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        }
        case 'python': {
            if (entry.dto.use_storage) {
                warnings.push(`${atPath}: use_storage is not representable in flow source and resets on the next push`);
            }
            if (Object.keys(entry.dto.stream_config ?? {}).length > 0) {
                warnings.push(`${atPath}: stream_config is not representable in flow source and resets on the next push`);
            }
            if (Object.keys(entry.dto.test_input ?? {}).length > 0) {
                warnings.push(`${atPath}: test_input is not representable in flow source and resets on the next push`);
            }
            const code = entry.dto.python_code;
            return {
                type: 'python',
                position,
                code: code.code,
                ...(code.entrypoint !== 'main' ? { entrypoint: code.entrypoint } : {}),
                ...(code.libraries.length > 0 ? { libraries: code.libraries } : {}),
                ...inputMapField(entry.dto.input_map, atPath, warnings),
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        }
        case 'end': {
            const outputMap = entry.dto.output_map ?? {};
            const isDefaultOutputMap = Object.keys(outputMap).length === 0 ||
                (Object.keys(outputMap).length === 1 && outputMap['context'] === 'variables.context');
            if (!isDefaultOutputMap) {
                warnings.push(`${atPath}: custom output_map is not representable in flow source and resets on the next push`);
            }
            return { type: 'end', position };
        }
        case 'note': {
            if (typeof metadataOf(entry.dto)['backgroundColor'] === 'string') {
                warnings.push(`${atPath}: note background color is not representable in flow source and resets on the next push`);
            }
            return { type: 'note', position, text: entry.dto.content };
        }
        case 'file-extractor':
            return {
                type: 'file-extractor',
                position,
                ...inputMapField(entry.dto.input_map, atPath, warnings),
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        case 'audio-to-text':
            return {
                type: 'audio-to-text',
                position,
                ...inputMapField(entry.dto.input_map, atPath, warnings),
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        case 'subgraph': {
            const subgraphName = names.subgraphs.get(entry.dto.subgraph) ??
                missingName(`subgraph flow #${entry.dto.subgraph}`, atPath, warnings);
            return {
                type: 'subgraph',
                position,
                graph: existingRef(subgraphName),
                ...inputMapField(entry.dto.input_map, atPath, warnings),
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        }
        case 'crew': {
            const crew = entry.dto.crew;
            const crewName = typeof crew === 'object' && crew !== null && typeof crew.name === 'string'
                ? (crew.name)
                : missingName('crew name (the serializer did not nest it)', atPath, warnings);
            return {
                type: 'crew',
                position,
                crew: existingRef(crewName),
                ...inputMapField(entry.dto.input_map, atPath, warnings),
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        }
        case 'webhook-trigger': {
            if (entry.dto.python_code.code.trim() !== '') {
                warnings.push(`${atPath}: webhook transform python code is not representable in flow source and resets on the next push`);
            }
            if (Object.keys(entry.dto.input_map ?? {}).length > 0) {
                warnings.push(`${atPath}: input_map is not representable on webhook-trigger nodes and resets on the next push`);
            }
            return {
                type: 'webhook-trigger',
                position,
                ...outputVariablePathField(entry.dto.output_variable_path),
            };
        }
        case 'telegram-trigger': {
            if (entry.dto.telegram_bot_api_key !== '') {
                warnings.push(`${atPath}: the Telegram bot token is a secret and is not pulled — set bot_token_env locally or the token resets on the next push`);
            }
            if ((entry.dto.fields ?? []).length > 0) {
                warnings.push(`${atPath}: telegram field mappings are not representable in flow source and reset on the next push`);
            }
            return { type: 'telegram-trigger', position };
        }
        case 'schedule-trigger': {
            warnings.push(`${atPath}.schedule: the backend schedule block cannot be represented as a cron string — placeholder written; ` +
                'a repush recreates this node as an INACTIVE draft (configure the schedule in the UI after pushing)');
            return { type: 'schedule-trigger', position, schedule: '0 0 * * *' };
        }
        case 'decision-table':
            return buildDecisionTableBody(entry.dto, name, position, registry, warnings);
        case 'classification-decision-table':
            return buildClassificationBody(entry.dto, name, position, registry, names, warnings);
    }
}
function buildDecisionTableBody(dto, name, position, registry, warnings) {
    const atPath = `flow.nodes.${name}`;
    const groups = [...(dto.condition_groups ?? [])].sort((a, b) => a.order - b.order);
    const rules = [];
    for (const group of groups) {
        const target = group.next_node_id != null ? registry.nameByBackendId.get(group.next_node_id) : undefined;
        if (target === undefined) {
            warnings.push(`${atPath}: rule '${group.group_name}' has no routable next node and was dropped`);
            continue;
        }
        let condition = group.expression ?? '';
        if (condition === '') {
            const parts = (group.conditions ?? []).map((entry) => entry.condition).filter((text) => text !== '');
            if (parts.length === 0) {
                warnings.push(`${atPath}: rule '${group.group_name}' has no condition expression and was dropped`);
                continue;
            }
            condition = parts.join(' and ');
            warnings.push(`${atPath}: grid conditions of rule '${group.group_name}' were flattened into a single expression`);
        }
        if (group.manipulation != null && group.manipulation !== '') {
            warnings.push(`${atPath}: manipulation of rule '${group.group_name}' is not representable and is dropped on the next push`);
        }
        rules.push({
            ...(group.group_name ? { name: group.group_name } : {}),
            condition,
            next_node: target,
        });
    }
    if (rules.length === 0) {
        throw new Error(`decision-table node '${name}' has no representable routing rules — pull_flow cannot decompile this graph yet`);
    }
    if (dto.next_error_node_id != null) {
        warnings.push(`${atPath}: the error route is not representable in flow source and is dropped on the next push`);
    }
    const defaultTarget = dto.default_next_node_id != null ? registry.nameByBackendId.get(dto.default_next_node_id) : undefined;
    return {
        type: 'decision-table',
        position,
        rules,
        ...(defaultTarget !== undefined ? { default_next_node: defaultTarget } : {}),
    };
}
function buildClassificationBody(dto, name, position, registry, names, warnings) {
    const atPath = `flow.nodes.${name}`;
    let llmRef;
    if (dto.default_llm_config == null) {
        warnings.push(`${atPath}.llm_config: the remote node has no default LLM config — replace the 'UNASSIGNED' placeholder before pushing`);
        llmRef = existingRef('UNASSIGNED');
    }
    else {
        llmRef = existingRef(names.llmConfigs.get(dto.default_llm_config) ??
            missingName(`llm config #${dto.default_llm_config}`, atPath, warnings));
    }
    const lossyParts = [
        ...((dto.prompt_configs ?? []).length > 0 ? ['prompt configs'] : []),
        ...(dto.pre_python_code != null ? ['pre-computation code'] : []),
        ...(dto.post_python_code != null ? ['post-computation code'] : []),
        ...((dto.condition_groups ?? []).some((group) => group.route_code) ? ['route codes'] : []),
    ];
    if (lossyParts.length > 0) {
        warnings.push(`${atPath}: ${lossyParts.join(', ')} are not representable in flow source and reset on the next push`);
    }
    const groups = [...(dto.condition_groups ?? [])].sort((a, b) => a.order - b.order);
    const categories = [];
    for (const group of groups) {
        const target = group.next_node_id != null ? registry.nameByBackendId.get(group.next_node_id) : undefined;
        if (target === undefined) {
            warnings.push(`${atPath}: category '${group.group_name}' has no routable next node and was dropped`);
            continue;
        }
        categories.push({ name: group.group_name, next_node: target });
    }
    if (categories.length === 0) {
        throw new Error(`classification-decision-table node '${name}' has no routable categories — pull_flow cannot decompile this graph yet`);
    }
    if (dto.next_error_node_id != null) {
        warnings.push(`${atPath}: the error route is not representable in flow source and is dropped on the next push`);
    }
    const defaultTarget = dto.default_next_node_id != null ? registry.nameByBackendId.get(dto.default_next_node_id) : undefined;
    return {
        type: 'classification-decision-table',
        position,
        llm_config: llmRef,
        categories,
        ...(defaultTarget !== undefined ? { default_next_node: defaultTarget } : {}),
    };
}
// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------
function buildPlainEdges(dto, registry, warnings) {
    const edges = [];
    let waypointsSeen = false;
    for (const edge of dto.edge_list) {
        const from = registry.nameByBackendId.get(edge.start_node_id);
        const to = registry.nameByBackendId.get(edge.end_node_id);
        if (from === undefined || to === undefined) {
            warnings.push(`flow.edges: edge #${edge.id} references a node that is not part of the graph payload and was dropped`);
            continue;
        }
        const sourceType = registry.typeByBackendId.get(edge.start_node_id);
        if (sourceType === 'decision-table' || sourceType === 'classification-decision-table') {
            // Branch routing lives in the table rules/categories; a plain edge here
            // would duplicate it (mirrors getPlainConnections in graph/diff.ts).
            warnings.push(`flow.edges: plain edge #${edge.id} out of decision node '${from}' skipped — its routing is captured by the table rules`);
            continue;
        }
        const waypoints = edge.metadata?.['waypoints'];
        if (Array.isArray(waypoints) && waypoints.length > 0) {
            waypointsSeen = true;
        }
        edges.push({ from, to });
    }
    if (waypointsSeen) {
        warnings.push('flow.edges: user-adjusted edge waypoints are not representable in flow source and reset on the next push');
    }
    return edges;
}
function buildConditionalEdges(dto, registry, warnings) {
    const builds = [];
    const seenSources = new Set();
    for (const conditionalEdge of dto.conditional_edge_list) {
        const from = registry.nameByBackendId.get(conditionalEdge.source_node_id);
        if (from === undefined) {
            warnings.push(`flow.edges: conditional edge #${conditionalEdge.id} references a node that is not part of the graph payload and was dropped`);
            continue;
        }
        if (seenSources.has(from)) {
            warnings.push(`flow.edges: node '${from}' has more than one conditional edge — the pusher tracks one per source node, extra ones will be recreated on every push`);
        }
        seenSources.add(from);
        const code = conditionalEdge.python_code;
        if ((code.libraries ?? []).length > 0) {
            warnings.push(`flow.edges: conditional edge from '${from}' uses python libraries — flow-source edge conditions cannot declare libraries; they reset on the next push`);
        }
        const inputMap = coerceInputMap(conditionalEdge.input_map, `flow.edges (conditional from '${from}')`, warnings);
        builds.push({
            edge: {
                from,
                condition: {
                    code: code.code,
                    ...(code.entrypoint !== 'main' ? { entrypoint: code.entrypoint } : {}),
                    ...(Object.keys(inputMap).length > 0 ? { input_map: inputMap } : {}),
                },
            },
            lockName: from,
            lockEntry: {
                backendId: conditionalEdge.id,
                // Must equal the hash the pusher computes for the body the NEXT
                // compile emits: emit.ts always sets libraries: [] on edge conditions.
                contentHash: contentHash({
                    graph: dto.id,
                    source_node_id: conditionalEdge.source_node_id,
                    python_code: { code: code.code, entrypoint: code.entrypoint, libraries: [] },
                    input_map: inputMap,
                }),
            },
        });
    }
    return builds;
}
