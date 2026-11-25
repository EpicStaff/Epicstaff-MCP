import type { ApiClient } from '../http/client.js';
import type { AuthorshipFields } from '../models/authorship.js';
import { type BulkDeleteResponse, bulkDeleteQuery } from './bulk-delete.js';
import { type Paginated, unwrap } from './paging.js';

/**
 * LLM stack API — ported from shared/services/llms/{llm-providers,llm-models,llm-config}.service.ts,
 * shared/services/embeddings/embedding-configs.service.ts and
 * features/configure-models/services/default-models.service.ts (`default-models/`).
 *
 * Configs are org-scoped and name-unique per org; models are a hybrid catalog (built-in models
 * plus the org's custom ones); providers are a global catalog only a superadmin may change.
 *
 * Since EpicStaff 1.6 a config keeps its generation settings in `parameters` and its endpoint
 * fields in `connection` (shared/models/llms/model-catalog.model.ts); the backend checks both
 * against its model catalog and refuses the old flat fields (temperature, base_url, …) by name.
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
  is_visible?: boolean;
  is_custom?: boolean;
}

export interface LlmConfig extends Partial<AuthorshipFields>, CatalogConfigFields {
  id: number;
  custom_name: string;
  model: number;
  is_visible?: boolean;
  api_key_secret_id?: number | null;
  [key: string]: unknown;
}

/** `CreateLLMConfigRequest` (shared/models/llms/llm-config.model.ts), the fields MCP sends. */
interface LlmConfigWriteFields {
  custom_name: string;
  /** Org Secret holding the provider API key (LLMConfigSerializer.api_key_secret_id). */
  api_key_secret_id?: number | null;
  /** Left out on create, the backend stores the model's defaults. */
  parameters?: Record<string, unknown>;
  connection?: Record<string, string>;
  timeout?: number | null;
  is_visible?: boolean;
  extra_headers?: Record<string, string>;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
}

export type CreateLlmConfigRequest = LlmConfigWriteFields & ConfigModelReference;
/** A PATCH body: any subset, the model named either way. */
export type UpdateLlmConfigRequest = Partial<LlmConfigWriteFields> & Partial<{ model: number; provider: string; model_name: string }>;

export interface EmbeddingModel {
  id: number;
  name: string;
  embedding_provider: number;
  is_visible?: boolean;
  is_custom?: boolean;
}

/** `CatalogConfigFields`: what a stored LLM or embedding config carries about its model. */
export interface CatalogConfigFields {
  /** Read-only: the provider row's name; null when the config has no model. */
  provider?: string | null;
  /** Read-only: the model row's name. */
  model_name?: string | null;
  /** The model's settings (temperature, max_tokens, …). A PATCH replaces the whole object. */
  parameters?: Record<string, unknown>;
  /** The provider's connection fields (base_url, api_version, …). A PATCH replaces the whole object. */
  connection?: Record<string, string>;
  /** Read-only: the model or settings no longer match the catalog. The config still runs. */
  needs_review?: boolean;
  review_reasons?: string[];
}

/** `ConfigModelReference`: a model row id, or the provider and model name (resolved by the backend). */
export type ConfigModelReference = { model: number } | { provider: string; model_name: string };

/** `GetEmbeddingConfigRequest` (shared/models/embeddings/embedding-config.model.ts). */
export interface EmbeddingConfig extends Partial<AuthorshipFields>, CatalogConfigFields {
  id: number;
  custom_name: string;
  model: number;
  api_key_secret_id?: number | null;
  is_visible?: boolean;
  extra_headers?: Record<string, string>;
  created_at?: string | null;
}

/** `CreateEmbeddingConfigRequest`. */
export interface CreateEmbeddingConfigRequest {
  custom_name: string;
  model: number;
  api_key_secret_id: number | null;
  parameters?: Record<string, unknown>;
  connection?: Record<string, string>;
  is_visible?: boolean;
  extra_headers?: Record<string, string>;
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

/** `UpdateDefaultModelsRequest`: any subset; a field left out keeps its value (DRF update). */
export type UpdateDefaultModelsRequest = Partial<DefaultModels>;

export class LlmApi {
  constructor(private readonly client: ApiClient) {}

  async listProviders(): Promise<LlmProvider[]> {
    return unwrap(await this.client.get<Paginated<LlmProvider> | LlmProvider[]>('providers/', { query: { limit: 1000 } }));
  }

  /**
   * One page of the model rows, filtered by the backend (LLMModelFilter): the catalog holds
   * thousands of models and a list request is capped at 1000 rows, so it is never loaded whole.
   */
  async searchModels(filter: { name?: string; nameContains?: string; providerId?: number; limit?: number }): Promise<Paginated<LlmModel>> {
    const response = await this.client.get<Paginated<LlmModel> | LlmModel[]>('llm-models/', {
      query: {
        limit: filter.limit ?? 1000,
        ...(filter.name !== undefined ? { name: filter.name } : {}),
        ...(filter.nameContains !== undefined ? { name__icontains: filter.nameContains } : {}),
        ...(filter.providerId !== undefined ? { llm_provider: filter.providerId } : {}),
      },
    });
    return Array.isArray(response) ? { count: response.length, results: response } : response;
  }

  /**
   * How a config write names the LLM model `modelName`. With a provider the backend resolves the
   * pair itself (aliases, provider-prefixed names, and a new custom model where the provider takes
   * them); without one the model row of that exact name is looked up, the first when providers share it.
   */
  async modelReference(modelName: string, provider: string | undefined): Promise<ConfigModelReference> {
    return provider !== undefined ? { provider, model_name: modelName } : { model: await this.findModelId(modelName) };
  }

