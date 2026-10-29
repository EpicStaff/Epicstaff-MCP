import type { ApiClient } from '../http/client.js';
import type { DefaultModels, EmbeddingConfig, LlmConfig } from './llm.js';

/**
 * Quickstart API — ported from features/configure-models/services/quickstart.service.ts and
 * models/quickstart.model.ts. Backend: QuickstartView / QuickstartApplyView (tables/views/views.py).
 *
 * A quickstart takes one provider credential and creates a ready-to-use LLM config and
 * embedding config for that provider; "apply" then makes them the org's default models.
 *
 * Divergence: the frontend posts the raw `api_key`. MCP never handles a raw key here — the caller's
 * environment value is stored as an org Secret first and passed by id (`api_key_secret_id`, which
 * QuickstartSerializer accepts as the alternative credential form).
 */
export interface QuickstartConfig {
  config_name: string;
  llm_config: LlmConfig | null;
  embedding_config: EmbeddingConfig | null;
}

export interface GetQuickstartResponse {
  supported_providers: string[];
  last_config: QuickstartConfig | null;
  /** Whether the org's default models still point at the last quickstart's configs. */
  is_synced: boolean;
}

export interface CreateQuickstartRequest {
  provider: string;
  api_key_secret_id: number;
}

export interface CreateQuickstartResponse {
  config_name: string;
  configs: QuickstartConfig;
  detail: string;
}

export class QuickstartApi {
  constructor(private readonly client: ApiClient) {}

  async getStatus(): Promise<GetQuickstartResponse> {
    return this.client.get<GetQuickstartResponse>('quickstart/');
  }

  async create(request: CreateQuickstartRequest): Promise<CreateQuickstartResponse> {
    return this.client.post<CreateQuickstartResponse>('quickstart/', { body: request });
  }

  /** Point the org's default models at the most recent quickstart's configs. */
  async apply(): Promise<DefaultModels> {
    return this.client.post<DefaultModels>('quickstart/apply/', { body: {} });
  }
}
