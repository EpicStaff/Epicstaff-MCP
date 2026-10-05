/**
 * Ported from frontend `pages/flows-page/components/flow-visual-programming/models/webhook-trigger.ts`,
 * `visual-programming/core/models/webhook-trigger.model.ts`, and the bulk-save
 * emission in `visual-programming/utils/save/payload.ts` (which always sends `webhook_trigger_path: ''`).
 */

import type { NodeDtoMetadata } from '../graph.js';
import type { CustomPythonCode, GetPythonCodeDto } from './python-node.js';

export type WebhookProviderType = 'ngrok' | 'localhost';

export interface NgrokConfigInline {
  name: string;
  auth_token_secret_id: number | null;
  domain: string | null;
  region: 'us' | 'eu' | 'ap';
}

export interface LocalhostConfigInline {
  name: string;
  domain?: string | null;
}

export type WebhookTriggerAuthKind = 'webhook' | 'telegram' | 'twilio';

export interface WebhookTriggerAuth {
  kind: WebhookTriggerAuthKind;
  secret_tail: string | null;
}

/** A `webhook-triggers/` row (WebhookTriggerNestedSerializer). */
export interface WebhookTriggerModel {
  id?: number;
  path: string;
  provider_type: WebhookProviderType | null;
  ngrok_config: NgrokConfigInline | null;
  localhost_config: LocalhostConfigInline | null;
  live_url?: string | null;
  auth_kind?: WebhookTriggerAuthKind;
  auth_secret_id?: number | null;
  auth?: WebhookTriggerAuth | null;
}

/**
 * `webhook_trigger` on a trigger node. The v1.2.1 frontend node models type it
 * `WebhookTriggerModel | null`, but both the node serializers (bulk-save) and `GET graphs/{id}/`
 * use a primary-key field — the nested form is only returned by the per-node read endpoints. MCP only ever
 * reads the graph and writes via bulk-save, so the id is the whole contract.
 */
export type WebhookTriggerRef = number;

export interface WebhookTriggerNodeDto {
  id: number;
  node_name: string;
  graph: number;
  python_code: GetPythonCodeDto;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  webhook_trigger_path?: string;
  metadata: Record<string, unknown>;
  webhook_trigger: WebhookTriggerRef | null;
}

export interface WebhookTriggerNodeWrite {
  node_name: string;
  graph: number;
  python_code: CustomPythonCode;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  /** Always `''` at bulk-save time — the backend derives the real path. */
  webhook_trigger_path: string;
  webhook_trigger: WebhookTriggerRef | null;
  metadata: NodeDtoMetadata;
}
