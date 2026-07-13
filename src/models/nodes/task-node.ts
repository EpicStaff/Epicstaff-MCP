/**
 * TaskNode (NEW agent model) — single-task agent runner.
 * Ported from frontend `models/task-node.model.ts` + bulk-save emission in `utils/save/payload.ts`.
 */

import type { NodeDtoMetadata } from '../graph.js';

/** Write-shape entries used by `InlineSurface`'s tool/storage/knowledge lists. */
export interface InlineSurfacePythonTool {
  python_tool: number;
  mode: string;
}

export interface InlineSurfaceMcpTool {
  mcp_tool: number;
  mode: string;
}

export interface InlineSurfaceStorageItem {
  storage_file: number;
  can_view: string;
}

export interface InlineSurfaceKnowledge {
  collection: number;
  naive_search_config?: unknown;
}

/**
 * The task-local ("Local surface") nested object. Independent of `surface_list`
 * (which references existing catalog `Surface` ids). `null` means no local surface.
 * `id`/`created_at`/`updated_at` are read-only (present on read, absent when creating).
 */
export interface InlineSurface {
  id?: number;
  instructions: string;
  python_tools: InlineSurfacePythonTool[];
  mcp_tools: InlineSurfaceMcpTool[];
  storage_items: InlineSurfaceStorageItem[];
  knowledge: InlineSurfaceKnowledge[];
  created_at?: string;
  updated_at?: string;
}

export interface TaskNodeDto {
  id: number;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  node_name: string;
  graph: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  instructions: string;
  /** Non-nullable JSONField on the backend — `{}` means "no schema". Never `null`. */
  output_schema: Record<string, unknown>;
  remember_output: boolean;
  agent_definition: number | null;
  content_hash?: string;
  /** Flat array of existing catalog `Surface` ids (agent-owned + shared). */
  surface_list: number[];
  /** Task-local nested surface, or `null` when absent. */
  inline_surface: InlineSurface | null;
}

export interface TaskNodeWrite {
  node_name: string;
  graph: number;
  instructions: string;
  output_schema: Record<string, unknown>;
  remember_output: boolean;
  agent_definition: number | null;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  surface_list: number[];
  inline_surface: InlineSurface | null;
  metadata: NodeDtoMetadata;
}
