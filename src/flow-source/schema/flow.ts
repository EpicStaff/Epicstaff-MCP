/**
 * `flow` section — the graph itself: type-discriminated nodes keyed by symbolic
 * name, plus edges referencing nodes by name.
 *
 * Node types `llm`, `code-agent` and `crew` are parsed loosely (so the rest of
 * the file can still be validated) but always rejected with an ERROR diagnostic
 * by the loader — EpicStaff no longer has them (`crew` was removed in EST-3849).
 */
import { z } from 'zod';

import {
  entityRef,
  entityRefSchema,
  inputMapSchema,
  positionSchema,
  symbolicNameSchema,
} from './common.js';
import { inlineSurfaceSchema } from './surfaces.js';

/** Node types that may be written in flow source. */
export const FLOW_NODE_TYPES = [
  'start',
  'agent',
  'task',
  'python',
  'end',
  'note',
  'file-extractor',
  'subgraph',
  'webhook-trigger',
  'telegram-trigger',
  'schedule-trigger',
  'decision-table',
  'classification-decision-table',
  'audio-to-text',
  'knowledge-retriever',
  'key-value',
] as const;

/**
 * Legacy node types that are never accepted — the loader turns them into ERROR
 * diagnostics that name the replacement (see `loader.ts`).
 */
export const FORBIDDEN_NODE_TYPES = ['llm', 'code-agent', 'crew'] as const;

export type ForbiddenNodeType = (typeof FORBIDDEN_NODE_TYPES)[number];

/** A node type that may appear in flow source. Excludes the forbidden types. */
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

const FORBIDDEN_NODE_TYPE_SET: ReadonlySet<string> = new Set(FORBIDDEN_NODE_TYPES);

/** Narrow a parsed node to the writable node types (forbidden ones are load-time errors). */
export function isForbiddenNodeType(type: string): type is ForbiddenNodeType {
  return FORBIDDEN_NODE_TYPE_SET.has(type);
}

const outputVariablePathField = z
  .string()
  .optional()
  .describe('Dot path in flow state where this node\'s output is stored, e.g. "variables.research_result".');

const positionField = positionSchema.optional();

const inputMapField = inputMapSchema.default({});

export const startNodeSchema = z.strictObject({
  type: z.literal('start'),
  position: positionField,
  initial_state: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Initial flow-state variables available to downstream nodes.'),
});

export const agentNodeTaskSchema = z.strictObject({
  name: z.string().optional().describe('Task name; defaults to "task-<order>".'),
  instructions: z.string().min(1).describe('What the agent must do in this task.'),
  output_schema: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Optional JSON schema for the task output; {} means free-form.'),
});

export const agentNodeSchema = z.strictObject({
  type: z.literal('agent'),
  position: positionField,
  agent: entityRef('The AgentDefinition this node runs.'),
  tasks: z
    .array(agentNodeTaskSchema)
    .default([])
    .describe(
      'Ordered tasks the agent executes at this node. The runtime requires at least one — ' +
        'an agent node without tasks fails with "has no tasks to execute".',
    ),
  surfaces: z
    .array(entityRefSchema)
    .default([])
    .describe('Catalog surfaces attached to this node (its surface_list).'),
  inline_surface: inlineSurfaceSchema
    .optional()
    .describe('Ad-hoc surface for this node only, merged with the attached catalog surfaces.'),
  input_map: inputMapField,
  output_variable_path: outputVariablePathField,
});

export const taskNodeSchema = z.strictObject({
  type: z.literal('task'),
  position: positionField,
  agent: entityRef('The AgentDefinition that performs this task.'),
  task: z.string().min(1).describe('The task text given to the agent.'),
  expected_output: z
    .string()
    .optional()
    .describe('Description of what a correct output looks like.'),
  surfaces: z
    .array(entityRefSchema)
    .default([])
    .describe('Catalog surfaces attached to this node (its surface_list).'),
  inline_surface: inlineSurfaceSchema
    .optional()
    .describe('Ad-hoc surface for this node only, merged with the attached catalog surfaces.'),
  input_map: inputMapField,
  output_variable_path: outputVariablePathField,
});

export const pythonNodeSchema = z.strictObject({
  type: z.literal('python'),
  position: positionField,
  code: z
    .string()
    .optional()
    .describe('Inline Python source defining the entrypoint. Provide exactly one of code / code_file.'),
  code_file: z
    .string()
    .optional()
    .describe(
      'Path to a Python file relative to the flow directory. Provide exactly one of code / code_file.',
    ),
  entrypoint: z
    .string()
    .default('main')
    .describe('Name of the Python function executed by the sandbox.'),
  libraries: z
    .array(z.string())
    .default([])
    .describe('pip packages installed into the sandbox venv before execution.'),
  input_map: inputMapField,
  output_variable_path: outputVariablePathField,
});

export const endNodeSchema = z.strictObject({
  type: z.literal('end'),
  position: positionField,
});

