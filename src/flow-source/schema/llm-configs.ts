/**
 * `llm_configs` section — named LLM configurations referenced by agents and
 * classification nodes.
 */
import { z } from 'zod';

import { credentialEnvName, symbolicNameSchema } from './common.js';

/**
 * Extra settings of the config. The LLMConfig columns (timeout, context_window, extra_headers,
 * input/output_cost_per_token, is_visible) are sent as such; every other key is a model setting
 * and goes into the config's `parameters`, which the backend checks against its model catalog.
 * The bounds the backend applies to every model are checked here too; the rest pass as-is.
 */
const llmParamsSchema = z
  .record(z.string(), z.unknown())
  .superRefine((params, context) => {
    const integerAtLeast = (key: string, minimum: number): void => {
      const value = params[key];
      if (value === undefined || value === null) return;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be an integer of at least ${minimum} (EpicStaff LLMConfig minimum)`,
        });
      }
    };
    integerAtLeast('max_tokens', 500);
    integerAtLeast('context_window', 1000);
    const temperature = params['temperature'];
    if (temperature !== undefined && temperature !== null && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['temperature'], message: 'temperature must be between 0 and 2' });
    }
  })
  .default({})
  .describe(
    'Extra settings: model settings the model takes (top_p, seed, stop, reasoning_effort, top_k, …; the backend refuses ' +
      'one the model does not support) and the config fields timeout, context_window ≥ 1000, extra_headers, ' +
      'input_cost_per_token / output_cost_per_token, is_visible.',
  );

export const llmConfigSchema = z
  .strictObject({
    model: z
      .string()
      .min(1)
      .describe('Model name, e.g. "gpt-4o" or "claude-sonnet-4".'),
    provider: z
      .string()
      .optional()
      .describe(
        'LLM provider, e.g. "openai", "anthropic", "groq". When omitted, the model with exactly this name is used. ' +
          'Name it for a model several providers share, and for a model the catalog does not list ' +
          '(a custom model on azure, ollama, openrouter, …).',
      ),
    // Bounds mirror the backend's parameter registry (ai_models/data/parameter_registry.yaml:
    // temperature 0–2, max_tokens >= 500) and the LLMConfig model (context_window >= 1000), so
    // build_flow reports what push would be refused for. A model may narrow them further.
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Sampling temperature (0–2; some providers stop at 1).'),
    max_tokens: z
      .number()
      .int()
      .min(500, 'max_tokens must be at least 500 (EpicStaff LLMConfig minimum)')
      .optional()
      .describe('Maximum tokens per completion (at least 500, at most the model\'s output limit).'),
    base_url: z
      .string()
      .optional()
      .describe('Custom API base URL for self-hosted or proxied providers (the `base_url` connection field).'),
    connection: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Other connection fields the provider declares, e.g. azure { api_version, deployment_id }, bedrock ' +
          '{ aws_region_name }, vertex_ai { vertex_project, vertex_location }. A secret field takes an ' +
          '"epicstaff_secret(<org secret name>)" marker, never the value. On an existing config these replace its connection fields.',
      ),
    api_key_env: credentialEnvName(
      'Name of the environment variable that holds the provider API key. The key value itself never lives in flow source: ' +
        'on push it is stored as an org Secret (named "es-mcp:<ENV>") and the LLM config references that secret. ' +
        'EPICSTAFF_* / ES_MCP_* names are rejected.',
    ).optional(),
    params: llmParamsSchema,
  })
  .describe(
    'One named LLM configuration. With no temperature / max_tokens / params the backend stores the model\'s ' +
      'default settings; once any is set, only the ones written here are stored (the rest stay unset).',
  );

export type LlmConfigSource = z.infer<typeof llmConfigSchema>;

export const llmConfigsSectionSchema = z
  .record(symbolicNameSchema, llmConfigSchema)
  .default({})
  .describe('Named LLM configurations, keyed by symbolic name.');
