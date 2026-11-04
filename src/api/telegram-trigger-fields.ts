import type { ApiClient } from '../http/client.js';

/**
 * The Telegram update fields a Telegram trigger node can select — backend-derived from
 * `src/django_app/tables/views/views.py` (TelegramTriggerNodeAvailableFieldsView →
 * tables/utils/data/telegram_fields.json). The editor bundles its own copy of the list
 * (visual-programming/core/constants/telegram-trigger-fields.ts); MCP reads the backend's, which is
 * what the test-run validation (TelegramTriggerTestRunStrategy) checks a payload against.
 */
export interface TelegramTriggerField {
  field_name: string;
  /** Telegram Bot API type, e.g. `String`, `Integer`, `User`, `Array[MessageEntity]`. */
  field_type: string;
  description: string;
}

/** Field lists keyed by parent (`message`, `callback_query`). */
export type TelegramTriggerFieldsByParent = Record<string, TelegramTriggerField[]>;

export class TelegramTriggerFieldsApi {
  constructor(private readonly client: ApiClient) {}

  async list(): Promise<TelegramTriggerFieldsByParent> {
    const response = await this.client.get<{ data: TelegramTriggerFieldsByParent }>('telegram-trigger-available-fields/');
    return response.data;
  }
}
