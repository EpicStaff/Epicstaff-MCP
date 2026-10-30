/**
 * Ported from frontend `visual-programming/core/models/classification-decision-table-node.model.ts`,
 * `visual-programming/core/models/cdt-section.model.ts` (section shape + colour normalisation) and
 * `buildCdtNodePayload` in `visual-programming/utils/save/payload.ts`.
 */

import type { AuthorshipFields, NumberedNodeDto } from '../authorship.js';
import type { NodeDtoMetadata } from '../graph.js';
import type { DeclaredSecretRef } from './python-node.js';

export interface CdtPythonCodeBlock {
  code: string;
  entrypoint: string;
  global_kwargs: Record<string, unknown>;
  content_hash?: string;
  /** Write side: secrets the computation may read. */
  secret_ids?: number[];
  /** Read side of `secret_ids`. */
  secrets?: DeclaredSecretRef[];
  /** Seconds one run of the code may take; the backend applies its default when it is left out. */
  execution_timeout?: number;
}

/**
 * A named, coloured group of condition rows (`ClassificationDecisionTableSectionBackend`).
 * `id` is client-generated (a uuid) and is what a condition group's `section` points at.
 */
export interface CdtSectionDto {
  id: string;
  name: string;
  metadata: { color?: string };
}

/**
 * Palette of `CDT_SECTION_COLOR_OPTIONS`. Persisted data (the value travels in `metadata.color`),
 * so the literal hexes are intentional.
 */
const CDT_SECTION_COLOR_HEXES = ['#685FFF', '#48CBFF', '#2ABA6B', '#FF8F3F', '#F54242'] as const;

export const CDT_SECTION_DEFAULT_COLOR: string = CDT_SECTION_COLOR_HEXES[0];

const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `normalizeCdtSectionColor`: a palette hex in its canonical case, any other valid hex upper-cased, else the default. */
export function normalizeCdtSectionColor(color?: string | null): string {
  if (!color) return CDT_SECTION_DEFAULT_COLOR;
  const trimmed = color.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return CDT_SECTION_DEFAULT_COLOR;
  const match = CDT_SECTION_COLOR_HEXES.find((hex) => hex.toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed.toUpperCase();
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
  /** Backend id of the linked prompt config. */
  prompt: number | null;
  /** Per-node key of the linked prompt config (added by the serializer's to_representation). */
  prompt_key?: string | null;
  manipulation: string | null;
  continue_flag: boolean;
  route_code: string | null;
  dock_visible: boolean;
  field_expressions: Record<string, string>;
  field_manipulations: Record<string, string>;
  next_node_id?: number | null;
  /** Id of the row's section (`CdtSectionDto.id`), or null when the row is in none. */
  section?: string | null;
}

export interface CdtConditionGroupWrite {
  group_name: string;
  order: number;
  expression: string | null;
  /**
   * Preferred link: the prompt's per-node key (works for a prompt created in the same
   * save). `prompt` (numeric id) is kept for back-compat; the backend prefers the key.
   */
  prompt_key: string | null;
  prompt: number | null;
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

export interface ClassificationDecisionTableNodeDto extends AuthorshipFields, NumberedNodeDto {
  id: number;
  created_at: string;
  graph: number;
  node_name: string;
  pre_python_code: CdtPythonCodeBlock | null;
  pre_input_map: Record<string, string>;
  pre_output_variable_path: string | null;
  pre_use_storage: boolean;
  post_python_code: CdtPythonCodeBlock | null;
  post_input_map: Record<string, string>;
  post_output_variable_path: string | null;
  post_use_storage: boolean;
  prompt_configs: PromptConfigDto[];
  default_llm_config: number | null;
  default_next_node_id: number | null;
  next_error_node_id: number | null;
  condition_groups: CdtConditionGroupDto[];
  sections?: CdtSectionDto[];
  metadata?: unknown;
}

export interface ClassificationDecisionTableNodeWrite {
  graph: number;
  node_name: string;
  pre_python_code: CdtPythonCodeBlock | null;
  pre_input_map: Record<string, string>;
  pre_output_variable_path: string | null;
  pre_use_storage: boolean;
  post_python_code: CdtPythonCodeBlock | null;
  post_input_map: Record<string, string>;
  post_output_variable_path: string | null;
  post_use_storage: boolean;
  prompt_configs: PromptConfigWrite[];
  default_llm_config: number | null;
  /** Emitted only when resolved to a persisted node (mirrors frontend conditional spread). */
  default_next_node_id?: number;
  default_next_node_temp_id?: string;
  next_error_node_id?: number;
  next_error_node_temp_id?: string;
  condition_groups: CdtConditionGroupWrite[];
  sections: CdtSectionDto[];
  /** Node metadata plus the stored step `explanations` (`{}` when none). */
  metadata: NodeDtoMetadata & { explanations: Record<string, unknown> };
}
