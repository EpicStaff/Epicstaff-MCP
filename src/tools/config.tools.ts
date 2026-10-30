import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ExecutionTimeoutLimitsApi } from '../api/execution-timeout-limits.js';
import {
  type CreateEmbeddingConfigRequest,
  type CreateLlmConfigRequest,
  type DefaultModels,
  LlmApi,
  buildModelIndex,
  lookupModelId,
} from '../api/llm.js';
import { QuickstartApi } from '../api/quickstart.js';
import { RecycleBinApi } from '../api/recycle-bin.js';
import { SecretsApi } from '../api/secrets.js';
import { VoiceConfigsApi } from '../api/voice-configs.js';
import { credentialEnvName } from '../flow-source/schema/common.js';
import { runTool } from './auth-org.tools.js';
import {
  createOrExplainConflict,
  idOrName,
  pickDefined,
  resolveCredential,
  resolveNamedRef,
  summarizeAuthored,
} from './catalog-helpers.js';

/**
 * Model configuration: LLM configs, embedding configs, the org's default models, deployment
 * settings and the provider quickstart. Credentials are never tool arguments: a provider key comes
 * from an environment variable of the MCP server (`api_key_env`, stored as the org Secret
 * `es-mcp:<ENV>`) or from an existing org Secret (`api_key_secret`).
 */

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const apiKeyEnvSchema = credentialEnvName(
  'Environment variable of the MCP server holding the provider API key. Stored as the org Secret ' +
    '"es-mcp:<ENV>" (reused when it already holds that value); the key itself never appears in a tool call.',
);

const apiKeySecretSchema = idOrName.describe('An existing org Secret (list_secrets) holding the provider API key: id or name.');

/** Generation settings of an LLM config (CreateLLMConfigRequest), bounded like the backend model. */
const llmConfigFieldsShape = {
  temperature: z.number().min(0).max(2).nullable().optional().describe('Sampling temperature, 0–2.'),
  max_tokens: z.number().int().min(500).nullable().optional().describe('Max output tokens (backend minimum 500).'),
  top_p: z.number().min(0).max(1).nullable().optional(),
  timeout: z.number().positive().nullable().optional().describe('Request timeout in seconds.'),
  seed: z.number().int().nullable().optional(),
  stop: z.array(z.string()).nullable().optional().describe('Stop sequences.'),
  presence_penalty: z.number().nullable().optional(),
  frequency_penalty: z.number().nullable().optional(),
  reasoning_effort: z
    .enum(REASONING_EFFORTS)
    .nullable()
    .optional()
    .describe('Reasoning effort for models that support it (the backend refuses levels the model lacks).'),
  input_cost_per_token: z.number().min(0).nullable().optional().describe('USD per prompt token; set with output_cost_per_token.'),
  output_cost_per_token: z.number().min(0).nullable().optional().describe('USD per completion token; set with input_cost_per_token.'),
  extra_headers: z.record(z.string(), z.string()).optional().describe('Extra HTTP headers sent to the provider.'),
  is_visible: z.boolean().optional().describe('Whether the config is offered in pickers.'),
} as const;

/** The default-model slots that take an LLM config. */
const DEFAULT_MODEL_LLM_SLOTS = ['agent_llm_config', 'agent_fcm_llm_config', 'project_manager_llm_config', 'memory_llm_config'] as const;

