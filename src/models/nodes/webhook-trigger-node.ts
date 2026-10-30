/**
 * Ported from frontend `visual-programming/core/models/webhook-trigger.ts`,
 * `shared/models/webhook-trigger/webhook-trigger.model.ts`, and the bulk-save
 * emission in `visual-programming/utils/save/payload.ts` (which always sends `webhook_trigger_path: ''`).
 */

import type { AuthorshipFields, NumberedNodeDto } from '../authorship.js';
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
 * `webhook_trigger` on a trigger node: the id of an existing `webhook-triggers/` row. The graph
 * API and bulk save both use a bare id; triggers themselves are created through `webhook-triggers/`.
 */
export type WebhookTriggerRef = number;

export interface WebhookTriggerNodeDto extends AuthorshipFields, NumberedNodeDto {
  id: number;
  created_at: string;
  node_name: string;
  graph: number;
  python_code: GetPythonCodeDto;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  webhook_trigger_path?: string;
  metadata: Record<string, unknown>;
  webhook_trigger: WebhookTriggerRef | null;
  /** Payload used by "Run with test payload"; a JSON object, `{}` when unset. */
  test_payload: Record<string, unknown>;
  /** Whether the code gets the flow's file storage (`epicstaff_storage`). */
  use_storage: boolean;
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
  test_payload: Record<string, unknown>;
  use_storage: boolean;
  metadata: NodeDtoMetadata;
}
