/**
 * `knowledge` section — named knowledge collections built from local documents,
 * with a RAG strategy (`naive` vector search or `graph` RAG).
 *
 * Search-time settings (result limit, similarity threshold, graph community
 * level) do NOT live here — they belong to the surface knowledge entry that
 * attaches the collection (`surfaces.<name>.knowledge[]`, e.g.
 * `graph_local_search_config`). This section only configures how the
 * collection is indexed.
 */
import { z } from 'zod';

import { entityRef, symbolicNameSchema } from './common.js';

export const naiveRagConfigSchema = z
  .strictObject({
    strategy: z.literal('naive').describe('Plain chunk-and-embed vector RAG.'),
    chunk_size: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Chunk size in tokens, applied to every document. Backend default (1000) when omitted.'),
    chunk_overlap: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Overlap in tokens between consecutive chunks. Backend default (150) when omitted.'),
    embedder: z
      .string()
      .optional()
      .describe('Embedding config name on the backend. Backend default when omitted.'),
  })
  .describe(
    'Naive (chunk + embed + similarity search) RAG configuration. ' +
      'Search-time limits/thresholds are configured on the surface knowledge entry, not here.',
  );

export const graphRagConfigSchema = z
  .strictObject({
    strategy: z.literal('graph').describe('Graph RAG: entity/community graph built over the documents.'),
    llm_config: entityRef('LLM config used to build and query the knowledge graph.').optional(),
    embedder: z
      .string()
      .optional()
      .describe('Embedding config name on the backend. Org default when omitted.'),
    chunk_size: z
      .number()
      .int()
      .min(100)
      .max(10000)
      .optional()
      .describe('Chunk size in tokens fed to graph extraction. Backend default (1200) when omitted.'),
    chunk_overlap: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe('Overlap in tokens between consecutive chunks. Backend default (100) when omitted.'),
    entity_types: z
      .array(z.string().min(1))
      .nonempty()
      .optional()
      .describe(
        'Entity categories the extraction LLM is instructed to find. Backend default: ' +
          '["organization", "person", "geo", "event"]. Match these to the corpus domain — ' +
          'concepts that fit no listed type are often not extracted and become invisible to ' +
          'graph search. Richer lists grow the graph and indexing cost.',
      ),
    max_gleanings: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        'How many times the extraction LLM is re-asked for missed entities per chunk. ' +
          'Backend default: 1. Each increment adds roughly one full extraction pass of LLM cost.',
      ),
  })
  .describe(
    'Graph RAG configuration. Search-time settings (community level, result limit) are ' +
      'configured on the surface knowledge entry (graph_local_search_config), not here.',
  );

// Members of a discriminatedUnion must stay plain ZodObjects (zod 3), so the
// cross-field chunk check lives on the union.
export const ragConfigSchema = z
  .discriminatedUnion('strategy', [naiveRagConfigSchema, graphRagConfigSchema])
  .superRefine((config, ctx) => {
    if (
      config.chunk_size !== undefined &&
      config.chunk_overlap !== undefined &&
      config.chunk_overlap >= config.chunk_size
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chunk_overlap'],
        message: `chunk_overlap (${config.chunk_overlap}) must be smaller than chunk_size (${config.chunk_size}).`,
      });
    }
  })
  .describe('RAG strategy for the collection: "naive" vector search or "graph" RAG.');

export type RagConfigSource = z.infer<typeof ragConfigSchema>;

export const knowledgeCollectionSchema = z
  .strictObject({
    description: z.string().optional().describe('What this collection contains.'),
    documents: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Local document file paths, relative to the flow directory. Uploaded into the collection at push time.',
      ),
    rag: ragConfigSchema
      .default({ strategy: 'naive' })
      .describe('RAG strategy and its configuration. Defaults to naive with standard chunking.'),
  })
  .describe('One named knowledge collection built from local documents.');

export type KnowledgeCollectionSource = z.infer<typeof knowledgeCollectionSchema>;

export const knowledgeSectionSchema = z
  .record(symbolicNameSchema, knowledgeCollectionSchema)
  .default({})
  .describe('Knowledge collections, keyed by symbolic name.');
