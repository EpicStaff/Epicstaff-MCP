/**
 * Root flow-source schema.
 *
 * A flow is a directory containing `flow.yaml` (or several `*.flow.yaml` /
 * `.json` files that deep-merge by top-level section). Sections:
 * `meta`, `llm_configs`, `tools`, `knowledge`, `surfaces`, `agents`, `flow`.
 *
 * Entities are keyed by symbolic name (the YAML map key) and cross-referenced
 * by that name; every reference position also accepts `{existing: "<name>"}`
 * to reuse an entity already present on the backend.
 */
import { z } from 'zod';
import { agentsSectionSchema } from './agents.js';
import { flowSectionSchema } from './flow.js';
import { knowledgeSectionSchema } from './knowledge.js';
import { llmConfigsSectionSchema } from './llm-configs.js';
import { surfacesSectionSchema } from './surfaces.js';
import { toolsSectionSchema } from './tools.js';
export const metaSchema = z
    .strictObject({
    name: z
        .string()
        .min(1)
        .describe('Flow name — unique per organization; used as the graph name on push.'),
    description: z.string().optional().describe('What this flow does.'),
})
    .describe('Flow metadata.');
export const flowSourceSchema = z
    .strictObject({
    meta: metaSchema,
    llm_configs: llmConfigsSectionSchema,
    tools: toolsSectionSchema,
    knowledge: knowledgeSectionSchema,
    surfaces: surfacesSectionSchema,
    agents: agentsSectionSchema,
    flow: flowSectionSchema,
})
    .describe('A complete flow source document (after multi-file merge).');
export * from './common.js';
export * from './llm-configs.js';
export * from './tools.js';
export * from './knowledge.js';
export * from './surfaces.js';
export * from './agents.js';
export * from './flow.js';
