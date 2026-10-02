import type { ApiClient } from '../http/client.js';

/**
 * LLM stack API — ported from shared/services/llms/{llm-providers,llm-models,llm-config}.service.ts
 * and features/configure-models/services/default-models.service.ts (`default-models/`).
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
  /** Org Secret holding the provider API key (LLMConfigSerializer.api_key_secret_id). */
  api_key_secret_id?: number | null;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout?: number;
  is_visible?: boolean;
}

/** `GET default-models/` — the active org's default model picks (DefaultModelsSerializer). */
export interface DefaultModels {
  agent_llm_config: number | null;
  agent_fcm_llm_config: number | null;
  voice_llm_config: number | null;
  transcription_llm_config: number | null;
  project_manager_llm_config: number | null;
  memory_embedding_config: number | null;
  memory_llm_config: number | null;
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
  constructor(private readonly client: ApiClient) {}

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

  async getDefaultModels(): Promise<DefaultModels> {
    return this.client.get<DefaultModels>('default-models/');
  }

  async listEmbeddingConfigs(): Promise<Array<Record<string, unknown>>> {
    return unwrap(
      await this.client.get<Paginated<Record<string, unknown>> | Array<Record<string, unknown>>>('embedding-configs/', {
        query: { limit: 1000 },
      }),
    );
  }
}

/**
 * Resolve "the org default embedder" to an embedding-config id: the org's default
 * embedding config (`default-models/` → `memory_embedding_config`) when set, else the
 * sole config. Errors when the choice is genuinely undecidable.
 */
export async function resolveDefaultEmbeddingConfigId(llm: LlmApi): Promise<number> {
  const [configs, defaults] = await Promise.all([llm.listEmbeddingConfigs(), llm.getDefaultModels()]);
  if (configs.length === 0) {
    throw new Error(
      'No embedding config exists in this organization — create one in EpicStaff settings ' +
        '(knowledge indexing needs an embedder).',
    );
  }
  const defaultId = defaults.memory_embedding_config;
  if (defaultId != null && configs.some((config) => config.id === defaultId)) {
    return defaultId;
  }
  if (configs.length === 1) return configs[0]!.id as number;
  const available = configs
    .map((config) => String(config.custom_name ?? config.name ?? ''))
    .filter(Boolean)
    .join(', ');
  throw new Error(
    'Cannot pick a default embedding config: the organization has several and no default embedding ' +
      `config is set (Settings → Default models). Name one explicitly: ${available}.`,
  );
}