  /** The id of the model row named exactly `modelName`; an unknown name is an actionable error. */
  async findModelId(modelName: string): Promise<number> {
    const row = (await this.searchModels({ name: modelName, limit: 1 })).results[0];
    if (row === undefined) {
      throw new Error(
        `LLM model "${modelName}" not found on the backend. Check the name with list_llm_models, ` +
          'or name its provider too (a provider that takes custom models then accepts a new model name).',
      );
    }
    return row.id;
  }

  async listConfigs(): Promise<LlmConfig[]> {
    return unwrap(await this.client.get<Paginated<LlmConfig> | LlmConfig[]>('llm-configs/', { query: { limit: 1000 } }));
  }

  async getConfig(id: number): Promise<LlmConfig> {
    return this.client.get<LlmConfig>(`llm-configs/${id}/`);
  }

  async createConfig(request: CreateLlmConfigRequest): Promise<LlmConfig> {
    return this.client.post('llm-configs/', { body: request });
  }

  /** PATCH, not the frontend's full PUT: only the fields the caller names change. */
  async updateConfig(id: number, request: UpdateLlmConfigRequest): Promise<LlmConfig> {
    return this.client.patch(`llm-configs/${id}/`, { body: request });
  }

  /** Configs are deleted for good (no recycle bin): references to it are cleared; skipped only when a referencing resource is hidden from the caller (BaseDeleteService). */
  async deleteConfigs(ids: number[], dryRun: boolean): Promise<BulkDeleteResponse> {
    return this.client.post('llm-configs/bulk-delete/', { body: { ids }, query: bulkDeleteQuery(dryRun) });
  }

  async getDefaultModels(): Promise<DefaultModels> {
    return this.client.get<DefaultModels>('default-models/');
  }

  /** Writing needs LLM-config update permission in the active org. */
  async updateDefaultModels(request: UpdateDefaultModelsRequest): Promise<DefaultModels> {
    return this.client.put<DefaultModels>('default-models/', { body: request });
  }

  async listEmbeddingModels(): Promise<EmbeddingModel[]> {
    return unwrap(
      await this.client.get<Paginated<EmbeddingModel> | EmbeddingModel[]>('embedding-models/', { query: { limit: 1000 } }),
    );
  }

  async listEmbeddingConfigs(): Promise<EmbeddingConfig[]> {
    return unwrap(
      await this.client.get<Paginated<EmbeddingConfig> | EmbeddingConfig[]>('embedding-configs/', {
        query: { limit: 1000 },
      }),
    );
  }

  async createEmbeddingConfig(request: CreateEmbeddingConfigRequest): Promise<EmbeddingConfig> {
    return this.client.post('embedding-configs/', { body: request });
  }

  /** PATCH, not the frontend's full PUT: only the fields the caller names change. */
  async updateEmbeddingConfig(id: number, request: Partial<CreateEmbeddingConfigRequest>): Promise<EmbeddingConfig> {
    return this.client.patch(`embedding-configs/${id}/`, { body: request });
  }

  /** Embedding configs are deleted for good: references to it are cleared; skipped only when a referencing resource is hidden from the caller (BaseDeleteService). */
  async deleteEmbeddingConfigs(ids: number[], dryRun: boolean): Promise<BulkDeleteResponse> {
    return this.client.post('embedding-configs/bulk-delete/', { body: { ids }, query: bulkDeleteQuery(dryRun) });
  }
}

/**
 * Index a model catalog by name for lookups from a model NAME (flow source and the config tools
 * know models by name; the wire wants an id). Both `<provider>/<model>` and the bare model name
 * are keys; the bare key goes to the first model of that name, the provider-qualified key wins on
 * a cross-provider name collision.
 */
export function buildModelIndex(
  models: Array<{ id: number; name: string; llm_provider?: number; embedding_provider?: number }>,
  providers: LlmProvider[],
): Map<string, number> {
  const providerName = new Map(providers.map((provider) => [provider.id, provider.name.toLowerCase()]));
  const index = new Map<string, number>();
  for (const model of models) {
    const key = model.name.toLowerCase();
    const providerId = model.llm_provider ?? model.embedding_provider;
    index.set(`${(providerId !== undefined ? providerName.get(providerId) : undefined) ?? ''}/${key}`, model.id);
    if (!index.has(key)) index.set(key, model.id);
  }
  return index;
}

/** Look a model up in a {@link buildModelIndex} index; an unknown name is an actionable error. */
export function lookupModelId(
  index: Map<string, number>,
  label: string,
  modelName: string,
  providerHint: string | undefined,
  listToolName: string,
): number {
  const id =
    (providerHint ? index.get(`${providerHint.toLowerCase()}/${modelName.toLowerCase()}`) : undefined) ??
    index.get(modelName.toLowerCase());
  if (id === undefined) {
    const available = [...index.keys()].filter((key) => !key.includes('/')).slice(0, 20).join(', ');
    throw new Error(
      `${label} "${modelName}" not found on the backend. Available models include: ${available}. ` +
        `Use ${listToolName} to see all options.`,
    );
  }
  return id;
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
  if (configs.length === 1) return configs[0]!.id;
  const available = configs
    .map((config) => config.custom_name)
    .filter(Boolean)
    .join(', ');
  throw new Error(
    'Cannot pick a default embedding config: the organization has several and no default embedding ' +
      `config is set (Settings → Default models). Name one explicitly: ${available}.`,
  );
}
