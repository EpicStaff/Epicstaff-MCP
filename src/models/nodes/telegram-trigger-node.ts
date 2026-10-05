/** Ported from frontend `pages/flows-page/components/flow-visual-programming/models/telegram-trigger.model.ts` + bulk-save emission in `visual-programming/utils/save/payload.ts`. */

import type { NodeDtoMetadata } from '../graph.js';
import type { WebhookTriggerRef } from './webhook-trigger-node.js';

export type TelegramFieldParent = 'message' | 'callback_query';

export interface TelegramTriggerNodeFieldDto {
  id: number;
  parent: TelegramFieldParent;
  field_name: string;
  variable_path: string;
}

/**
 * Field entry sent at save time. The frontend forwards its node data as-is, so
 * previously-persisted entries may still carry their backend `id`.
 */
export interface TelegramTriggerFieldWrite {
  id?: number;
  parent: string;
  field_name: string;
  variable_path: string;
}

export interface TelegramTriggerNodeDto {
  id: number;
  node_name: string;
  graph: number;
  /** The bot token lives in an org Secret; the node only references it. */
  telegram_bot_api_key_secret_id: number | null;
  fields: TelegramTriggerNodeFieldDto[];
  metadata: Record<string, unknown>;
  webhook_trigger: WebhookTriggerRef | null;
}

export interface TelegramTriggerNodeWrite {
  node_name: string;
  graph: number;
  telegram_bot_api_key_secret_id: number | null;
  webhook_trigger: WebhookTriggerRef | null;
  fields: TelegramTriggerFieldWrite[];
  metadata: NodeDtoMetadata;
}