export function registerConfigTools(server: McpServer, context: AppContext): void {
  const llm = new LlmApi(context.client);
  const quickstart = new QuickstartApi(context.client);
  const timeoutLimits = new ExecutionTimeoutLimitsApi(context.client);
  const voice = new VoiceConfigsApi(context.client);
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const secrets = (): SecretsApi => new SecretsApi(context.client, context.auth);

  const resolveLlmConfig = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'LLM config', () => llm.listConfigs(), (config) => config.id, (config) => config.custom_name);
  const resolveEmbeddingConfig = (ref: number | string): Promise<number> =>
    resolveNamedRef(
      ref,
      'Embedding config',
      () => llm.listEmbeddingConfigs(),
      (config) => config.id,
      (config) => config.custom_name,
    );

  async function resolveLlmModel(ref: number | string, provider: string | undefined): Promise<number> {
    if (typeof ref === 'number') return ref;
    const index = buildModelIndex(...(await Promise.all([llm.listModels(), llm.listProviders()])));
    return lookupModelId(index, 'LLM model', ref, provider, 'list_llm_models');
  }

  async function resolveEmbeddingModel(ref: number | string, provider: string | undefined): Promise<number> {
    if (typeof ref === 'number') return ref;
    const index = buildModelIndex(...(await Promise.all([llm.listEmbeddingModels(), llm.listProviders()])));
    return lookupModelId(index, 'Embedding model', ref, provider, 'list_embedding_configs (models)');
  }

  const resolveLegacyVoiceConfig = (ref: number | string): Promise<number> =>
    resolveNamedRef(
      ref,
      'Legacy realtime config',
      () => voice.listLegacyRealtimeConfigs(),
      (config) => config.id,
      (config) => config.custom_name,
    );
  const resolveLegacyTranscriptionConfig = (ref: number | string): Promise<number> =>
    resolveNamedRef(
      ref,
      'Legacy transcription config',
      () => voice.listLegacyTranscriptionConfigs(),
      (config) => config.id,
      (config) => config.custom_name,
    );

  /** `api_key_secret_id` for the api_key_env / api_key_secret pair (see {@link resolveCredential}). */
  const resolveApiKey = (
    apiKeyEnv: string | undefined,
    apiKeySecret: number | string | null | undefined,
  ): Promise<number | null | undefined> => resolveCredential(secrets, apiKeyEnv, apiKeySecret);

  // ----- LLM configs ---------------------------------------------------------

  server.registerTool(
    'create_llm_config',
    {
      title: 'Create an LLM config',
      description:
        'Create an org LLM config (a model + its generation settings + the provider key) that agents and ' +
        'classification tables reference by name. Names are org-unique; on a clash use update_llm_config. ' +
        'The key comes from api_key_env (an env var of the MCP server) or api_key_secret (an existing org secret).',
      inputSchema: {
        name: z.string().min(1).describe('Org-unique config name (custom_name) — the handle flows reference.'),
        model: idOrName.describe('LLM model: backend id or exact model name (list_llm_models).'),
        provider: z.string().optional().describe('Provider name to disambiguate a model name several providers share.'),
        api_key_env: apiKeyEnvSchema.optional(),
        api_key_secret: apiKeySecretSchema.optional(),
        ...llmConfigFieldsShape,
      },
    },
    async ({ name, model, provider, api_key_env, api_key_secret, ...fields }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const request: CreateLlmConfigRequest = {
          custom_name: name,
          model: await resolveLlmModel(model, provider),
          api_key_secret_id: (await resolveApiKey(api_key_env, api_key_secret)) ?? null,
          ...pickDefined(fields),
        };
        const created = await createOrExplainConflict(() => llm.createConfig(request), name, 'update_llm_config');
        return {
          config: summarizeAuthored(created),
          next: `Reference it from flow source with llm_config: { existing: "${name}" }, or make it an org default with update_default_models.`,
        };
      }),
  );

  server.registerTool(
    'update_llm_config',
    {
      title: 'Update an LLM config',
      description:
        'Change an LLM config (PATCH — only the fields you pass change; null clears a setting). Every agent and ' +
        'flow using it picks the change up on its next run.',
      inputSchema: {
        config: idOrName.describe('The config to update: backend id or exact name (list_llm_configs).'),
        name: z.string().min(1).optional().describe('New name.'),
        model: idOrName.optional().describe('New model: id or exact model name.'),
        provider: z.string().optional().describe('Provider hint for a model name.'),
        api_key_env: apiKeyEnvSchema.optional(),
        api_key_secret: apiKeySecretSchema.nullable().optional().describe('Existing secret (id or name); null removes the key.'),
        ...llmConfigFieldsShape,
      },
    },
    async ({ config, name, model, provider, api_key_env, api_key_secret, ...fields }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const configId = await resolveLlmConfig(config);
        const credential = await resolveApiKey(api_key_env, api_key_secret);
        const request: Partial<CreateLlmConfigRequest> = {
          ...(name !== undefined ? { custom_name: name } : {}),
          ...(model !== undefined ? { model: await resolveLlmModel(model, provider) } : {}),
          ...(credential !== undefined ? { api_key_secret_id: credential } : {}),
          ...pickDefined(fields),
        };
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass at least one field.');
        return { config: summarizeAuthored(await llm.updateConfig(configId, request)) };
      }),
  );

  server.registerTool(
    'delete_llm_config',
    {
      title: 'Delete an LLM config',
      description:
        'Delete an LLM config FOR GOOD (configs have no recycle bin). Agents, flows and collections that use it ' +
        'lose it (their reference is cleared), and so does an org default model slot — dry_run: true lists that ' +
        'usage first. It is skipped, not deleted, only when something you cannot see uses it (in_use_restricted) or ' +
        'a database guard refuses (protected).',
      inputSchema: {
        config: idOrName.describe('The config: backend id or exact name.'),
        dry_run: z.boolean().default(false).describe('Report what would happen (and the usage) without deleting.'),
      },
    },
    async ({ config, dry_run }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return llm.deleteConfigs([await resolveLlmConfig(config)], dry_run);
      }),
  );

  // ----- Embedding configs -----------------------------------------------------

  server.registerTool(
    'list_embedding_configs',
    {
      title: 'List embedding configs and models',
      description:
        'List the org\'s embedding configs (what knowledge collections index with) and which one is the org default; ' +
        'with include_models, also the embedding models a new config can use.',
      inputSchema: {
        include_models: z.boolean().default(false).describe('Also list the available embedding models.'),
      },
    },
    async ({ include_models }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const [configs, defaults] = await Promise.all([llm.listEmbeddingConfigs(), llm.getDefaultModels()]);
        const result: Record<string, unknown> = {
          default: defaults.memory_embedding_config,
          configs: configs.map((config) => ({
            id: config.id,
            custom_name: config.custom_name,
            model: config.model,
            has_api_key: config.api_key_secret_id != null,
          })),
        };
        if (include_models) {
          const [models, providers] = await Promise.all([llm.listEmbeddingModels(), llm.listProviders()]);
          const providerName = new Map(providers.map((provider) => [provider.id, provider.name]));
          result.models = models.map((model) => ({
            id: model.id,
            name: model.name,
            provider: providerName.get(model.embedding_provider) ?? model.embedding_provider,
          }));
        }
        return result;
      }),
  );

  server.registerTool(
    'create_embedding_config',
    {
      title: 'Create an embedding config',
      description:
        'Create an org embedding config (an embedding model + the provider key) for knowledge collections to index ' +
        'with. Names are org-unique. Make it the org default with update_default_models(memory_embedding_config).',
      inputSchema: {
        name: z.string().min(1).describe('Org-unique config name.'),
        model: idOrName.describe('Embedding model: backend id or exact name (list_embedding_configs include_models).'),
        provider: z.string().optional().describe('Provider hint for a model name.'),
        api_key_env: apiKeyEnvSchema.optional(),
        api_key_secret: apiKeySecretSchema.optional(),
        extra_headers: z.record(z.string(), z.string()).optional(),
        is_visible: z.boolean().optional(),
      },
    },
    async ({ name, model, provider, api_key_env, api_key_secret, extra_headers, is_visible }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const request: CreateEmbeddingConfigRequest = {
          custom_name: name,
          model: await resolveEmbeddingModel(model, provider),
          api_key_secret_id: (await resolveApiKey(api_key_env, api_key_secret)) ?? null,
          ...(extra_headers !== undefined ? { extra_headers } : {}),
          ...(is_visible !== undefined ? { is_visible } : {}),
        };
        const created = await createOrExplainConflict(
          () => llm.createEmbeddingConfig(request),
          name,
          'update_embedding_config',
        );
        return { config: summarizeAuthored(created) };
      }),
  );

  server.registerTool(
    'update_embedding_config',
    {
      title: 'Update an embedding config',
      description:
        'Change an embedding config (PATCH — only the fields you pass change). Changing the model of a config whose ' +
        'collections are already indexed leaves their old vectors in place — re-index them.',
      inputSchema: {
        config: idOrName.describe('The config: backend id or exact name.'),
        name: z.string().min(1).optional(),
        model: idOrName.optional(),
        provider: z.string().optional(),
        api_key_env: apiKeyEnvSchema.optional(),
        api_key_secret: apiKeySecretSchema.nullable().optional().describe('Existing secret (id or name); null removes the key.'),
        extra_headers: z.record(z.string(), z.string()).optional(),
        is_visible: z.boolean().optional(),
      },
    },
    async ({ config, name, model, provider, api_key_env, api_key_secret, extra_headers, is_visible }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const configId = await resolveEmbeddingConfig(config);
        const credential = await resolveApiKey(api_key_env, api_key_secret);
        const request: Partial<CreateEmbeddingConfigRequest> = {
          ...(name !== undefined ? { custom_name: name } : {}),
          ...(model !== undefined ? { model: await resolveEmbeddingModel(model, provider) } : {}),
          ...(credential !== undefined ? { api_key_secret_id: credential } : {}),
          ...(extra_headers !== undefined ? { extra_headers } : {}),
          ...(is_visible !== undefined ? { is_visible } : {}),
        };
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass at least one field.');
        return { config: summarizeAuthored(await llm.updateEmbeddingConfig(configId, request)) };
      }),
  );

  server.registerTool(
    'delete_embedding_config',
    {
      title: 'Delete an embedding config',
      description:
        'Delete an embedding config FOR GOOD (no recycle bin). Collections indexing with it and the org default ' +
        'embedder lose it (their reference is cleared; re-index those collections with another embedder) — dry_run: ' +
        'true lists that usage first. It is skipped only when a collection you cannot see uses it (in_use_restricted) ' +
        'or a database guard refuses (protected).',
      inputSchema: {
        config: idOrName.describe('The config: backend id or exact name.'),
        dry_run: z.boolean().default(false),
      },
    },
    async ({ config, dry_run }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        return llm.deleteEmbeddingConfigs([await resolveEmbeddingConfig(config)], dry_run);
      }),
  );

  // ----- Defaults / settings / quickstart --------------------------------------

  server.registerTool(
    'get_settings',
    {
      title: 'Get model defaults and platform settings',
      description:
        'The org\'s default models (what agents and memory use when nothing else is set), the deployment\'s python ' +
        'execution-timeout bounds, the recycle-bin retention and the provider quickstart status.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const [defaults, configs, embeddingConfigs, limits, binSettings, quickstartStatus] = await Promise.all([
          llm.getDefaultModels(),
          llm.listConfigs(),
          llm.listEmbeddingConfigs(),
          timeoutLimits.get(),
          new RecycleBinApi(context.client, context.auth).getSettings(),
          // Needs LLM-config read in the org and answers 500 on an internal failure — never let it
          // hide the rest of the settings.
          quickstart.getStatus().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
        ]);
        // The legacy voice / transcription lists are read only when their slot is set.
        const [legacyVoiceConfigs, legacyTranscriptionConfigs] = await Promise.all([
          defaults.voice_llm_config === null ? [] : voice.listLegacyRealtimeConfigs(),
          defaults.transcription_llm_config === null ? [] : voice.listLegacyTranscriptionConfigs(),
        ]);
        const nameMap = (rows: Array<{ id: number; custom_name: string }>) =>
          new Map(rows.map((row) => [row.id, row.custom_name]));
        const configName = nameMap(configs);
        const named = (id: number | null, names: Map<number, string>) =>
          id === null ? null : { id, name: names.get(id) ?? null };
        return {
          default_models: {
            ...Object.fromEntries(DEFAULT_MODEL_LLM_SLOTS.map((slot) => [slot, named(defaults[slot], configName)])),
            memory_embedding_config: named(defaults.memory_embedding_config, nameMap(embeddingConfigs)),
            voice_llm_config: named(defaults.voice_llm_config, nameMap(legacyVoiceConfigs)),
            transcription_llm_config: named(defaults.transcription_llm_config, nameMap(legacyTranscriptionConfigs)),
          },
          execution_timeout_limits: limits,
          recycle_bin_retention_days: binSettings.retention_days,
          quickstart:
            quickstartStatus instanceof Error
              ? { unavailable: quickstartStatus.message }
              : {
                  supported_providers: quickstartStatus.supported_providers,
                  last_config_name: quickstartStatus.last_config?.config_name ?? null,
                  is_synced: quickstartStatus.is_synced,
                },
        };
      }),
  );

  server.registerTool(
    'update_default_models',
    {
      title: 'Set the org default models',
      description:
        'Set the active organization\'s default models (needs LLM-config update permission). Each slot takes an LLM ' +
        'config (memory_embedding_config: an embedding config) by id or name, or null to unset it; slots you omit ' +
        'keep their value. voice_llm_config / transcription_llm_config are legacy slots: they take a legacy realtime ' +
        '/ transcription config (list_voice_configs include_legacy) — a voice agent talks through its own voice ' +
        'config (set_agent_voice), not through these.',
      inputSchema: {
        agent_llm_config: idOrName.nullable().optional().describe('Default LLM of agents.'),
        agent_fcm_llm_config: idOrName.nullable().optional().describe('Default function-calling LLM of agents.'),
        project_manager_llm_config: idOrName.nullable().optional(),
        memory_llm_config: idOrName.nullable().optional(),
        memory_embedding_config: idOrName
          .nullable()
          .optional()
          .describe('Default embedder — knowledge collections index with it when they name none.'),
        voice_llm_config: idOrName
          .nullable()
          .optional()
          .describe('Legacy default voice config: a legacy realtime config by id or name (list_voice_configs include_legacy).'),
        transcription_llm_config: idOrName
          .nullable()
          .optional()
          .describe('Legacy default transcription config: id or name (list_voice_configs include_legacy).'),
      },
    },
    async (slots) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const request: Partial<DefaultModels> = {};
        for (const slot of DEFAULT_MODEL_LLM_SLOTS) {
          const ref = slots[slot];
          if (ref !== undefined) request[slot] = ref === null ? null : await resolveLlmConfig(ref);
        }
        if (slots.memory_embedding_config !== undefined) {
          request.memory_embedding_config =
            slots.memory_embedding_config === null ? null : await resolveEmbeddingConfig(slots.memory_embedding_config);
        }
        if (slots.voice_llm_config !== undefined) {
          request.voice_llm_config =
            slots.voice_llm_config === null ? null : await resolveLegacyVoiceConfig(slots.voice_llm_config);
        }
        if (slots.transcription_llm_config !== undefined) {
          request.transcription_llm_config =
            slots.transcription_llm_config === null
              ? null
              : await resolveLegacyTranscriptionConfig(slots.transcription_llm_config);
        }
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass at least one slot.');
        return llm.updateDefaultModels(request);
      }),
  );

  server.registerTool(
    'run_quickstart',
    {
      title: 'Provider quickstart',
      description:
        'One-step setup for a provider: from one API key, EpicStaff creates a ready LLM config and embedding config ' +
        'for that provider (for openai / gemini also a voice config of the same name — list_voice_configs); ' +
        'apply_defaults makes them the org default models. supported providers: get_settings → ' +
        'quickstart. The key comes from api_key_env (env var of the MCP server) or api_key_secret — never inline.',
      inputSchema: {
        provider: z.string().min(1).describe('Provider name, e.g. "openai" (get_settings → quickstart.supported_providers).'),
        api_key_env: apiKeyEnvSchema.optional(),
        api_key_secret: apiKeySecretSchema.optional(),
        apply_defaults: z
          .boolean()
          .default(false)
          .describe('Also point the org default models at the new configs (overwrites the current defaults).'),
      },
    },
    async ({ provider, api_key_env, api_key_secret, apply_defaults }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const secretId = await resolveApiKey(api_key_env, api_key_secret);
        if (secretId == null) throw new Error('Pass api_key_env or api_key_secret — the quickstart needs a provider key.');
        const created = await quickstart.create({ provider, api_key_secret_id: secretId });
        const defaults = apply_defaults ? await quickstart.apply() : undefined;
        return {
          config_name: created.config_name,
          llm_config: created.configs.llm_config ? summarizeAuthored(created.configs.llm_config) : null,
          embedding_config: created.configs.embedding_config ? summarizeAuthored(created.configs.embedding_config) : null,
          ...(defaults !== undefined ? { default_models: defaults } : {}),
        };
      }),
  );
}
