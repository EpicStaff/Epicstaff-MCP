/**
 * Emit pass — turns a loaded + resolved + validated {@link FlowSource} into the
 * pushable halves of a {@link BuildArtifact}:
 *
 *  1. dependency-ordered {@link EntityPlan}s whose payloads are shaped exactly
 *     like the create-request DTOs in `src/api/` with `{$ref}` placeholders
 *     (see `artifact.ts`) wherever a backend id of another artifact entity is
 *     needed, plus the pusher-resolved template refs from `template-refs.ts`
 *     (`{$model}`, `{$env}`, `{$tool}`, `{$storageFile}`);
 *  2. a laid-out {@link GraphState} whose node data fields carry the same
 *     `{$ref}` placeholders.
 *
 * Ref key conventions (all documented deviations from plain `<section>.<name>`):
 *  - local entities:      `{$ref: "<section>.<name>"}` — matches the plan key.
 *  - `existing:` refs:    `{$ref: "<section>.existing:<remoteName>"}` — matches
 *    the corresponding `resolve-existing` plan key. The `existing:` prefix
 *    prevents collisions between a local name and a remote name.
 *  - embedders:           `{$ref: "embedders.<name>"}` or
 *    `{$ref: "embedders.default"}`. There is NO EntityPlan for embedders (no
 *    `EntityKind` exists) and no local/remote distinction (embedders are always
 *    org-level), so there is no `existing:` prefix — the pusher resolves the name
 *    directly against the `embedding-configs/` list (default = the org default).
 *  - subgraph flows:      `{$ref: "flows.<siblingFlowName>"}` or
 *    `{$ref: "flows.existing:<remoteName>"}`. Also no EntityPlan (no kind) —
 *    a subgraph always targets an already-pushed graph, so there is nothing to
 *    create. `pusher/flow-refs.ts` resolves these to ids (remote name lookup via
 *    `graph-light/`, or the sibling's `flow.lock.json` graphId) and the push_flow
 *    tool merges them into the idMap before the graph is pushed.
 *
 * Numeric GraphState fields that carry refs (`agent_definition`, `surface_list`
 * entries, subgraph/crew `data.id`, `default_llm_config`, inline-surface tool /
 * collection / storage ids) and the string `telegram_bot_api_key` (an `{$env}`
 * ref) are populated via `as unknown as <T>` casts: the artifact contract
 * (artifact.ts) requires the pusher to substitute every placeholder before the
 * state is diffed or pushed, so the lie never reaches the wire.
 *
 * Known, intentionally-documented lossy mappings (each emits a WARNING):
 *  - stdio MCP tools (`command`) — the backend `McpTool.transport` is a remote
 *    server URL; stdio servers cannot be pushed.
 *  - python tool `args_schema` — no field on the python-code-tool create API.
 *  - schedule-trigger cron strings — the backend schedule block (run
 *    mode/interval/weekdays) has no cron input; the node is created as an
 *    inactive draft.
 *  - file-extractor `file` / audio-to-text `model` — no slot in the canvas
 *    node model.
 *  - inline-surface storage permissions other than `can_view`, and graph
 *    search configs on inline surfaces — the inline write shape supports
 *    neither.
 *  - classification category descriptions — the CDT table state has no
 *    description field.
 *
 * Cross-section cycle: `surfaces[].owner_agent` points forward to the agents
 * section while `agents[].default_surfaces` points back at surfaces. The plan
 * order (surfaces before agents) follows the artifact contract; the pusher is
 * expected to create owner-agent surfaces with `owner_agent: null` and patch
 * the owner in a second pass (use `collectRefs` to detect the forward refs).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { makeWarning, type Diagnostic } from '../flow-source/diagnostics.js';
import { contentHash, entityKey } from '../flow-source/lockfile.js';
import type {
  CatalogSurfaceSource,
  EntityRef,
  FlowSource,
  InlineSurfaceSource,
  KnowledgeCollectionSource,
} from '../flow-source/schema/index.js';
import { buildStartNodeVariables } from './variable-domain.js';
import type {
  AgentGraphNodeData,
  GraphEdgeState,
  GraphNode,
  GraphNodeType,
  GraphPoint,
  GraphState,
  TaskGraphNodeData,
} from '../graph/graph-state.js';
import { mintTempId } from '../graph/temp-id.js';
import type { InlineSurface } from '../models/nodes/task-node.js';
import type { EntityKind, EntityPlan, RagPlan, SymbolicRef } from './artifact.js';
import {
  CANVAS_START_X,
  CANVAS_START_Y,
  DISCONNECTED_MARGIN,
  HORIZONTAL_GAP,
  LAYOUT_NODE_TYPES,
  computeAutoArrangePositions,
  snapToGrid,
  type LayoutConnection,
  type LayoutNode,
} from './layout.js';
import type { BuiltinToolRef, EnvRef, ModelRef, StorageFileRef } from './template-refs.js';

export interface ConditionalEdgePlan {
  /** Client uuid of the source node — matches a `GraphState` node id. */
  sourceNode: string;
  /** Symbolic name of the source node (for human-readable summaries). */
  sourceNodeName: string;
  /** Shaped like `CreateConditionalEdgeRequest.python_code` (src/api/… models). */
  python_code: { code: string; entrypoint: string; libraries: string[] };
  input_map: Record<string, unknown>;
}

