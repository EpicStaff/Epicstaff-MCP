import type { ApiClient } from '../http/client.js';
import type { AuthorshipFields, UserSummary } from '../models/authorship.js';
import { type BulkDeleteResponse, bulkDeleteQuery } from './bulk-delete.js';
import { type Paginated, unwrap } from './paging.js';

/**
 * Voice (realtime) model configuration API — ported from frontend
 * shared/services/realtime-llms/{openai,elevenlabs,gemini}-realtime-config.service.ts,
 * shared/services/realtime-llms/{real-time-models,real-time-model-config}.service.ts,
 * shared/services/transcription-llms/{transcription-models,transcription-config}.service.ts,
 * shared/services/realtime-voices.service.ts and the models in shared/models/realtime-voice/* and
 * shared/models/llms/transcription-config.model.ts.
 *
 * A voice agent talks through ONE provider-specific config (OpenAI, ElevenLabs or Gemini): org-scoped,
 * names not unique, the provider key held by an org Secret. The older `realtime-model-configs/` and
 * `realtime-transcription-model-configs/` rows are deprecated upstream (their models say so); they are
 * read here only because the org's default-model voice / transcription slots still point at them.
 */

export const VOICE_PROVIDERS = ['openai', 'elevenlabs', 'gemini'] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

/** Model a new config gets when none is named (realtime-config-form PROVIDERS = the backend field defaults). */
export const DEFAULT_VOICE_MODEL: Record<VoiceProvider, string> = {
  openai: 'gpt-realtime-1.5',
  elevenlabs: 'eleven_turbo_v2_5',
  gemini: 'gemini-3.1-flash-live-preview',
};

interface VoiceConfigBase extends Partial<AuthorshipFields> {
  id: number;
  custom_name: string;
  /** Org Secret holding the provider API key; a session with no key fails to start. */
  api_key_secret_id: number | null;
  model_name: string;
  org?: number | null;
  /** Null for configs created before the column existed. */
  created_at: string | null;
}

/** `OpenAIRealtimeConfig` (shared/models/realtime-voice/openai-realtime-config.model.ts). */
export interface OpenAIRealtimeConfig extends VoiceConfigBase {
  base_url: string | null;
  transcription_model_name: string | null;
  transcription_api_key_secret_id: number | null;
  voice_recognition_prompt: string | null;
}

/** `ElevenLabsRealtimeConfig` (elevenlabs-realtime-config.model.ts). */
export interface ElevenLabsRealtimeConfig extends VoiceConfigBase {
  language: string | null;
}

/** `GeminiRealtimeConfig` (gemini-realtime-config.model.ts). */
export interface GeminiRealtimeConfig extends VoiceConfigBase {
  voice_recognition_prompt: string | null;
}

export interface CreateOpenAIRealtimeConfigRequest {
  custom_name: string;
  api_key_secret_id?: number | null;
  model_name?: string;
  base_url?: string | null;
  transcription_model_name?: string | null;
  transcription_api_key_secret_id?: number | null;
  voice_recognition_prompt?: string | null;
}

export interface CreateElevenLabsRealtimeConfigRequest {
  custom_name: string;
  api_key_secret_id?: number | null;
  model_name?: string;
  language?: string | null;
}

export interface CreateGeminiRealtimeConfigRequest {
  custom_name: string;
  api_key_secret_id?: number | null;
  model_name?: string;
  voice_recognition_prompt?: string | null;
}

export interface VoiceConfigByProvider {
  openai: OpenAIRealtimeConfig;
  elevenlabs: ElevenLabsRealtimeConfig;
  gemini: GeminiRealtimeConfig;
}

export interface CreateVoiceConfigByProvider {
  openai: CreateOpenAIRealtimeConfigRequest;
  elevenlabs: CreateElevenLabsRealtimeConfigRequest;
  gemini: CreateGeminiRealtimeConfigRequest;
}

export type VoiceConfig = VoiceConfigByProvider[VoiceProvider];

/** Every field a config of any provider may carry — the union the tools build requests from. */
export type AnyVoiceConfigRequest = CreateOpenAIRealtimeConfigRequest &
  CreateElevenLabsRealtimeConfigRequest &
  CreateGeminiRealtimeConfigRequest;

const VOICE_CONFIG_PATHS: Record<VoiceProvider, string> = {
  openai: 'openai-realtime-configs/',
  elevenlabs: 'elevenlabs-realtime-configs/',
  gemini: 'gemini-realtime-configs/',
};

/**
 * `RealtimeModel` / `GetRealtimeTranscriptionModelRequest`: the hybrid model registry (built-in rows
 * plus the org's custom ones). An OpenAI voice config's `model_name` must name a registered OpenAI
 * realtime model (OpenAIRealtimeModelNameValidationMixin).
 */
