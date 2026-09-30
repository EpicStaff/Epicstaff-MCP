/**
 * AgentNode (NEW agent model) — one agent over an ordered list of sub-tasks.
 * Ported from frontend `models/agent-node.model.ts` + bulk-save emission in `utils/save/payload.ts`.
 */

import type { NodeDtoMetadata } from '../graph.js';
import type { InlineSurface } from './task-node.js';

/**
 * Read-shape of a single task belonging to an AgentNode, as returned by
 * `GET /graphs/:id/` under `agent_node_list[].tasks[]`.
 */
export interface AgentNodeTaskDto {
  id: number;
  name: string;
  order: number;
  instructions: string;
  /** Non-nullable JSONField on the backend — `{}` means "no schema". Never `null`. */
  output_schema: Record<string, unknown>;
  /** Backward-only refs to sibling tasks (strictly lower `order`) within the same node. */
  context_tasks: number[];
  created_at?: string;
  updated_at?: string;
}

export interface AgentNodeTaskWrite {
  temp_id?: string;
  id?: number;
  name: string;
  order: number;
  instructions: string;
  output_schema: Record<string, unknown>;
  /** Refs to NEW sibling tasks (identified by their `temp_id`). */
  context_task_temp_ids?: string[];
  /** Refs to EXISTING sibling tasks (identified by their backend `id`). */
  context_task_ids?: number[];
}

/** Client-side sub-task state fed into the bulk-save builder (frontend `AgentNodeTaskUi`). */
export interface AgentNodeTaskUi {
  id?: number;
  tempId: string;
  name: string;
  instructions: string;
  output_schema: Record<string, unknown>;
  contextRefs: Array<{ id?: number; tempId?: string }>;
}

export interface AgentNodeDto {
  id: number;
  created_at?: string;
  updated_at?: string;
  metadata: Record<string, unknown>;
  node_name: string;
  graph?: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  agent_definition: number | null;
  surface_list: number[];
  tasks: AgentNodeTaskDto[];
  inline_surface: InlineSurface | null;
  content_hash?: string;
}

export interface AgentNodeWrite {
  node_name: string;
  graph: number;
  agent_definition: number | null;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  surface_list: number[];
  inline_surface: InlineSurface | null;
  tasks: AgentNodeTaskWrite[];
  metadata: NodeDtoMetadata;
}
