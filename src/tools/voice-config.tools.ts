import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { LlmApi } from '../api/llm.js';
import { SecretsApi } from '../api/secrets.js';
import {
  type AnyVoiceConfigRequest,
  DEFAULT_VOICE_MODEL,
  type OpenAIRealtimeConfig,
  type RealtimeModel,
  VOICE_PROVIDERS,
  type VoiceConfig,
  VoiceConfigsApi,
  type VoiceProvider,
} from '../api/voice-configs.js';
import { credentialEnvName } from '../flow-source/schema/common.js';
import { runTool } from './auth-org.tools.js';
import { idOrName, pickDefined, resolveCredential, resolveNamedRef, summarizeAuthored } from './catalog-helpers.js';

/**
 * Voice model configuration: the provider-specific configs voice agents talk through (OpenAI,
 * ElevenLabs, Gemini realtime), the realtime model registry an OpenAI config's model must be in,
 * the provider voices, and — read-only — the deprecated realtime / transcription configs the
 * default-model voice slots still point at. Provider keys come from an environment variable of the
 * MCP server (`api_key_env`) or an existing org Secret (`api_key_secret`), never a tool argument.
 */

export const voiceProviderSchema = z
  .enum(VOICE_PROVIDERS)
  .describe('Voice provider: "openai" (OpenAI Realtime), "elevenlabs" or "gemini" (Gemini Live).');

const apiKeyEnvSchema = credentialEnvName(
  'Environment variable of the MCP server holding the provider API key, stored as the org Secret ' +
    '"es-mcp:<ENV>" (reused while it holds that value). The key never appears in a tool call.',
);
const apiKeySecretSchema = idOrName.describe('An existing org Secret (list_secrets) holding the provider API key: id or name.');

/** Optional fields that exist on only some providers (the three provider serializers' field lists). */
const providerFieldsShape = {
  base_url: z.string().url().nullable().optional().describe('openai only: custom API base URL (null = OpenAI).'),
  transcription_model_name: z
    .string()
    .max(250)
    .nullable()
    .optional()
    .describe('openai only: model that transcribes the caller (EpicStaff default "whisper-1").'),
  transcription_api_key_env: credentialEnvName(
    'openai only: environment variable holding the transcription API key (stored as an org Secret).',
  ).optional(),
  voice_recognition_prompt: z
    .string()
    .nullable()
    .optional()
    .describe('openai / gemini: hint that guides transcription, e.g. "Expect product names like Nimbus".'),
  language: z
    .string()
    .max(10)
    .nullable()
    .optional()
    .describe('elevenlabs only: ISO-639-1 language code, e.g. "en".'),
} as const;

const PROVIDER_ONLY_FIELDS: Record<string, readonly VoiceProvider[]> = {
  base_url: ['openai'],
  transcription_model_name: ['openai'],
  transcription_api_key_env: ['openai'],
  transcription_api_key_secret: ['openai'],
  voice_recognition_prompt: ['openai', 'gemini'],
  language: ['elevenlabs'],
};

/** Refuse a field the provider's config does not have, instead of letting the backend drop it silently. */
function assertProviderFields(provider: VoiceProvider, fields: Record<string, unknown>): void {
  const misplaced: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const owners = PROVIDER_ONLY_FIELDS[key];
    if (value !== undefined && owners !== undefined && !owners.includes(provider)) {
      misplaced.push(`${key} (${owners.join(' / ')} only)`);
    }
  }
  if (misplaced.length > 0) {
    throw new Error(`A ${provider} voice config has no ${misplaced.join(', ')}. Drop those fields.`);
  }
}