export interface RealtimeModel {
  id: number;
  name: string;
  /** Provider id (`providers/`). */
  provider: number | null;
  is_custom: boolean;
  org?: number | null;
  created_by?: UserSummary | null;
}

export interface CreateRealtimeModelRequest {
  name: string;
  provider: number;
}

/** Deprecated `RealtimeModelConfig` (realtime-llm-config.model.ts) — the voice default-model slot's target. */
export interface LegacyRealtimeConfig {
  id: number;
  custom_name: string;
  api_key_secret_id: number | null;
  realtime_model: number;
  provider_name?: string;
}

/** Deprecated `GetTranscriptionConfigRequest` — the transcription default-model slot's target. */
export interface LegacyTranscriptionConfig {
  id: number;
  custom_name: string;
  api_key_secret_id: number | null;
  realtime_transcription_model: number;
}

export interface RealtimeVoice {
  id: string;
  name: string;
  description?: string;
}

/** `GET realtime-voices/`: the voices a provider offers (static; ElevenLabs voices are free-form ids). */
export type RealtimeVoicesMap = Record<string, RealtimeVoice[]>;

const LIST_QUERY = { limit: 1000 } as const;

export class VoiceConfigsApi {
  constructor(private readonly client: ApiClient) {}

  async listConfigs<P extends VoiceProvider>(provider: P): Promise<Array<VoiceConfigByProvider[P]>> {
    return unwrap(
      await this.client.get<Paginated<VoiceConfigByProvider[P]> | Array<VoiceConfigByProvider[P]>>(
        VOICE_CONFIG_PATHS[provider],
        { query: LIST_QUERY },
      ),
    );
  }

  async createConfig<P extends VoiceProvider>(
    provider: P,
    request: CreateVoiceConfigByProvider[P],
  ): Promise<VoiceConfigByProvider[P]> {
    return this.client.post(VOICE_CONFIG_PATHS[provider], { body: request });
  }

  /** PATCH, not the frontend's full PUT: only the fields the caller names change. */
  async updateConfig<P extends VoiceProvider>(
    provider: P,
    id: number,
    request: Partial<CreateVoiceConfigByProvider[P]>,
  ): Promise<VoiceConfigByProvider[P]> {
    return this.client.patch(`${VOICE_CONFIG_PATHS[provider]}${id}/`, { body: request });
  }

  /** Deleted for good (no recycle bin): references to it are cleared; skipped only when a referencing resource is hidden from the caller (BaseDeleteService). */
  async deleteConfigs(provider: VoiceProvider, ids: number[], dryRun: boolean): Promise<BulkDeleteResponse> {
    return this.client.post(`${VOICE_CONFIG_PATHS[provider]}bulk-delete/`, {
      body: { ids },
      query: bulkDeleteQuery(dryRun),
    });
  }

  async listRealtimeModels(): Promise<RealtimeModel[]> {
    return unwrap(await this.client.get<Paginated<RealtimeModel> | RealtimeModel[]>('realtime-models/', { query: LIST_QUERY }));
  }

  /** Registers an org custom model (`is_custom` is stamped by the backend). */
  async createRealtimeModel(request: CreateRealtimeModelRequest): Promise<RealtimeModel> {
    return this.client.post('realtime-models/', { body: request });
  }

  /** Only custom models can be deleted; built-in ones answer `built_in_model_immutable`. */
  async deleteRealtimeModel(id: number): Promise<void> {
    await this.client.delete<void>(`realtime-models/${id}/`);
  }

  async listTranscriptionModels(): Promise<RealtimeModel[]> {
    return unwrap(
      await this.client.get<Paginated<RealtimeModel> | RealtimeModel[]>('realtime-transcription-models/', {
        query: LIST_QUERY,
      }),
    );
  }

  async listLegacyRealtimeConfigs(): Promise<LegacyRealtimeConfig[]> {
    return unwrap(
      await this.client.get<Paginated<LegacyRealtimeConfig> | LegacyRealtimeConfig[]>('realtime-model-configs/', {
        query: LIST_QUERY,
      }),
    );
  }

  async listLegacyTranscriptionConfigs(): Promise<LegacyTranscriptionConfig[]> {
    return unwrap(
      await this.client.get<Paginated<LegacyTranscriptionConfig> | LegacyTranscriptionConfig[]>(
        'realtime-transcription-model-configs/',
        { query: LIST_QUERY },
      ),
    );
  }

  async getVoices(): Promise<RealtimeVoicesMap> {
    return this.client.get<RealtimeVoicesMap>('realtime-voices/');
  }
}