export interface EmitResult {
  entities: EntityPlan[];
  graph: GraphState;
  summary: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Canvas metadata tables (mirrors frontend visual-programming/core/enums/node-config.ts)
// ---------------------------------------------------------------------------

const NODE_COLORS: Record<GraphNodeType, string> = {
  start: '#d3d3d3',
  crew: '#5672cd', // frontend NodeType.PROJECT
  python: '#ffcf3f',
  task: '#2aba6b',
  agent: '#685fff',
  end: '#d3d3d3',
  note: '#ffffd1',
  'file-extractor': '#2196F3',
  'audio-to-text': '#ff7be9ff',
  subgraph: '#00bfa5',
  'webhook-trigger': '#21f367ff',
  'telegram-trigger': '#229ED9',
  'schedule-trigger': '#FF5C00',
  'decision-table': '#00aaff', // frontend NodeType.TABLE
  'classification-decision-table': '#2a5bd7',
};

const NODE_ICONS: Record<GraphNodeType, string> = {
  start: 'ti ti-player-play-filled',
  crew: 'ti ti-folder',
  python: 'ti ti-brand-python',
  task: 'ti ti-circle-check',
  agent: 'ti ti-robot',
  end: 'ti ti-square-rounded',
  note: 'ti ti-note',
  'file-extractor': 'ti ti-file',
  'audio-to-text': 'ti ti-music',
  subgraph: 'ti ti-hierarchy-2',
  'webhook-trigger': 'ti ti-world',
  'telegram-trigger': 'ti ti-brand-telegram',
  'schedule-trigger': 'ti ti-calendar',
  'decision-table': 'ti ti-table',
  'classification-decision-table': 'ti ti-table-options',
};

/**
 * Rendered node sizes. Heights are multiples of 40 on purpose: the layout
 * snaps the port centre Y to the 20 px grid and subtracts `height / 2`, so a
 * height ≡ 0 (mod 40) keeps the top-left corner on the 20 px grid too.
 */
const DEFAULT_NODE_SIZE = { width: 320, height: 80 } as const;
const NODE_SIZES: Partial<Record<GraphNodeType, { width: number; height: number }>> = {
  note: { width: 320, height: 160 },
};

/** GraphState node type → layout node type (frontend NodeType enum value). */
const LAYOUT_TYPE_BY_NODE_TYPE: Record<GraphNodeType, string> = {
  start: LAYOUT_NODE_TYPES.START,
  crew: LAYOUT_NODE_TYPES.PROJECT,
  python: LAYOUT_NODE_TYPES.PYTHON,
  task: LAYOUT_NODE_TYPES.TASK,
  agent: LAYOUT_NODE_TYPES.AGENT,
  end: LAYOUT_NODE_TYPES.END,
  note: LAYOUT_NODE_TYPES.NOTE,
  'file-extractor': LAYOUT_NODE_TYPES.FILE_EXTRACTOR,
  'audio-to-text': LAYOUT_NODE_TYPES.AUDIO_TO_TEXT, // 'audio-to-text-node' — enum value differs
  subgraph: LAYOUT_NODE_TYPES.SUBGRAPH,
  'webhook-trigger': LAYOUT_NODE_TYPES.WEBHOOK_TRIGGER,
  'telegram-trigger': LAYOUT_NODE_TYPES.TELEGRAM_TRIGGER,
  'schedule-trigger': LAYOUT_NODE_TYPES.SCHEDULE_TRIGGER,
  'decision-table': LAYOUT_NODE_TYPES.TABLE, // 'table' — enum value differs
  'classification-decision-table': LAYOUT_NODE_TYPES.CLASSIFICATION_TABLE,
};

// ---------------------------------------------------------------------------
// Symbolic-ref registry
// ---------------------------------------------------------------------------

/**
 * Builds `{$ref}` placeholders and records every `existing:` reference it sees
 * so a single `resolve-existing` plan per (section, remoteName) can be emitted.
 */
class RefRegistry {
  private readonly existingBySection = new Map<string, Set<string>>();

