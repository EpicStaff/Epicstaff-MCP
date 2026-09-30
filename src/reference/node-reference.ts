/**
 * Human-authored reference for each flow node type: a one-line summary, when to reach
 * for it, and runtime caveats the compiler does NOT catch. This is the single place
 * such prose lives — the mechanical field list is derived from the schema in
 * `node-schema-introspect.ts`. The `describe_node_types` tool merges the two.
 *
 * Caveats are hard-won runtime findings (live-verified on localhost:8000, 2026-07).
 * Keep them accurate: if the backend behavior changes, update the caveat here.
 */
import type { FlowNodeType } from '../flow-source/schema/flow.js';

export interface NodeReference {
  summary: string;
  whenToUse: string;
  caveats: string[];
}

/**
 * Keyed by every writable node type. The `Record<FlowNodeType, …>` type makes it a
 * compile error to add a node type to the schema without documenting it here.
 */
export const NODE_REFERENCE: Record<FlowNodeType, NodeReference> = {
  start: {
    summary: 'The flow entry point; its `variables` (initial_state) is the authoritative Domain.',
    whenToUse: 'Every non-triggered flow needs exactly one. Seed initial variables here.',
    caveats: [
      'Reserved dict-method names as variable keys (items, keys, values, get, …) break flow-state ' +
        'serialization at session start — do not use them as variable names.',
      'List-index read paths in input_map (e.g. variables.a[1].b) are not supported at runtime — ' +
        'read the whole list into a variable and index it inside a python node instead.',
    ],
  },
  agent: {
    summary: 'Runs an AgentDefinition over one or more ordered tasks (dispatched to the agent service).',
    whenToUse: 'Multi-step agent work at one node, or when you want several tasks to share one agent.',
    caveats: [
      'Requires at least one entry in `tasks:` — an agent node with no tasks fails at runtime with ' +
        '"has no tasks to execute" (build_flow also errors on this).',
    ],
  },
  task: {
    summary: 'Runs a single task on an AgentDefinition.',
    whenToUse: 'One discrete unit of agent work. Prefer over an agent node for a single step.',
    caveats: [],
  },
  python: {
    summary: 'Executes Python in the sandbox; reads inputs from and writes outputs to flow state.',
    whenToUse: 'Deterministic transforms, glue, list/index manipulation, calling out to libraries.',
    caveats: [
      'Provide exactly one of `code` / `code_file`; the `entrypoint` function receives the mapped inputs.',
    ],
  },
  end: {
    summary: 'Terminal node; marks a successful end of the run.',
    whenToUse: 'The single convergence point for all completing paths.',
    caveats: [],
  },
  note: {
    summary: 'Canvas annotation with no runtime effect.',
    whenToUse: 'Documenting a flow visually. Not connectable by edges.',
    caveats: [],
  },
  'file-extractor': {
    summary: 'Extracts text from a stored file into flow state.',
    whenToUse: 'Turning an uploaded/stored document into text for downstream nodes.',
    caveats: [],
  },
  subgraph: {
    summary: 'Embeds another flow as a node.',
    whenToUse: 'Reusing a whole flow as a step. Referencing the flow itself is a circular-reference error.',
    caveats: [],
  },
  'webhook-trigger': {
    summary: 'Starts the flow on an incoming webhook; its payload seeds flow state.',
    whenToUse: 'Event-driven flows started by an external HTTP call. The trigger is the interface.',
    caveats: [],
  },
  'telegram-trigger': {
    summary: 'Starts the flow on a Telegram message.',
    whenToUse: 'Telegram-bot-driven flows. Supply the bot token via env, never in flow source.',
    caveats: [],
  },
  'schedule-trigger': {
    summary: 'Starts the flow on a cron schedule.',
    whenToUse: 'Periodic/batch flows. No separate consumer — the schedule is the interface.',
    caveats: [],
  },
  'decision-table': {
    summary: 'Rule-based branching: the first matching Python condition routes to its next_node.',
    whenToUse: 'The reliable branching primitive. Prefer this over classification-decision-table.',
    caveats: [
      'The condition runs with `variables` as a plain dict, so write dict-subscript access ' +
        "(variables['x']['y'] == …) — NOT attribute access or a bare input_map key.",
      'Rules are ordered; the first match wins. Provide default_next_node for the no-match path.',
    ],
  },
  'classification-decision-table': {
    summary: 'Intended LLM-based classification routing (see caveat — currently unreliable).',
    whenToUse: 'Avoid for now — use a rule-based decision-table for branching that must actually work.',
    caveats: [
      'Does NOT reliably classify: as currently compiled it routes to the FIRST category regardless ' +
        'of input (no LLM classification call is made). Live-verified 2026-07. Use a rule-based ' +
        'decision-table instead until the backend/emit wires a real classification prompt.',
    ],
  },
  'audio-to-text': {
    summary: 'Transcribes audio to text into flow state (runs via crew + sandbox).',
    whenToUse: 'Speech-to-text steps inside a flow.',
    caveats: [],
  },
  crew: {
    summary: 'DEPRECATED — runs a legacy remote crew (project). Prefer agent/task nodes.',
    whenToUse: 'Only when the user explicitly needs the legacy crew path. Emits a deprecation warning.',
    caveats: [
      'Deprecated. Crews cannot be defined in flow source — only referenced via {existing: "<name>"}.',
    ],
  },
};
