/**
 * Conditional edge — part of `GraphDto` (`conditional_edge_list`). Not emitted by the
 * bulk-save builder (the frontend persists conditional edges through dedicated endpoints).
 * Ported from frontend `models/conditional-edge.model.ts`.
 */

import type { CustomPythonCode, GetPythonCodeDto } from './python-node.js';

export interface ConditionalEdgeDto {
  id: number;
  graph: number;
  source_node_id: number;
  python_code: GetPythonCodeDto;
  input_map: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface CreateConditionalEdgeRequest {
  graph: number;
  source_node_id: number | null;
  python_code: Omit<CustomPythonCode, 'id' | 'name' | 'use_storage'>;
  input_map: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
