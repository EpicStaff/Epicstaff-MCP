/**
 * Ported from frontend `models/webhook-trigger.ts`,
 * `visual-programming/core/models/webhook-trigger.model.ts`, and the bulk-save
 * emission in `utils/save/payload.ts` (which always sends `webhook_trigger_path: ''`).
 */

import type { NodeDtoMetadata } from '../graph.js';
import type { CustomPythonCode, GetPythonCodeDto } from './python-node.js';

export interface WebhookTriggerModel {
  path: string;
  ngrok_webhook_config: number | null;
}

export interface WebhookTriggerNodeDto {
  id: number;
  node_name: string;
  graph: number;
  python_code: GetPythonCodeDto;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  webhook_trigger_path: string;
  metadata: Record<string, unknown>;
  webhook_trigger: WebhookTriggerModel | null;
}

export interface WebhookTriggerNodeWrite {
  node_name: string;
  graph: number;
  python_code: CustomPythonCode;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  /** Always `''` at bulk-save time — the backend derives the real path. */
  webhook_trigger_path: string;
  webhook_trigger: WebhookTriggerModel | null;
  metadata: NodeDtoMetadata;
}