export const noteNodeSchema = z.strictObject({
  type: z.literal('note'),
  position: positionField,
  text: z.string().describe('Free-form note shown on the canvas; has no runtime effect.'),
});

export const fileExtractorNodeSchema = z.strictObject({
  type: z.literal('file-extractor'),
  position: positionField,
  file: z
    .string()
    .optional()
    .describe('Remote storage file to extract text from; may also be supplied via input_map.'),
  input_map: inputMapField,
  output_variable_path: outputVariablePathField,
});

export const subgraphNodeSchema = z.strictObject({
  type: z.literal('subgraph'),
  position: positionField,
  graph: entityRef(
    'The flow embedded by this node. A local name refers to a sibling flow directory (resolved at build time); referencing this flow itself is a circular-reference error.',
  ),
  input_map: inputMapField,
  output_variable_path: outputVariablePathField,
});

export const webhookTriggerNodeSchema = z.strictObject({
  type: z.literal('webhook-trigger'),
  position: positionField,
  output_variable_path: outputVariablePathField,
});

export const telegramTriggerNodeSchema = z.strictObject({
  type: z.literal('telegram-trigger'),
  position: positionField,
  bot_token_env: z
    .string()
    .optional()
    .describe(
      'Environment variable holding the Telegram bot token. The token never lives in flow source: ' +
        'on push it is stored as an org Secret (named "es-mcp:<ENV>") and the node references that secret.',
    ),
  output_variable_path: outputVariablePathField,
});

export const scheduleTriggerNodeSchema = z.strictObject({
  type: z.literal('schedule-trigger'),
  position: positionField,
  schedule: z.string().min(1).describe('Cron expression, e.g. "0 9 * * MON".'),
  output_variable_path: outputVariablePathField,
});

export const decisionTableRuleSchema = z.strictObject({
  name: z.string().optional().describe('Optional label for the rule.'),
  condition: z
    .string()
    .min(1)
    .describe('Python expression over flow state; the first matching rule wins.'),
  next_node: symbolicNameSchema.describe('Node to route to when this rule matches.'),
});

export const decisionTableNodeSchema = z.strictObject({
  type: z.literal('decision-table'),
  position: positionField,
  rules: z.array(decisionTableRuleSchema).min(1).describe('Ordered routing rules.'),
  default_next_node: symbolicNameSchema
    .optional()
    .describe('Node to route to when no rule matches.'),
  input_map: inputMapField,
});

export const classificationCategorySchema = z.strictObject({
  name: z.string().min(1).describe('Category label the LLM classifies into.'),
  description: z
    .string()
    .optional()
    .describe('What belongs in this category — given to the classifying LLM.'),
  next_node: symbolicNameSchema.describe('Node to route to for this category.'),
});

export const classificationDecisionTableNodeSchema = z.strictObject({
  type: z.literal('classification-decision-table'),
  position: positionField,
  llm_config: entityRef('LLM config intended to classify the input.'),
  categories: z
    .array(classificationCategorySchema)
    .min(1)
    .describe(
      'Intended classification categories. CAVEAT: as currently compiled this node does not reliably ' +
        'classify — routing falls through to the first category. For real branching use a rule-based ' +
        'decision-table. See describe_node_types for the current caveat.',
    ),
  default_next_node: symbolicNameSchema
    .optional()
    .describe('Node to route to when classification fails or matches nothing.'),
  input_map: inputMapField,
});

export const audioToTextNodeSchema = z.strictObject({
  type: z.literal('audio-to-text'),
  position: positionField,
  model: z
    .string()
    .optional()
    .describe('Transcription model name. Backend default when omitted.'),
  input_map: inputMapField,
  output_variable_path: outputVariablePathField,
});

export const knowledgeRetrieverNodeSchema = z.strictObject({
  type: z.literal('knowledge-retriever'),
  position: positionField,
  collection: entityRef('The knowledge collection this node searches.'),
  rag: z
    .enum(['naive', 'graph'])
    .optional()
    .describe(
      'Which RAG of the collection to search. Defaults to the local collection\'s rag.strategy; ' +
        'REQUIRED for an {existing: ...} collection.',
    ),
  query: z
    .string()
    .min(1)
    .describe(
      'Search query template. {name} placeholders are filled from this node\'s input_map keys at run time, ' +
        'e.g. query: "{question}" with input_map: { question: variables.question }.',
    ),
  search_method: z
    .enum(['basic', 'local', 'global', 'drift'])
    .optional()
    .describe('Graph RAG only: the graph search method. Backend default "basic" when omitted.'),
  search_configs: z
    .strictObject({
      naive: z.record(z.string(), z.unknown()).optional().describe('Naive search params, e.g. { search_limit, similarity_threshold }.'),
      graph: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Graph search params keyed by method, e.g. { basic: { k: 10 } }.'),
    })
    .optional()
    .describe('Optional per-node search parameters, passed through to the backend as-is.'),
  input_map: inputMapField,
  output_variable_path: outputVariablePathField,
});