  ref(section: string, entityRef: EntityRef): SymbolicRef {
    if (typeof entityRef === 'string') {
      return { $ref: `${section}.${entityRef}` };
    }
    let names = this.existingBySection.get(section);
    if (names === undefined) {
      names = new Set();
      this.existingBySection.set(section, names);
    }
    names.add(entityRef.existing);
    return { $ref: `${section}.existing:${entityRef.existing}` };
  }

  existingPlans(section: string, kind: EntityKind): EntityPlan[] {
    const names = [...(this.existingBySection.get(section) ?? [])].sort();
    return names.map((remoteName) => ({
      key: `${section}.existing:${remoteName}`,
      section,
      name: `existing:${remoteName}`,
      kind,
      action: 'resolve-existing',
      remoteName,
    }));
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`emit invariant violated (validate should have caught this): ${message}`);
  }
}

async function readFlowFile(flowDir: string, relativePath: string): Promise<string> {
  return fs.readFile(path.resolve(flowDir, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// Entity plans
// ---------------------------------------------------------------------------

function upsertPlan(
  section: string,
  name: string,
  kind: EntityKind,
  sourceDefinition: unknown,
  payload: Record<string, unknown>,
  extra?: Pick<EntityPlan, 'documents' | 'rag'>,
): EntityPlan {
  return {
    key: entityKey(section, name),
    section,
    name,
    kind,
    action: 'upsert',
    payload,
    contentHash: contentHash(sourceDefinition),
    ...(extra?.documents !== undefined ? { documents: extra.documents } : {}),
    ...(extra?.rag !== undefined ? { rag: extra.rag } : {}),
  };
}

/** Payload template shaped like `CreateLlmConfigRequest` (src/api/llm.ts). */
function buildLlmConfigPlans(source: FlowSource): EntityPlan[] {
  return Object.entries(source.llm_configs).map(([name, config]) => {
    const model: ModelRef = {
      $model: config.model,
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      ...(config.base_url !== undefined ? { base_url: config.base_url } : {}),
    };
    const apiKey: EnvRef | string =
      config.api_key_env !== undefined ? { $env: config.api_key_env } : '';
    const payload: Record<string, unknown> = {
      custom_name: name,
      // `model` is a numeric id on the wire; flow source only knows the model
      // NAME, so a {$model} template ref sits here — the pusher resolves it
      // via the llm-models list (see template-refs.ts).
      model,
      api_key: apiKey,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(config.max_tokens !== undefined ? { max_tokens: config.max_tokens } : {}),
      // Extra provider params (top_p, timeout, …) pass through at top level.
      ...config.params,
    };
    return upsertPlan('llm_configs', name, 'llm_config', config, payload);
  });
}

function buildToolConfigPlans(source: FlowSource): EntityPlan[] {
  return Object.entries(source.tools.tool_configs).map(([name, config]) => {
    const tool: BuiltinToolRef = { $tool: config.tool };
    return upsertPlan('tools.tool_configs', name, 'tool_config', config, {
      name,
      // Numeric catalog-tool id on the wire; source knows only the name.
      tool,
      configuration: config.config,
    });
  });
}

/** Payload template shaped like `CreatePythonCodeToolRequest` (src/api/tools.ts). */
async function buildPythonToolPlans(
  source: FlowSource,
  flowDir: string,
  diagnostics: Diagnostic[],
): Promise<EntityPlan[]> {
  const plans: EntityPlan[] = [];
  for (const [name, tool] of Object.entries(source.tools.python_code_tools)) {
    const code = tool.code ?? (await readFlowFile(flowDir, tool.code_file as string));
    if (tool.args_schema !== undefined) {
      diagnostics.push(
        makeWarning(
          `tools.python_code_tools.${name}.args_schema`,
          'args_schema is not supported by the python-code-tool create API and is ignored',
        ),
      );
    }
    plans.push(
      upsertPlan('tools.python_code_tools', name, 'python_code_tool', tool, {
        name,
        description: tool.description,
        variables: [],
        python_code: { code, entrypoint: tool.entrypoint, libraries: tool.libraries },
      }),
    );
  }
  return plans;
}

/** Payload template shaped like `CreateMcpToolRequest` (src/api/tools.ts). */
function buildMcpToolPlans(source: FlowSource, diagnostics: Diagnostic[]): EntityPlan[] {
  return Object.entries(source.tools.mcp_tools).map(([name, tool]) => {
    if (tool.url === undefined) {
      diagnostics.push(
        makeWarning(
          `tools.mcp_tools.${name}.command`,
          'stdio MCP tools cannot be pushed — the backend McpTool.transport field only accepts a remote server URL; this plan will fail at push time',
        ),
      );
    }
    return upsertPlan('tools.mcp_tools', name, 'mcp_tool', tool, {
      name,
      transport: tool.url ?? '',
      // The MCP tool name on the server is not part of flow source; the
      // symbolic name doubles as tool_name by convention.
      tool_name: name,
    });
  });
}

function buildKnowledgePlans(
  source: FlowSource,
  flowDir: string,
  registry: RefRegistry,
): EntityPlan[] {
  return Object.entries(source.knowledge).map(([name, collection]) =>
    upsertPlan(
      'knowledge',
      name,
      'knowledge_collection',
      collection,
      { collection_name: name },
      {
        documents: collection.documents.map((documentPath) => path.resolve(flowDir, documentPath)),
        rag: buildRagPlan(collection, registry),
      },
    ),
  );
}

function buildRagPlan(collection: KnowledgeCollectionSource, registry: RefRegistry): RagPlan {
  const rag = collection.rag;
  const embedder =
    rag.embedder !== undefined
      ? ({ $ref: `embedders.${rag.embedder}` } as const)
      : ({ $ref: 'embedders.default' } as const);
  if (rag.strategy === 'naive') {
    const chunking = definedFields({
      chunk_size: rag.chunk_size,
      chunk_overlap: rag.chunk_overlap,
    });
    return {
      strategy: 'naive',
      embedder,
      ...(chunking !== undefined ? { document_chunking: chunking } : {}),
    };
  }
  const indexConfig = definedFields({
    chunk_size: rag.chunk_size,
    chunk_overlap: rag.chunk_overlap,
    entity_types: rag.entity_types,
    max_gleanings: rag.max_gleanings,
  });
  return {
    strategy: 'graph',
    embedder,
    ...(rag.llm_config !== undefined ? { llm: registry.ref('llm_configs', rag.llm_config) } : {}),
    ...(indexConfig !== undefined ? { index_config: indexConfig } : {}),
  };
}

/**
 * Keep only the keys the author actually set; return undefined when none are.
 * Fields the author left out must stay out of the plan so untouched flows keep
 * a byte-identical rag content hash (no spurious re-index on repush).
 */
function definedFields<T extends Record<string, unknown>>(fields: T): T | undefined {
  const present = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T;
  return Object.keys(present).length > 0 ? present : undefined;
}

/** Payload template shaped like `CreateSurfaceRequest` (src/api/surfaces.ts). */
function buildSurfacePlans(source: FlowSource, registry: RefRegistry): EntityPlan[] {
  return Object.entries(source.surfaces).map(([name, surface]) =>
    upsertPlan('surfaces', name, 'surface', surface, {
      name,
      ...(surface.description !== undefined ? { description: surface.description } : {}),
      instructions: surface.instructions,
      owner_agent:
        surface.owner_agent !== undefined ? registry.ref('agents', surface.owner_agent) : null,
      python_tools: surface.python_tools.map((entry) => ({
        python_tool: registry.ref('tools.python_code_tools', entry.tool),
        mode: entry.mode,
      })),
      mcp_tools: surface.mcp_tools.map((entry) => ({
        mcp_tool: registry.ref('tools.mcp_tools', entry.tool),
        mode: entry.mode,
      })),
      storage_items: surface.storage.map((item) => ({
        // Numeric storage-file id on the wire; source knows only the path.
        storage_file: { $storageFile: item.file } satisfies StorageFileRef,
        can_list: item.can_list,
        can_view: item.can_view,
        can_edit: item.can_edit,
        can_delete: item.can_delete,
      })),
      knowledge: surface.knowledge.map((entry) => ({
        collection: registry.ref('knowledge', entry.collection),
        ...(entry.naive_config !== undefined ? { naive_search_config: entry.naive_config } : {}),
        ...(entry.graph_basic_config !== undefined
          ? { graph_basic_search_config: entry.graph_basic_config }
          : {}),
        ...(entry.graph_local_search_config !== undefined
          ? { graph_local_search_config: entry.graph_local_search_config }
          : {}),
      })),
    }),
  );
}

/** Payload template shaped like `CreateAgentDefinitionRequest` (src/api/agent-definitions.ts). */
function buildAgentPlans(source: FlowSource, registry: RefRegistry): EntityPlan[] {
  return Object.entries(source.agents).map(([name, agent]) =>
    upsertPlan('agents', name, 'agent_definition', agent, {
      name,
      instructions: agent.instructions,
      ...(agent.description !== undefined ? { description: agent.description } : {}),
      llm_config: registry.ref('llm_configs', agent.llm_config),
      ...(agent.fcm_llm_config !== undefined
        ? { fcm_llm_config: registry.ref('llm_configs', agent.fcm_llm_config) }
        : {}),
      default_surfaces: agent.default_surfaces.map((entry) => ({
        surface: registry.ref('surfaces', entry.surface),
        place: entry.place,
      })),
      metadata: agent.metadata,
      max_iter: agent.max_iter,
      ...(agent.max_rpm !== undefined ? { max_rpm: agent.max_rpm } : {}),
      ...(agent.max_execution_time !== undefined
        ? { max_execution_time: agent.max_execution_time }
        : {}),
      cache: agent.cache,
      max_retry_limit: agent.max_retry_limit,
    }),
  );
}

// ---------------------------------------------------------------------------
// Graph state
// ---------------------------------------------------------------------------

/** Maps an inline surface source onto the node write shape (`InlineSurface`). */
function mapInlineSurface(
  surface: InlineSurfaceSource,
  basePath: string,
  registry: RefRegistry,
  diagnostics: Diagnostic[],
): InlineSurface {
  surface.storage.forEach((item, index) => {
    const unsupported = (['can_list', 'can_edit', 'can_delete'] as const).filter(
      (flag) => item[flag] !== 'unset',
    );
    if (unsupported.length > 0) {
      diagnostics.push(
        makeWarning(
          `${basePath}.storage[${index}]`,
          `inline surfaces only support can_view — ${unsupported.join(', ')} ignored`,
        ),
      );
    }
  });

  return {
    instructions: surface.instructions,
    python_tools: surface.python_tools.map((entry) => ({
      python_tool: registry.ref('tools.python_code_tools', entry.tool) as unknown as number,
      mode: entry.mode,
    })),
    mcp_tools: surface.mcp_tools.map((entry) => ({
      mcp_tool: registry.ref('tools.mcp_tools', entry.tool) as unknown as number,
      mode: entry.mode,
    })),
    storage_items: surface.storage.map((item) => ({
      storage_file: { $storageFile: item.file } as unknown as number,
      can_view: item.can_view,
    })),
    knowledge: surface.knowledge.map((entry, index) => {
      if (entry.graph_basic_config !== undefined || entry.graph_local_search_config !== undefined) {
        diagnostics.push(
          makeWarning(
            `${basePath}.knowledge[${index}]`,
            'inline surfaces only support naive_search_config — graph search configs ignored',
          ),
        );
      }
      return {
        collection: registry.ref('knowledge', entry.collection) as unknown as number,
        ...(entry.naive_config !== undefined ? { naive_search_config: entry.naive_config } : {}),
      };
    }),
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'route' : slug;
}

interface GraphBuildResult {
  nodes: GraphNode[];
  edges: GraphEdgeState[];
  layoutConnections: LayoutConnection[];
  conditionalEdges: ConditionalEdgePlan[];
}

async function buildGraph(
  source: FlowSource,
  flowDir: string,
  registry: RefRegistry,
  diagnostics: Diagnostic[],
): Promise<GraphBuildResult> {
  const uuidByName = new Map<string, string>();
  for (const nodeName of Object.keys(source.flow.nodes)) {
    uuidByName.set(nodeName, mintTempId());
  }
  const uuidOf = (nodeName: string): string => {
    const uuid = uuidByName.get(nodeName);
    invariant(uuid !== undefined, `unknown node '${nodeName}'`);
    return uuid;
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdgeState[] = [];
  const layoutConnections: LayoutConnection[] = [];
  const conditionalEdges: ConditionalEdgePlan[] = [];

  const seenEdges = new Set<string>();
  const pushEdge = (edge: GraphEdgeState, layoutSourcePortId?: string): void => {
    const dedupeKey = `${edge.sourceNodeId}|${edge.targetNodeId}|${edge.sourcePortId ?? ''}`;
    if (seenEdges.has(dedupeKey)) {
      return;
    }
    seenEdges.add(dedupeKey);
    edges.push(edge);
    layoutConnections.push({
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      ...(layoutSourcePortId !== undefined
        ? { sourcePortId: layoutSourcePortId }
        : edge.sourcePortId !== undefined
          ? { sourcePortId: edge.sourcePortId }
          : {}),
    });
  };

  let nodeNumber = 0;
  for (const [nodeName, node] of Object.entries(source.flow.nodes)) {
    nodeNumber += 1;
    const uuid = uuidOf(nodeName);
    const nodePath = `flow.nodes.${nodeName}`;
    // Forbidden legacy types are load-time ERRORS — emit never sees them.
    invariant(node.type !== 'llm' && node.type !== 'code-agent', 'forbidden node type');
    const type: GraphNodeType = node.type;

    const base = {
      id: uuid,
      backendId: null,
      node_name: nodeName,
      // Placeholder — real positions are assigned by the layout pass below.
      position: { x: 0, y: 0 },
      color: NODE_COLORS[type],
      icon: NODE_ICONS[type],
      size: NODE_SIZES[type] ?? { ...DEFAULT_NODE_SIZE },
      nodeNumber,
      input_map: ('input_map' in node ? node.input_map : {}) as Record<string, unknown>,
      output_variable_path:
        'output_variable_path' in node && node.output_variable_path !== undefined
          ? node.output_variable_path
          : null,
    };

    switch (node.type) {
      case 'start': {
        // The start node's variables ARE the flow's variable domain (backend contract —
        // see variable-domain.ts). Emit the native WRAPPED scheme
        // ({variables: <domain>, persistent_variables: {user, organization}}) with the
        // domain force-completed: declared defaults + inline initial_state + every
        // top-level variable any node produces via output_variable_path, so a
        // produced-only variable is never missing from the domain the backend validates
        // user/persistent variables against.
        nodes.push({
          ...base,
          type: 'start',
          data: { initialState: buildStartNodeVariables(source, node.initial_state ?? {}) },
        });
        break;
      }

      case 'agent': {
        const data: AgentGraphNodeData = {
          // SymbolicRef in a numeric position — substituted by the pusher (artifact.ts).
          agent_definition: registry.ref('agents', node.agent) as unknown as number,
          surface_list: node.surfaces.map(
            (ref) => registry.ref('surfaces', ref) as unknown as number,
          ),
          inline_surface:
            node.inline_surface !== undefined
              ? mapInlineSurface(node.inline_surface, `${nodePath}.inline_surface`, registry, diagnostics)
              : null,
          // Runtime contract: an AgentNode executes its ordered task list.
          tasks: node.tasks.map((task, order) => ({
            tempId: mintTempId(),
            name: task.name ?? `task-${order + 1}`,
            instructions: task.instructions,
            output_schema: task.output_schema,
            contextRefs: [],
          })),
        };
        nodes.push({ ...base, type: 'agent', data });
        break;
      }

      case 'task': {
        const instructions =
          node.expected_output !== undefined
            ? `${node.task}\n\nExpected output: ${node.expected_output}`
            : node.task;
        const data: TaskGraphNodeData = {
          // The task node model has no expected_output field — it is folded
          // into the instructions text (documented lossy mapping).
          instructions,
          output_schema: {},
          agent_definition: registry.ref('agents', node.agent) as unknown as number,
          surface_list: node.surfaces.map(
            (ref) => registry.ref('surfaces', ref) as unknown as number,
          ),
          inline_surface:
            node.inline_surface !== undefined
              ? mapInlineSurface(node.inline_surface, `${nodePath}.inline_surface`, registry, diagnostics)
              : null,
        };
        nodes.push({ ...base, type: 'task', data });
        break;
      }

      case 'python': {
        const code = node.code ?? (await readFlowFile(flowDir, node.code_file as string));
        nodes.push({
          ...base,
          type: 'python',
          data: { name: nodeName, libraries: node.libraries, code, entrypoint: node.entrypoint },
          test_input: {},
        });
        break;
      }

      case 'end':
        nodes.push({ ...base, type: 'end', data: {} });
        break;

      case 'note':
        nodes.push({ ...base, type: 'note', data: { content: node.text } });
        break;

      case 'file-extractor':
        if (node.file !== undefined) {
          diagnostics.push(
            makeWarning(
              `${nodePath}.file`,
              "the canvas file-extractor node has no 'file' slot yet — supply the file via input_map instead",
            ),
          );
        }
        nodes.push({ ...base, type: 'file-extractor' });
        break;

      case 'audio-to-text':
        if (node.model !== undefined) {
          diagnostics.push(
            makeWarning(
              `${nodePath}.model`,
              "the canvas audio-to-text node has no 'model' slot — the backend default transcription model is used",
            ),
          );
        }
        nodes.push({ ...base, type: 'audio-to-text' });
        break;

      case 'subgraph':
        nodes.push({
          ...base,
          type: 'subgraph',
          // {$ref: "flows.…"} in a numeric position — no EntityPlan exists for
          // flows; the pusher resolves flow names directly (see module doc).
          data: { id: registry.ref('flows', node.graph) as unknown as number },
        });
        break;

      case 'crew': {
        invariant(node.crew !== undefined, `crew node '${nodeName}' has no crew reference`);
        nodes.push({
          ...base,
          type: 'crew',
          data: { id: registry.ref('crews', node.crew) as unknown as number },
        });
        break;
      }

      case 'webhook-trigger':
        nodes.push({
          ...base,
          type: 'webhook-trigger',
          data: {
            webhook_trigger: null,
            python_code: { name: nodeName, libraries: [], code: '', entrypoint: 'main' },
          },
        });
        break;

      case 'telegram-trigger':
        nodes.push({
          ...base,
          type: 'telegram-trigger',
          data: {
            // {$env} ref in a string position — the token itself never lives
            // in flow source; the pusher substitutes the env value.
            telegram_bot_api_key:
              node.bot_token_env !== undefined
                ? (({ $env: node.bot_token_env } satisfies EnvRef) as unknown as string)
                : '',
            webhook_trigger: null,
            fields: [],
          },
        });
        break;

      case 'schedule-trigger':
        diagnostics.push(
          makeWarning(
            `${nodePath}.schedule`,
            `cron expression '${node.schedule}' cannot be translated to the backend schedule block yet — the node is created as an inactive draft; configure the schedule in the UI`,
          ),
        );
        nodes.push({
          ...base,
          type: 'schedule-trigger',
          data: {
            isActive: false,
            runMode: 'once',
            startDateTime: '', // draft — saves with schedule: null, is_active: false
            intervalEvery: null,
            intervalUnit: null,
            weekdays: [],
            endType: 'never',
            endDateTime: null,
            maxRuns: null,
            timezone: 'UTC',
          },
        });
        break;

      case 'decision-table': {
        nodes.push({
          ...base,
          type: 'decision-table',
          data: {
            name: nodeName,
            table: {
              condition_groups: node.rules.map((rule, index) => ({
                group_name: rule.name ?? `rule_${index + 1}`,
                group_type: 'complex', // single python expression → 'complex' group (frontend grid default)
                expression: rule.condition,
                conditions: [],
                manipulation: null,
                next_node: uuidOf(rule.next_node),
                order: index + 1,
                valid: true,
              })),
              default_next_node:
                node.default_next_node !== undefined ? uuidOf(node.default_next_node) : null,
              next_error_node: null,
            },
          },
        });
        node.rules.forEach((rule, index) => {
          pushEdge(
            {
              sourceNodeId: uuid,
              targetNodeId: uuidOf(rule.next_node),
              sourcePortId: `${uuid}_decision-route-${slugify(rule.name ?? `rule_${index + 1}`)}`,
            },
            // Layout sorts branch children by condition index (see layout.ts getPortSortKey).
            `${uuid}_decision-out-condition-${index + 1}`,
          );
        });
        if (node.default_next_node !== undefined) {
          pushEdge({
            sourceNodeId: uuid,
            targetNodeId: uuidOf(node.default_next_node),
            sourcePortId: `${uuid}_decision-default`,
          });
        }
        break;
      }

      case 'classification-decision-table': {
        if (node.categories.some((category) => category.description !== undefined)) {
          diagnostics.push(
            makeWarning(
              `${nodePath}.categories`,
              'category descriptions are not yet mapped into the classification table state and are ignored',
            ),
          );
        }
        nodes.push({
          ...base,
          type: 'classification-decision-table',
          data: {
            name: nodeName,
            table: {
              condition_groups: node.categories.map((category, index) => ({
                group_name: category.name,
                order: index + 1,
                expression: null,
                // The bulk-save mapper (and the frontend's payload builder) only
                // resolve a category's next_node when route_code is set — it is the
                // routing key. Mirror the frontend fallback ("Route code for <name>").
                route_code: `Route code for ${category.name}`,
                next_node: uuidOf(category.next_node),
              })),
              prompts: {},
              default_llm_config: registry.ref('llm_configs', node.llm_config) as unknown as number,
              default_next_node:
                node.default_next_node !== undefined ? uuidOf(node.default_next_node) : null,
              next_error_node: null,
            },
          },
        });
        node.categories.forEach((category, index) => {
          pushEdge(
            {
              sourceNodeId: uuid,
              targetNodeId: uuidOf(category.next_node),
              sourcePortId: `${uuid}_decision-route-${slugify(category.name)}`,
            },
            `${uuid}_decision-out-condition-${index + 1}`,
          );
        });
        if (node.default_next_node !== undefined) {
          pushEdge({
            sourceNodeId: uuid,
            targetNodeId: uuidOf(node.default_next_node),
            sourcePortId: `${uuid}_decision-default`,
          });
        }
        break;
      }

      default: {
        invariant(false, `unhandled node type '${(node as { type: string }).type}'`);
      }
    }
  }

  for (const edge of source.flow.edges) {
    if (edge.condition !== undefined) {
      const code =
        edge.condition.code ?? (await readFlowFile(flowDir, edge.condition.code_file as string));
      conditionalEdges.push({
        sourceNode: uuidOf(edge.from),
        sourceNodeName: edge.from,
        python_code: { code, entrypoint: edge.condition.entrypoint, libraries: [] },
        input_map: edge.condition.input_map,
      });
      continue;
    }
    pushEdge({ sourceNodeId: uuidOf(edge.from), targetNodeId: uuidOf(edge.to as string) });
  }

  return { nodes, edges, layoutConnections, conditionalEdges };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function applyLayout(
  source: FlowSource,
  nodes: GraphNode[],
  layoutConnections: LayoutConnection[],
): void {
  const layoutNodes: LayoutNode[] = nodes.map((node) => ({
    id: node.id,
    type: LAYOUT_TYPE_BY_NODE_TYPE[node.type],
    size: node.size,
  }));
  const computed = computeAutoArrangePositions(layoutNodes, layoutConnections);

  const pinnedByName = new Map<string, GraphPoint>();
  for (const [nodeName, node] of Object.entries(source.flow.nodes)) {
    if (node.type === 'llm' || node.type === 'code-agent') {
      continue; // load-time errors — never reach emit
    }
    if (node.position !== undefined) {
      pinnedByName.set(nodeName, node.position);
    }
  }

  // First place everything the layout knows about; source pins win over layout.
  const unplacedNotes: GraphNode[] = [];
  let maxBottom = CANVAS_START_Y;
  for (const node of nodes) {
    const pinned = pinnedByName.get(node.node_name);
    if (pinned !== undefined) {
      node.position = { ...pinned };
    } else {
      const position = computed.get(node.id);
      if (position === undefined) {
        // Only note nodes are excluded from layout (layout.ts filters them).
        unplacedNotes.push(node);
        continue;
      }
      node.position = position;
    }
    maxBottom = Math.max(maxBottom, node.position.y + node.size.height);
  }

  // Fallback row for un-pinned note nodes: below the connected layout.
  let noteX = CANVAS_START_X;
  const noteY = snapToGrid(maxBottom + DISCONNECTED_MARGIN);
  for (const node of unplacedNotes) {
    node.position = { x: snapToGrid(noteX), y: noteY };
    noteX += node.size.width + HORIZONTAL_GAP;
  }
}

function layoutBounds(nodes: GraphNode[]): Record<string, number> | null {
  if (nodes.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + node.size.width);
    maxY = Math.max(maxY, node.position.y + node.size.height);
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Emit entity plans + laid-out graph state for an error-free flow source.
 * Must only be called after `validateFlow` reported no errors.
 */
export async function emitFlow(source: FlowSource, flowDir: string): Promise<EmitResult> {
  const diagnostics: Diagnostic[] = [];
  const registry = new RefRegistry();

  const llmPlans = buildLlmConfigPlans(source);
  const toolConfigPlans = buildToolConfigPlans(source);
  const pythonToolPlans = await buildPythonToolPlans(source, flowDir, diagnostics);
  const mcpToolPlans = buildMcpToolPlans(source, diagnostics);
  const knowledgePlans = buildKnowledgePlans(source, flowDir, registry);
  const surfacePlans = buildSurfacePlans(source, registry);
  const agentPlans = buildAgentPlans(source, registry);

  const { nodes, edges, layoutConnections, conditionalEdges } = await buildGraph(
    source,
    flowDir,
    registry,
    diagnostics,
  );
  applyLayout(source, nodes, layoutConnections);

  // Dependency order per the artifact contract; every section's
  // resolve-existing plans precede its local upserts.
  const entities: EntityPlan[] = [
    ...registry.existingPlans('llm_configs', 'llm_config'),
    ...llmPlans,
    ...registry.existingPlans('tools.tool_configs', 'tool_config'),
    ...toolConfigPlans,
    ...registry.existingPlans('tools.python_code_tools', 'python_code_tool'),
    ...pythonToolPlans,
    ...registry.existingPlans('tools.mcp_tools', 'mcp_tool'),
    ...mcpToolPlans,
    ...registry.existingPlans('knowledge', 'knowledge_collection'),
    ...knowledgePlans,
    ...registry.existingPlans('surfaces', 'surface'),
    ...surfacePlans,
    ...registry.existingPlans('agents', 'agent_definition'),
    ...agentPlans,
    ...registry.existingPlans('crews', 'crew'),
  ];

  const nodesPerType: Record<string, number> = {};
  for (const node of nodes) {
    nodesPerType[node.type] = (nodesPerType[node.type] ?? 0) + 1;
  }
  const plansPerAction: Record<string, number> = { upsert: 0, 'resolve-existing': 0 };
  for (const plan of entities) {
    plansPerAction[plan.action] = (plansPerAction[plan.action] ?? 0) + 1;
  }

  const summary: Record<string, unknown> = {
    nodes: nodesPerType,
    edges: edges.length,
    entities: { total: entities.length, ...plansPerAction },
    layout: layoutBounds(nodes),
    /**
     * Conditional edges are NOT GraphEdgeState — the backend persists them
     * through the dedicated conditional-edge endpoint (see
     * `CreateConditionalEdgeRequest` in src/models/nodes/conditional-edge.ts).
     * artifact.ts is frozen, so they travel via the summary: the pusher reads
     * `summary.conditionalEdges`, maps each `sourceNode` uuid to its backend
     * node id after bulk-save, and POSTs one conditional edge per entry.
     */
    conditionalEdges,
  };

  return { entities, graph: { nodes, edges }, summary, diagnostics };
}
