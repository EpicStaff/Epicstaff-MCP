/** Ported from frontend `models/telegram-trigger.model.ts` + bulk-save emission in `utils/save/payload.ts`. */

import type { NodeDtoMetadata } from '../graph.js';
import type { WebhookTriggerModel } from './webhook-trigger-node.js';

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
  telegram_bot_api_key: string;
  fields: TelegramTriggerNodeFieldDto[];
  metadata: Record<string, unknown>;
  webhook_trigger: WebhookTriggerModel | null;
}

export interface TelegramTriggerNodeWrite {
  node_name: string;
  graph: number;
  telegram_bot_api_key: string;
  webhook_trigger: WebhookTriggerModel | null;
  fields: TelegramTriggerFieldWrite[];
  metadata: NodeDtoMetadata;
}
