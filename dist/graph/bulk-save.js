/**
 * Bulk-save payload builder — faithful port of frontend
 * `visual-programming/utils/save/payload.ts#buildBulkSavePayload`, with the diffing
 * (`utils/save/diff.ts`) folded in so callers pass whole graph states.
 *
 * Excluded from emission (per protocol decision): `llm_node_list` (legacy) and
 * `code_agent_node_list` (deprecated). Their `deleted` id-list keys remain, always empty.
 */
import { buildUuidToBackendIdMap, getConnectionDiff, getNodeDiff } from './diff.js';
import { hasPersistedWaypoints, mergeWaypointsIntoMetadata } from './edge-waypoints.js';
import { toNodeMetadata } from './metadata.js';
function resolveNodeRef(uuid, allNodes, idMap) {
    if (!uuid)
        return { backendId: null, tempId: null };
    const fromMap = idMap.get(uuid);
    if (fromMap != null)
        return { backendId: fromMap, tempId: null };
    const fromNode = allNodes.find((node) => node.id === uuid)?.backendId ?? null;
    return fromNode != null ? { backendId: fromNode, tempId: null } : { backendId: null, tempId: uuid };
}
function buildDecisionTableNodePayload(node, graphId, allNodes, idMap) {
    const tableData = node.data.table;
    const conditionGroups = tableData.condition_groups
        .filter((group) => group.valid !== false)
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
        .map((group, index) => {
        const resolved = resolveNodeRef(group.next_node, allNodes, idMap);
        return {
            group_name: group.group_name,
            group_type: group.group_type,
            expression: group.expression,
            conditions: group.conditions.map((condition) => ({
                condition_name: condition.condition_name,
                condition: condition.condition,
            })),
            manipulation: group.manipulation,
            next_node_id: resolved.backendId,
            ...(resolved.tempId ? { next_node_temp_id: resolved.tempId } : {}),
            order: typeof group.order === 'number' ? group.order : index + 1,
        };
    });
    const defaultNext = resolveNodeRef(tableData.default_next_node, allNodes, idMap);
    const nextError = resolveNodeRef(tableData.next_error_node, allNodes, idMap);
    return {
        graph: graphId,
        node_name: node.node_name,
        condition_groups: conditionGroups,
        default_next_node_id: defaultNext.backendId,
        ...(defaultNext.tempId ? { default_next_node_temp_id: defaultNext.tempId } : {}),
        next_error_node_id: nextError.backendId,
        ...(nextError.tempId ? { next_error_node_temp_id: nextError.tempId } : {}),
        metadata: toNodeMetadata(node),
    };
}
function buildScheduleBlock(node) {
    const data = node.data;
    if (data.runMode === 'once') {
        return {
            run_mode: 'once',
            start_date_time: data.startDateTime,
            interval: null,
            end: { type: 'never', date_time: null, max_runs: null },
            timezone: data.timezone,
        };
    }
    const unitAllowsWeekdays = data.intervalUnit === 'days' || data.intervalUnit === 'weeks';
    const interval = {
        every: data.intervalEvery,
        unit: data.intervalUnit,
        weekdays: unitAllowsWeekdays ? data.weekdays : [],
    };
    let end;
    if (data.endType === 'on_date') {
        end = { type: 'on_date', date_time: data.endDateTime, max_runs: null };
    }
    else if (data.endType === 'after_n_runs') {
        end = { type: 'after_n_runs', date_time: null, max_runs: data.maxRuns };
    }
    else {
        end = { type: 'never', date_time: null, max_runs: null };
    }
    return { run_mode: 'repeat', start_date_time: data.startDateTime, interval, end, timezone: data.timezone };
}
function serializeCdtFieldExpressions(fieldExpressions) {
    const result = {};
    for (const [key, value] of Object.entries(fieldExpressions)) {
        if (typeof value === 'object' && value !== null && 'operator' in value) {
            const expression = value;
            const field = expression.field || key;
            const operator = expression.operator || '==';
            const expressionValue = expression.value;
            result[field] =
                typeof expressionValue === 'string' ? `${operator} "${expressionValue}"` : `${operator} ${expressionValue}`;
        }
        else {
            result[key] = String(value);
        }
    }
    return result;
}
function buildCdtNodePayload(node, graphId, allNodes, idMap, edges) {
    const tableData = node.data?.table;
    const preComputation = tableData?.pre_computation || {};
    const postComputation = tableData?.post_computation || {};
    const preCodeValue = preComputation.code || tableData?.pre_computation_code || '';
    const postCodeValue = postComputation.code || tableData?.post_computation_code || '';
    const conditionGroups = [...(tableData?.condition_groups || [])]
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
        .map((group, index) => {
        // Resolve next_node only when route_code is present.
        let targetUuid = null;
        if (group.route_code) {
            targetUuid = group.next_node ?? null;
            if (!targetUuid) {
                const slugified = group.route_code.toLowerCase().replace(/\s+/g, '-');
                const routePortId = `${node.id}_decision-route-${slugified}`;
                const edge = edges.find((candidate) => candidate.sourceNodeId === node.id && candidate.sourcePortId === routePortId);
                if (edge)
                    targetUuid = edge.targetNodeId;
            }
        }
        const resolved = resolveNodeRef(targetUuid, allNodes, idMap);
        return {
            group_name: group.group_name,
            order: typeof group.order === 'number' ? group.order : index + 1,
            expression: group.expression || null,
            prompt_id: group.prompt_id || null,
            manipulation: group.manipulation || null,
            continue_flag: !!(group.continue_flag ?? group.continue),
            route_code: group.route_code || null,
            section: group.section ?? null,
            next_node_id: resolved.backendId,
            ...(resolved.tempId ? { next_node_temp_id: resolved.tempId } : {}),
            dock_visible: group.dock_visible !== false,
            field_expressions: serializeCdtFieldExpressions(group.field_expressions || {}),
            field_manipulations: (group.field_manipulations || {}),
        };
    });
    let defaultTargetUuid = tableData?.default_next_node ?? null;
    if (!defaultTargetUuid) {
        const edge = edges.find((candidate) => candidate.sourceNodeId === node.id && candidate.sourcePortId === `${node.id}_decision-default`);
        if (edge)
            defaultTargetUuid = edge.targetNodeId;
    }
    let errorTargetUuid = tableData?.next_error_node ?? null;
    if (!errorTargetUuid) {
        const edge = edges.find((candidate) => candidate.sourceNodeId === node.id && candidate.sourcePortId === `${node.id}_decision-error`);
        if (edge)
            errorTargetUuid = edge.targetNodeId;
    }
    const defaultRef = resolveNodeRef(defaultTargetUuid, allNodes, idMap);
    const errorRef = resolveNodeRef(errorTargetUuid, allNodes, idMap);
    const promptConfigs = Object.entries(tableData?.prompts || {}).map(([key, config]) => ({
        prompt_key: key,
        prompt_text: config.prompt_text ?? '',
        llm_config: config.llm_config ?? null,
        output_schema: config.output_schema ?? {},
        result_variable: config.result_variable ?? '',
        variable_mappings: config.variable_mappings ?? {},
    }));
    return {
        graph: graphId,
        node_name: node.node_name,
        pre_python_code: preCodeValue.trim() === ''
            ? null
            : {
                code: preCodeValue,
                libraries: preComputation.libraries || [],
                entrypoint: 'main',
                global_kwargs: {},
            },
        pre_input_map: preComputation.input_map || tableData?.pre_input_map || {},
        pre_output_variable_path: preComputation.output_variable_path || tableData?.pre_output_variable_path || null,
        post_python_code: postCodeValue.trim() === ''
            ? null
            : {
                code: postCodeValue,
                libraries: postComputation.libraries || [],
                entrypoint: 'main',
                global_kwargs: {},
            },
        post_input_map: postComputation.input_map || tableData?.post_input_map || {},
        post_output_variable_path: postComputation.output_variable_path || tableData?.post_output_variable_path || null,
        prompt_configs: promptConfigs,
        default_llm_config: tableData?.default_llm_config ?? null,
        ...(defaultRef.backendId != null ? { default_next_node_id: defaultRef.backendId } : {}),
        ...(defaultRef.tempId != null ? { default_next_node_temp_id: defaultRef.tempId } : {}),
        ...(errorRef.backendId != null ? { next_error_node_id: errorRef.backendId } : {}),
        ...(errorRef.tempId != null ? { next_error_node_temp_id: errorRef.tempId } : {}),
        condition_groups: conditionGroups,
        metadata: toNodeMetadata(node),
    };
}
function buildAgentTasksPayload(tasks) {
    const idByTempId = new Map();
    for (const sibling of tasks ?? []) {
        if (sibling.tempId && sibling.id != null)
            idByTempId.set(sibling.tempId, sibling.id);
    }
    return (tasks ?? []).map((task, index) => {
        const contextTaskIds = [];
        const contextTaskTempIds = [];
        for (const ref of task.contextRefs ?? []) {
            if (ref.id != null) {
                contextTaskIds.push(ref.id);
            }
            else if (ref.tempId != null) {
                const resolvedId = idByTempId.get(ref.tempId);
                if (resolvedId != null) {
                    contextTaskIds.push(resolvedId);
                }
                else {
                    contextTaskTempIds.push(ref.tempId);
                }
            }
        }
        return {
            ...(task.id != null ? { id: task.id } : { temp_id: task.tempId }),
            name: task.name,
            order: index,
            instructions: task.instructions,
            output_schema: task.output_schema ?? {},
            context_task_ids: contextTaskIds,
            context_task_temp_ids: contextTaskTempIds,
        };
    });
}
function nodeItems(diff, mapPayload) {
    const created = diff.toCreate.map((node) => ({ id: null, temp_id: node.id, ...mapPayload(node) }));
    const updated = diff.toUpdate.map(({ current: node }) => ({ id: node.backendId, ...mapPayload(node) }));
    return [...created, ...updated];
}
export function buildBulkSavePayload(options) {
    const { graphId, desired, remote, saveVersion } = options;
    const idMap = buildUuidToBackendIdMap(desired.nodes);
    const nodeDiff = getNodeDiff(remote, desired);
    const connectionDiff = getConnectionDiff(remote, desired, idMap);
    const edgeList = connectionDiff.toCreate.map((edge) => {
        const startNodeId = idMap.get(edge.sourceNodeId);
        const endNodeId = idMap.get(edge.targetNodeId);
        return {
            graph: graphId,
            ...(startNodeId != null ? { start_node_id: startNodeId } : { start_temp_id: edge.sourceNodeId }),
            ...(endNodeId != null ? { end_node_id: endNodeId } : { end_temp_id: edge.targetNodeId }),
            ...(hasPersistedWaypoints(edge)
                ? { metadata: mergeWaypointsIntoMetadata(edge.metadata ?? {}, edge.waypoints) }
                : {}),
        };
    });
    const edgeUpdateList = connectionDiff.toUpdate.map((edge) => {
        const startNodeId = idMap.get(edge.sourceNodeId);
        const endNodeId = idMap.get(edge.targetNodeId);
        return {
            id: edge.backendId,
            graph: graphId,
            ...(startNodeId != null ? { start_node_id: startNodeId } : { start_temp_id: edge.sourceNodeId }),
            ...(endNodeId != null ? { end_node_id: endNodeId } : { end_temp_id: edge.targetNodeId }),
            metadata: mergeWaypointsIntoMetadata(edge.metadata ?? {}, edge.waypoints ?? []),
        };
    });
    const deleted = {
        start_node_ids: nodeDiff.startNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        crew_node_ids: nodeDiff.crewNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        python_node_ids: nodeDiff.pythonNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        task_node_ids: nodeDiff.taskNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        agent_node_ids: nodeDiff.agentNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        llm_node_ids: [],
        file_extractor_node_ids: nodeDiff.fileExtractorNodes.toDelete
            .map((node) => node.backendId)
            .filter((id) => id != null),
        audio_transcription_node_ids: nodeDiff.audioToTextNodes.toDelete
            .map((node) => node.backendId)
            .filter((id) => id != null),
        end_node_ids: nodeDiff.endNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        subgraph_node_ids: nodeDiff.subgraphNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        webhook_trigger_node_ids: nodeDiff.webhookNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        telegram_trigger_node_ids: nodeDiff.telegramNodes.toDelete
            .map((node) => node.backendId)
            .filter((id) => id != null),
        schedule_trigger_node_ids: nodeDiff.scheduleNodes.toDelete
            .map((node) => node.backendId)
            .filter((id) => id != null),
        decision_table_node_ids: nodeDiff.decisionTableNodes.toDelete
            .map((node) => node.backendId)
            .filter((id) => id != null),
        graph_note_ids: nodeDiff.noteNodes.toDelete.map((node) => node.backendId).filter((id) => id != null),
        code_agent_node_ids: [],
        classification_decision_table_node_ids: nodeDiff.classificationDecisionTableNodes.toDelete
            .map((node) => node.backendId)
            .filter((id) => id != null),
        edge_ids: connectionDiff.toDelete.map((edge) => edge.backendId).filter((id) => id != null),
    };
    return {
        save_version: saveVersion,
        start_node_list: nodeItems(nodeDiff.startNodes, (node) => ({
            graph: graphId,
            variables: node.data.initialState ?? {},
            metadata: toNodeMetadata(node),
        })),
        crew_node_list: nodeItems(nodeDiff.crewNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            crew_id: node.data.id,
            input_map: node.input_map || {},
            output_variable_path: node.output_variable_path || null,
            stream_config: node.stream_config ?? {},
            metadata: toNodeMetadata(node),
        })),
        python_node_list: nodeItems(nodeDiff.pythonNodes, (node) => {
            const { use_storage, ...pythonCode } = node.data;
            return {
                node_name: node.node_name,
                graph: graphId,
                python_code: pythonCode,
                input_map: node.input_map || {},
                output_variable_path: node.output_variable_path || null,
                stream_config: node.stream_config ?? {},
                use_storage: use_storage ?? false,
                test_input: node.test_input ?? {},
                metadata: toNodeMetadata(node),
            };
        }),
        task_node_list: nodeItems(nodeDiff.taskNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            instructions: node.data.instructions,
            output_schema: node.data.output_schema ?? {},
            remember_output: node.data.remember_output ?? false,
            agent_definition: node.data.agent_definition ?? null,
            input_map: node.input_map || {},
            output_variable_path: node.output_variable_path || null,
            surface_list: node.data.surface_list ?? [],
            inline_surface: node.data.inline_surface ?? null,
            metadata: toNodeMetadata(node),
        })),
        agent_node_list: nodeItems(nodeDiff.agentNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            agent_definition: node.data.agent_definition ?? null,
            input_map: node.input_map || {},
            output_variable_path: node.output_variable_path || null,
            surface_list: node.data.surface_list ?? [],
            inline_surface: node.data.inline_surface ?? null,
            tasks: buildAgentTasksPayload(node.data.tasks ?? []),
            metadata: toNodeMetadata(node),
        })),
        file_extractor_node_list: nodeItems(nodeDiff.fileExtractorNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            input_map: node.input_map || {},
            output_variable_path: node.output_variable_path || null,
            metadata: toNodeMetadata(node),
        })),
        audio_transcription_node_list: nodeItems(nodeDiff.audioToTextNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            input_map: node.input_map || {},
            output_variable_path: node.output_variable_path || null,
            metadata: toNodeMetadata(node),
        })),
        end_node_list: nodeItems(nodeDiff.endNodes, (node) => ({
            graph: graphId,
            output_map: node.data.output_map ?? { context: 'variables.context' },
            metadata: toNodeMetadata(node),
        })),
        subgraph_node_list: nodeItems(nodeDiff.subgraphNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            subgraph: node.data.id,
            input_map: node.input_map || {},
            output_variable_path: node.output_variable_path || null,
            metadata: toNodeMetadata(node),
        })),
        webhook_trigger_node_list: nodeItems(nodeDiff.webhookNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            python_code: node.data.python_code,
            input_map: node.input_map || {},
            output_variable_path: node.output_variable_path || null,
            webhook_trigger_path: '',
            webhook_trigger: node.data.webhook_trigger,
            metadata: toNodeMetadata(node),
        })),
        telegram_trigger_node_list: nodeItems(nodeDiff.telegramNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            telegram_bot_api_key: node.data.telegram_bot_api_key,
            webhook_trigger: node.data.webhook_trigger,
            fields: node.data.fields,
            metadata: toNodeMetadata(node),
        })),
        schedule_trigger_node_list: nodeItems(nodeDiff.scheduleNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            is_active: node.data.startDateTime ? node.data.isActive : false,
            metadata: toNodeMetadata(node),
            schedule: node.data.startDateTime ? buildScheduleBlock(node) : null,
        })),
        decision_table_node_list: nodeItems(nodeDiff.decisionTableNodes, (node) => buildDecisionTableNodePayload(node, graphId, desired.nodes, idMap)),
        graph_note_list: nodeItems(nodeDiff.noteNodes, (node) => ({
            node_name: node.node_name,
            graph: graphId,
            content: node.data.content,
            metadata: { ...toNodeMetadata(node), backgroundColor: node.data.backgroundColor ?? null },
        })),
        classification_decision_table_node_list: nodeItems(nodeDiff.classificationDecisionTableNodes, (node) => buildCdtNodePayload(node, graphId, desired.nodes, idMap, desired.edges)),
        edge_list: [...edgeList, ...edgeUpdateList],
        deleted,
    };
}
