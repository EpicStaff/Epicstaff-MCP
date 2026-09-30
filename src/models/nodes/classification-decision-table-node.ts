/**
 * Ported from frontend `models/classification-decision-table-node.model.ts` +
 * `buildCdtNodePayload` in `utils/save/payload.ts`.
 */

import type { NodeDtoMetadata } from '../graph.js';

export interface CdtPythonCodeBlock {
  libraries: string[];
  code: string;
  entrypoint: string;
  global_kwargs: Record<string, unknown>;
  content_hash?: string;
}

export interface PromptConfigDto {
  id: number;
  prompt_key: string;
  prompt_text: string;
  llm_config: number | null;
  output_schema: Record<string, unknown> | string | null;
  result_variable: string;
  variable_mappings: Record<string, string>;
}

export interface PromptConfigWrite {
  prompt_key: string;
  prompt_text: string;
  llm_config: number | null;
  output_schema: Record<string, unknown> | string | null;
  result_variable: string;
  variable_mappings: Record<string, string>;
}

export interface CdtConditionGroupDto {
  id: number;
  classification_decision_table_node: number;
  group_name: string;
  order: number;
  expression: string | null;
  prompt_id: string | null;
  manipulation: string | null;
  continue_flag: boolean;
  route_code: string | null;
  dock_visible: boolean;
  field_expressions: Record<string, string>;
  field_manipulations: Record<string, string>;
  next_node_id?: number | null;
  section?: string | null;
}

export interface CdtConditionGroupWrite {
  group_name: string;
  order: number;
  expression: string | null;
  prompt_id: string | null;
  manipulation: string | null;
  continue_flag: boolean;
  route_code: string | null;
  section: string | null;
  next_node_id: number | null;
  /** Present only when the route targets a not-yet-persisted node. */
  next_node_temp_id?: string;
  dock_visible: boolean;
  field_expressions: Record<string, string>;
  field_manipulations: Record<string, string>;
}

export interface ClassificationDecisionTableNodeDto {
  id: number;
  graph: number;
  node_name: string;
  pre_python_code: CdtPythonCodeBlock | null;
  pre_input_map: Record<string, string>;
  pre_output_variable_path: string | null;
  post_python_code: CdtPythonCodeBlock | null;
  post_input_map: Record<string, string>;
  post_output_variable_path: string | null;
  prompt_configs: PromptConfigDto[];
  default_llm_config: number | null;
  default_next_node_id: number | null;
  next_error_node_id: number | null;
  condition_groups: CdtConditionGroupDto[];
  metadata?: unknown;
}

export interface ClassificationDecisionTableNodeWrite {
  graph: number;
  node_name: string;
  pre_python_code: CdtPythonCodeBlock | null;
  pre_input_map: Record<string, string>;
  pre_output_variable_path: string | null;
  post_python_code: CdtPythonCodeBlock | null;
  post_input_map: Record<string, string>;
  post_output_variable_path: string | null;
  prompt_configs: PromptConfigWrite[];
  default_llm_config: number | null;
  /** Emitted only when resolved to a persisted node (mirrors frontend conditional spread). */
  default_next_node_id?: number;
  default_next_node_temp_id?: string;
  next_error_node_id?: number;
  next_error_node_temp_id?: string;
  condition_groups: CdtConditionGroupWrite[];
  metadata: NodeDtoMetadata;
}