export function registerVoiceConfigTools(server: McpServer, context: AppContext): void {
  const voice = new VoiceConfigsApi(context.client);
  const llm = new LlmApi(context.client);
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const secrets = (): SecretsApi => new SecretsApi(context.client, context.auth);

  const resolveVoiceConfig = (provider: VoiceProvider, ref: number | string): Promise<number> =>
    resolveNamedRef(
      ref,
      `${provider} voice config`,
      () => voice.listConfigs(provider),
      (config) => config.id,
      (config) => config.custom_name,
    );

  const transcriptionKeyNames = { env: 'transcription_api_key_env', secret: 'transcription_api_key_secret' };

  // ----- Voice configs ----------------------------------------------------------

  server.registerTool(
    'list_voice_configs',
    {
      title: 'List voice configs',
      description:
        'List the org\'s voice configs — the OpenAI / ElevenLabs / Gemini realtime configs an agent\'s voice settings ' +
        'use (set_agent_voice). include_models adds the realtime model registry (an OpenAI config\'s model must be ' +
        'in it), include_voices the voices each provider offers, include_legacy the deprecated realtime / ' +
        'transcription configs the default-model voice slots point at.',
      inputSchema: {
        provider: voiceProviderSchema.optional().describe('Only this provider\'s configs.'),
        include_models: z.boolean().default(false).describe('Also list the realtime and transcription model registry.'),
        include_voices: z.boolean().default(false).describe('Also list the voices of each provider.'),
        include_legacy: z.boolean().default(false).describe('Also list the deprecated realtime / transcription configs.'),
      },
    },
    async ({ provider, include_models, include_voices, include_legacy }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const providers = provider ? [provider] : [...VOICE_PROVIDERS];
        const perProvider = await Promise.all(providers.map((key) => voice.listConfigs(key)));
        const result: Record<string, unknown> = {
          configs: providers.flatMap((key, index) => (perProvider[index] ?? []).map((config) => describeVoiceConfig(key, config))),
        };
        if (include_models) {
          const [realtimeModels, transcriptionModels, llmProviders] = await Promise.all([
            voice.listRealtimeModels(),
            voice.listTranscriptionModels(),
            llm.listProviders(),
          ]);
          const providerName = new Map(llmProviders.map((entry) => [entry.id, entry.name]));
          const describeModel = (model: RealtimeModel) => ({
            id: model.id,
            name: model.name,
            provider: model.provider === null ? null : (providerName.get(model.provider) ?? model.provider),
            is_custom: model.is_custom,
          });
          result.models = {
            realtime: realtimeModels.map(describeModel),
            transcription: transcriptionModels.map(describeModel),
            defaults: DEFAULT_VOICE_MODEL,
          };
        }
        if (include_voices) {
          const voices = await voice.getVoices();
          result.voices = {
            elevenlabs: 'free-form ElevenLabs voice id (from your ElevenLabs voice library)',
            ...Object.fromEntries(Object.entries(voices).map(([key, list]) => [key, list.map((entry) => entry.id)])),
          };
        }
        if (include_legacy) {
          const [realtimeConfigs, transcriptionConfigs] = await Promise.all([
            voice.listLegacyRealtimeConfigs(),
            voice.listLegacyTranscriptionConfigs(),
          ]);
          result.legacy = {
            note:
              'Deprecated upstream: only the default-model voice_llm_config / transcription_llm_config slots ' +
              '(update_default_models) point at these; voice agents use the configs above.',
            realtime_configs: realtimeConfigs.map((config) => ({
              id: config.id,
              name: config.custom_name,
              model: config.realtime_model,
              provider: config.provider_name ?? null,
              has_api_key: config.api_key_secret_id != null,
            })),
            transcription_configs: transcriptionConfigs.map((config) => ({
              id: config.id,
              name: config.custom_name,
              model: config.realtime_transcription_model,
              has_api_key: config.api_key_secret_id != null,
            })),
          };
        }
        return result;
      }),
  );

  server.registerTool(
    'create_voice_config',
    {
      title: 'Create a voice config',
      description:
        'Create a voice config for one provider (what an agent\'s voice settings talk through). The provider key ' +
        'comes from api_key_env (env var of the MCP server) or api_key_secret (existing org secret) — a config ' +
        'without a key cannot start a session. model_name defaults per provider (list_voice_configs include_models); ' +
        'an OpenAI model_name must be in the realtime model registry (create_voice_model adds one). Names are not ' +
        'unique — a second config with the same name is created, with a warning.',
      inputSchema: {
        provider: voiceProviderSchema,
        name: z.string().min(1).max(250).describe('Config name (custom_name).'),
        model_name: z.string().min(1).max(250).optional().describe('Realtime model; provider default when omitted.'),
        api_key_env: apiKeyEnvSchema.optional(),
        api_key_secret: apiKeySecretSchema.optional(),
        transcription_api_key_secret: idOrName
          .optional()
          .describe('openai only: existing org secret (id or name) holding the transcription API key.'),
        ...providerFieldsShape,
      },
    },
    async ({ provider, name, model_name, api_key_env, api_key_secret, transcription_api_key_env, transcription_api_key_secret, ...fields }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        assertProviderFields(provider, { ...fields, transcription_api_key_env, transcription_api_key_secret });
        const sameName = (await voice.listConfigs(provider)).filter(
          (config) => config.custom_name.toLowerCase() === name.trim().toLowerCase(),
        );
        const apiKeySecretId = await resolveCredential(secrets, api_key_env, api_key_secret);
        const transcriptionKeySecretId = await resolveCredential(
          secrets,
          transcription_api_key_env,
          transcription_api_key_secret,
          transcriptionKeyNames,
        );
        const request: AnyVoiceConfigRequest = {
          custom_name: name,
          api_key_secret_id: apiKeySecretId ?? null,
          ...(model_name !== undefined ? { model_name } : {}),
          ...(transcriptionKeySecretId !== undefined ? { transcription_api_key_secret_id: transcriptionKeySecretId } : {}),
          ...pickDefined(fields),
        };
        const created = await voice.createConfig(provider, request);
        const warnings: string[] = [];
        if (sameName.length > 0) {
          warnings.push(
            `Another ${provider} voice config already has this name (id ${sameName.map((config) => config.id).join(', ')}); ` +
              `refer to this one by id ${created.id}.`,
          );
        }
        if (created.api_key_secret_id == null) {
          warnings.push('No API key: voice sessions with this config fail until one is set (update_voice_config api_key_env).');
        }
        return {
          config: { provider, ...summarizeAuthored(created) },
          ...(warnings.length > 0 ? { warnings } : {}),
          next: `Give an agent this voice with set_agent_voice(agent, provider: "${provider}", config: ${created.id}).`,
        };
      }),
  );

  server.registerTool(
    'update_voice_config',
    {
      title: 'Update a voice config',
      description:
        'Change a voice config (PATCH — only the fields you pass change; null clears an optional field). Every ' +
        'agent whose voice settings use it picks the change up on its next session.',
      inputSchema: {
        provider: voiceProviderSchema,
        config: idOrName.describe('The config: backend id or exact name (list_voice_configs).'),
        name: z.string().min(1).max(250).optional().describe('New name.'),
        model_name: z.string().min(1).max(250).optional(),
        api_key_env: apiKeyEnvSchema.optional(),
        api_key_secret: apiKeySecretSchema.nullable().optional().describe('Existing secret (id or name); null removes the key.'),
        transcription_api_key_secret: idOrName
          .nullable()
          .optional()
          .describe('openai only: existing secret (id or name) for transcription; null removes it.'),
        ...providerFieldsShape,
      },
    },
    async ({
      provider,
      config,
      name,
      model_name,
      api_key_env,
      api_key_secret,
      transcription_api_key_env,
      transcription_api_key_secret,
      ...fields
    }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        assertProviderFields(provider, { ...fields, transcription_api_key_env, transcription_api_key_secret });
        const configId = await resolveVoiceConfig(provider, config);
        const apiKeySecretId = await resolveCredential(secrets, api_key_env, api_key_secret);
        const transcriptionKeySecretId = await resolveCredential(
          secrets,
          transcription_api_key_env,
          transcription_api_key_secret,
          transcriptionKeyNames,
        );
        const request: Partial<AnyVoiceConfigRequest> = {
          ...(name !== undefined ? { custom_name: name } : {}),
          ...(model_name !== undefined ? { model_name } : {}),
          ...(apiKeySecretId !== undefined ? { api_key_secret_id: apiKeySecretId } : {}),
          ...(transcriptionKeySecretId !== undefined ? { transcription_api_key_secret_id: transcriptionKeySecretId } : {}),
          ...pickDefined(fields),
        };
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass at least one field.');
        return { config: { provider, ...summarizeAuthored(await voice.updateConfig(provider, configId, request)) } };
      }),
  );

  server.registerTool(
    'delete_voice_config',
    {
      title: 'Delete a voice config',
      description:
        'Delete a voice config FOR GOOD (no recycle bin). Agents whose voice settings use it have their voice ' +
        'switched off (the config is cleared from their settings) — dry_run: true lists those agents first. It is ' +
        'skipped, not deleted, only when an agent you cannot see uses it (in_use_restricted). Past voice chats keep ' +
        'their history.',
      inputSchema: {
        provider: voiceProviderSchema,
        config: idOrName.describe('The config: backend id or exact name.'),
        dry_run: z.boolean().default(false).describe('Report what would happen (and the usage) without deleting.'),
      },
    },
    async ({ provider, config, dry_run }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return voice.deleteConfigs(provider, [await resolveVoiceConfig(provider, config)], dry_run);
      }),
  );

  // ----- Realtime model registry ----------------------------------------------------

  server.registerTool(
    'create_voice_model',
    {
      title: 'Register a custom realtime model',
      description:
        'Add an org custom model to the realtime model registry — needed before an OpenAI voice config can use a ' +
        'model the built-in registry lacks (list_voice_configs include_models shows it). The model name must be ' +
        'one the provider actually serves; EpicStaff does not check that.',
      inputSchema: {
        provider: voiceProviderSchema,
        name: z.string().min(1).max(250).describe('Exact model name the provider serves, e.g. "gpt-realtime".'),
      },
    },
    async ({ provider, name }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const providerId = await resolveProviderId(llm, provider);
        const created = await voice.createRealtimeModel({ name: name.trim(), provider: providerId });
        return {
          model: { id: created.id, name: created.name, provider, is_custom: created.is_custom },
          next: `Use it with create_voice_config(provider: "${provider}", model_name: "${created.name}", …).`,
        };
      }),
  );

  server.registerTool(
    'delete_voice_model',
    {
      title: 'Delete a custom realtime model',
      description:
        'Delete an org custom model from the realtime model registry for good. Built-in models cannot be deleted. ' +
        'Existing voice configs keep their model_name; a new or changed OpenAI config can no longer name it.',
      inputSchema: {
        model: idOrName.describe('The custom model: backend id or exact name (list_voice_configs include_models).'),
        provider: voiceProviderSchema.optional().describe('Provider, to disambiguate a name several providers share.'),
      },
    },
    async ({ model, provider }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const providerId = provider === undefined ? undefined : await resolveProviderId(llm, provider);
        const modelId = await resolveNamedRef(
          model,
          'Custom realtime model',
          async () =>
            (await voice.listRealtimeModels()).filter(
              (entry) => entry.is_custom && (providerId === undefined || entry.provider === providerId),
            ),
          (entry) => entry.id,
          (entry) => entry.name,
        );
        await voice.deleteRealtimeModel(modelId);
        return { deleted: { id: modelId } };
      }),
  );
}

/** A voice config as list output: the provider-specific fields, secrets only as presence flags. */
function describeVoiceConfig(provider: VoiceProvider, config: VoiceConfig): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    provider,
    id: config.id,
    name: config.custom_name,
    model_name: config.model_name,
    has_api_key: config.api_key_secret_id != null,
  };
  if (provider === 'openai') {
    const openai = config as OpenAIRealtimeConfig;
    summary.base_url = openai.base_url;
    summary.transcription_model_name = openai.transcription_model_name;
    summary.has_transcription_api_key = openai.transcription_api_key_secret_id != null;
  }
  if ('voice_recognition_prompt' in config) summary.voice_recognition_prompt = config.voice_recognition_prompt;
  if ('language' in config) summary.language = config.language;
  return summary;
}

/** The `providers/` id of a voice provider (the registry rows reference providers by id). */
async function resolveProviderId(llm: LlmApi, provider: VoiceProvider): Promise<number> {
  const match = (await llm.listProviders()).find((entry) => entry.name.toLowerCase() === provider);
  if (match === undefined) throw new Error(`Provider "${provider}" is not registered on this EpicStaff deployment.`);
  return match.id;
}
