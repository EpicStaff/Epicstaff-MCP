/**
 * `llm_configs` section — named LLM configurations referenced by agents and
 * classification nodes.
 */
import { z } from 'zod';

import { symbolicNameSchema } from './common.js';

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
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Sampling temperature (0–2). Backend default when omitted.'),
    max_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum tokens per completion. Backend default when omitted.'),
    base_url: z
      .string()
      .optional()
      .describe('Custom API base URL for self-hosted or proxied providers.'),
    api_key_env: z
      .string()
      .optional()
      .describe(
        'Name of the environment variable that holds the provider API key. The key value itself never lives in flow source.',
      ),
    params: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Extra provider-specific parameters, passed through to the backend as-is.'),
  })
  .describe('One named LLM configuration.');

export type LlmConfigSource = z.infer<typeof llmConfigSchema>;

export const llmConfigsSectionSchema = z
  .record(symbolicNameSchema, llmConfigSchema)
  .default({})
  .describe('Named LLM configurations, keyed by symbolic name.');
