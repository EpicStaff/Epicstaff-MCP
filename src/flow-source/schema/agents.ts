/**
 * `agents` section — AgentDefinitions: name (map key), boot instructions,
 * LLM configs, execution knobs and default surfaces per usage place.
 */
import { z } from 'zod';

import {
  entityRef,
  existingRefSchema,
  symbolicNameSchema,
  type EntityRef,
} from './common.js';

export const surfacePlaceSchema = z
  .enum(['all', 'flow', 'chat'])
  .describe('Where this default surface applies: everywhere, only in flows, or only in chat.');

export type SurfacePlace = z.infer<typeof surfacePlaceSchema>;

export interface AgentDefaultSurfaceEntry {
  surface: EntityRef;
  place: SurfacePlace;
}

const defaultSurfaceObjectSchema = z.strictObject({
  surface: entityRef('The surface assigned to this agent by default.'),
  place: surfacePlaceSchema.default('all'),
});

/** A default-surface entry: bare reference shorthand (place "all") or `{surface, place}`. */
const defaultSurfaceEntrySchema = z
  .union([
    symbolicNameSchema.transform(
      (name): AgentDefaultSurfaceEntry => ({ surface: name, place: 'all' }),
    ),
    existingRefSchema.transform(
      (ref): AgentDefaultSurfaceEntry => ({ surface: ref, place: 'all' }),
    ),
    defaultSurfaceObjectSchema,
  ])
  .describe(
    'A default surface assignment. Shorthand: a bare reference means {surface: <ref>, place: "all"}.',
  );

export const agentDefinitionSchema = z
  .strictObject({
    description: z.string().optional().describe('One-line summary of what this agent is for.'),
    instructions: z
      .string()
      .default('')
      .describe('Boot instructions — the agent system prompt.'),
    llm_config: entityRef('LLM config the agent thinks with.'),
    fcm_llm_config: entityRef('Separate LLM config used for function calling.').optional(),
    max_iter: z
      .number()
      .int()
      .positive()
      .default(25)
      .describe('Maximum reasoning/tool-call iterations per run.'),
    max_rpm: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum LLM requests per minute. Unlimited when omitted.'),
    max_execution_time: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum execution time per run, in seconds. Unlimited when omitted.'),
    cache: z.boolean().default(true).describe('Whether tool-result caching is enabled.'),
    max_retry_limit: z
      .number()
      .int()
      .nonnegative()
      .default(2)
      .describe('Maximum retries when an LLM call fails.'),
    default_surfaces: z
      .array(defaultSurfaceEntrySchema)
      .default([])
      .describe('Surfaces assigned to this agent by default, per usage place.'),
    metadata: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Free-form metadata stored with the agent definition.'),
  })
  .describe('One AgentDefinition, keyed by its symbolic name.');

export type AgentDefinitionSource = z.infer<typeof agentDefinitionSchema>;

export const agentsSectionSchema = z
  .record(symbolicNameSchema, agentDefinitionSchema)
  .default({})
  .describe('Agent definitions, keyed by symbolic name.');
