/**
 * Ported from frontend `models/decision-table-node.model.ts` + `buildDecisionTableNodePayload`
 * in `utils/save/payload.ts` (which adds the `*_temp_id` cross-node reference variants).
 */

import type { NodeDtoMetadata } from '../graph.js';

export interface ConditionDto {
  id: number;
  condition_group: number;
  condition_name: string;
  condition: string;
}

export interface ConditionGroupDto {
  id: number;
  decision_table_node: number;
  group_name: string;
  group_type: string;
  expression: string | null;
  conditions: ConditionDto[];
  manipulation: string | null;
  next_node_id: number | null;
  order: number;
}

export interface DecisionTableNodeDto {
  id: number;
  graph: number;
  node_name: string;
  condition_groups: ConditionGroupDto[];
  default_next_node_id: number | null;
  next_error_node_id: number | null;
  metadata: Record<string, unknown>;
}

export interface DecisionTableConditionWrite {
  condition_name: string;
  condition: string;
}

export interface DecisionTableConditionGroupWrite {
  group_name: string;
  group_type: string;
  expression: string | null;
  conditions: DecisionTableConditionWrite[];
  manipulation: string | null;
  next_node_id: number | null;
  /** Present only when the branch targets a not-yet-persisted node. */
  next_node_temp_id?: string;
  order: number;
}

export interface DecisionTableNodeWrite {
  graph: number;
  node_name: string;
  condition_groups: DecisionTableConditionGroupWrite[];
  default_next_node_id: number | null;
  /** Present only when the default branch targets a not-yet-persisted node. */
  default_next_node_temp_id?: string;
  next_error_node_id: number | null;
  /** Present only when the error branch targets a not-yet-persisted node. */
  next_error_node_temp_id?: string;
  metadata: NodeDtoMetadata;
}
