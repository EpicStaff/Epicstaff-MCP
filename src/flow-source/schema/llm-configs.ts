/**
 * `llm_configs` section — named LLM configurations referenced by agents and
 * classification nodes.
 */
import { z } from 'zod';

import { credentialEnvName, symbolicNameSchema } from './common.js';

/**
 * Extra LLMConfig fields, passed through to the backend at the payload top level. Fields with
 * backend validators are checked here too (same bounds as the model); the rest pass as-is.
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
    'Extra provider-specific LLMConfig fields (top_p, timeout, context_window ≥ 1000, …), passed through to the backend as-is.',
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
        'LLM provider, e.g. "openai", "anthropic", "groq". When omitted the backend infers it from the model name.',
      ),
    // Bounds mirror the backend LLMConfig model validators (tables/models/llm_models.py):
    // temperature MinValueValidator(0.0)/MaxValueValidator(2.0), max_tokens MinValueValidator(500),
    // context_window MinValueValidator(1000) — so build_flow reports what push would be refused for.
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Sampling temperature (0–2). Backend default when omitted.'),
    max_tokens: z
      .number()
      .int()
      .min(500, 'max_tokens must be at least 500 (EpicStaff LLMConfig minimum)')
      .optional()
      .describe('Maximum tokens per completion (at least 500). Backend default (4096) when omitted.'),
    base_url: z
      .string()
      .optional()
      .describe('Custom API base URL for self-hosted or proxied providers.'),
    api_key_env: credentialEnvName(
      'Name of the environment variable that holds the provider API key. The key value itself never lives in flow source: ' +
        'on push it is stored as an org Secret (named "es-mcp:<ENV>") and the LLM config references that secret. ' +
        'EPICSTAFF_* / ES_MCP_* names are rejected.',
    ).optional(),
    params: llmParamsSchema,
  })
  .describe('One named LLM configuration.');

export type LlmConfigSource = z.infer<typeof llmConfigSchema>;

export const llmConfigsSectionSchema = z
  .record(symbolicNameSchema, llmConfigSchema)
  .default({})
  .describe('Named LLM configurations, keyed by symbolic name.');
