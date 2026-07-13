import type { EpicStaffClient } from '../http/client.js';

/**
 * LLM stack API — ported from shared/services/llms/{llm-providers,llm-models,llm-config}.service.ts.
 */
export interface LlmProvider {
  id: number;
  name: string;
  description?: string;
}

export interface LlmModel {
  id: number;
  name: string;
  llm_provider: number;
  base_url?: string | null;
  is_visible?: boolean;
  is_custom?: boolean;
}

export interface LlmConfig {
  id: number;
  custom_name: string;
  model: number;
  is_visible?: boolean;
  temperature?: number | null;
  [key: string]: unknown;
}

export interface CreateLlmConfigRequest {
  custom_name: string;
  model: number;
  api_key: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout?: number;
  is_visible?: boolean;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

/** Some list endpoints return arrays, others DRF pages — normalize both. */
function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class LlmApi {
  constructor(private readonly client: EpicStaffClient) {}

  async listProviders(): Promise<LlmProvider[]> {
    return unwrap(await this.client.get<Paginated<LlmProvider> | LlmProvider[]>('providers/', { query: { limit: 1000 } }));
  }

  async listModels(): Promise<LlmModel[]> {
    return unwrap(await this.client.get<Paginated<LlmModel> | LlmModel[]>('llm-models/', { query: { limit: 1000 } }));
  }

  async listConfigs(): Promise<LlmConfig[]> {
    return unwrap(await this.client.get<Paginated<LlmConfig> | LlmConfig[]>('llm-configs/', { query: { limit: 1000 } }));
  }

  async createConfig(request: CreateLlmConfigRequest): Promise<LlmConfig> {
    return this.client.post('llm-configs/', { body: request });
  }

  async updateConfig(id: number, request: Partial<CreateLlmConfigRequest>): Promise<LlmConfig> {
    return this.client.patch(`llm-configs/${id}/`, { body: request });
  }

  async getDefaultConfig(): Promise<LlmConfig | undefined> {
    return this.client.get<LlmConfig | undefined>('default-llm-config/').catch(() => undefined);
  }

  async listEmbeddingConfigs(): Promise<Array<Record<string, unknown>>> {
    return unwrap(
      await this.client.get<Paginated<Record<string, unknown>> | Array<Record<string, unknown>>>('embedding-configs/', {
        query: { limit: 1000 },
      }),
    );
  }
}