export const keyValueEntrySchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .describe(
      'Stored key. Letters, digits and _ (not starting with a digit), plus {variables.<path>} placeholders, ' +
        'e.g. "profile_{variables.user_id}".',
    ),
  value: z
    .string()
    .optional()
    .describe(
      'Flow-state path. read: where the stored value is written (no |default). ' +
        'write: where the value to store is read from (may end in |default). Omit for delete.',
    ),
});

export const keyValueNodeSchema = z.strictObject({
  type: z.literal('key-value'),
  position: positionField,
  table: z
    .string()
    .min(1)
    .describe('Name of the organization Key-Value table. Created on push when no table with this name exists.'),
  mode: z.enum(['read', 'write', 'delete']).default('read').describe('What the node does with its entries.'),
  entries: z
    .array(keyValueEntrySchema)
    .default([])
    .describe('Keys to read / write / delete (at most 500).'),
});

/** Legacy types — parse loosely so the loader can emit a precise ERROR diagnostic. */
const forbiddenLlmNodeSchema = z.object({ type: z.literal('llm') }).passthrough();
const forbiddenCodeAgentNodeSchema = z.object({ type: z.literal('code-agent') }).passthrough();
const forbiddenCrewNodeSchema = z.object({ type: z.literal('crew') }).passthrough();

export const nodeSchema = z
  .discriminatedUnion('type', [
    startNodeSchema,
    agentNodeSchema,
    taskNodeSchema,
    pythonNodeSchema,
    endNodeSchema,
    noteNodeSchema,
    fileExtractorNodeSchema,
    subgraphNodeSchema,
    webhookTriggerNodeSchema,
    telegramTriggerNodeSchema,
    scheduleTriggerNodeSchema,
    decisionTableNodeSchema,
    classificationDecisionTableNodeSchema,
    audioToTextNodeSchema,
    knowledgeRetrieverNodeSchema,
    keyValueNodeSchema,
    forbiddenLlmNodeSchema,
    forbiddenCodeAgentNodeSchema,
    forbiddenCrewNodeSchema,
  ])
  .describe('A flow node, discriminated by its "type" field.');

export type NodeSource = z.infer<typeof nodeSchema>;
export type AgentNodeSource = z.infer<typeof agentNodeSchema>;
export type TaskNodeSource = z.infer<typeof taskNodeSchema>;
export type PythonNodeSource = z.infer<typeof pythonNodeSchema>;
export type KnowledgeRetrieverNodeSource = z.infer<typeof knowledgeRetrieverNodeSchema>;
export type KeyValueNodeSource = z.infer<typeof keyValueNodeSchema>;
/** A node of a writable type — forbidden legacy types excluded. */
export type WritableNodeSource = Exclude<NodeSource, { type: ForbiddenNodeType }>;

/** Narrow a parsed node to the writable types (the loader rejects the forbidden ones). */
export function isWritableNode(node: NodeSource): node is WritableNodeSource {
  return !isForbiddenNodeType(node.type);
}

export const edgeConditionSchema = z
  .strictObject({
    code: z
      .string()
      .optional()
      .describe(
        'Inline Python decision code: the entrypoint receives the mapped inputs and returns the name of the next node. Provide exactly one of code / code_file.',
      ),
    code_file: z
      .string()
      .optional()
      .describe(
        'Path to a Python file relative to the flow directory. Provide exactly one of code / code_file.',
      ),
    entrypoint: z.string().default('main').describe('Name of the Python decision function.'),
    input_map: inputMapField,
  })
  .superRefine((condition, ctx) => {
    const hasCode = condition.code !== undefined;
    const hasCodeFile = condition.code_file !== undefined;
    if (hasCode === hasCodeFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of code / code_file',
      });
    }
  })
  .describe('Conditional routing: Python code that returns the name of the next node.');

export type EdgeConditionSource = z.infer<typeof edgeConditionSchema>;

export const edgeSchema = z
  .strictObject({
    from: symbolicNameSchema.describe('Source node symbolic name.'),
    to: symbolicNameSchema
      .optional()
      .describe('Target node symbolic name. Provide exactly one of to / condition.'),
    condition: edgeConditionSchema
      .optional()
      .describe('Conditional edge body. Provide exactly one of to / condition.'),
  })
  .superRefine((edge, ctx) => {
    const hasTo = edge.to !== undefined;
    const hasCondition = edge.condition !== undefined;
    if (hasTo === hasCondition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an edge needs exactly one of to / condition',
      });
    }
  })
  .describe('A directed edge between nodes, plain ({from, to}) or conditional ({from, condition}).');

export type EdgeSource = z.infer<typeof edgeSchema>;

export const flowSectionSchema = z
  .strictObject({
    nodes: z
      .record(symbolicNameSchema, nodeSchema)
      .default({})
      .describe('Flow nodes, keyed by symbolic name.'),
    edges: z.array(edgeSchema).default([]).describe('Directed edges between nodes.'),
  })
  .describe('The flow graph: nodes and edges.');

export type FlowSectionSource = z.infer<typeof flowSectionSchema>;
