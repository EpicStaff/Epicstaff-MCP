/**
 * `knowledge` section — named knowledge collections built from local documents,
 * with a RAG strategy (`naive` vector search or `graph` RAG).
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
        .default(1000)
        .describe('Chunk size in characters used when embedding documents.'),
    chunk_overlap: z
        .number()
        .int()
        .nonnegative()
        .default(200)
        .describe('Overlap in characters between consecutive chunks.'),
    embedder: z
        .string()
        .optional()
        .describe('Embedding config name on the backend. Backend default when omitted.'),
    search_limit: z
        .number()
        .int()
        .positive()
        .default(5)
        .describe('Maximum number of chunks returned per similarity search.'),
    distance_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Similarity distance cut-off (0–1). Backend default when omitted.'),
})
    .describe('Naive (chunk + embed + similarity search) RAG configuration.');
export const graphRagConfigSchema = z
    .strictObject({
    strategy: z.literal('graph').describe('Graph RAG: entity/community graph built over the documents.'),
    llm_config: entityRef('LLM config used to build and query the knowledge graph.').optional(),
    chunk_size: z.number().int().positive().default(1000).describe('Chunk size in characters.'),
    chunk_overlap: z
        .number()
        .int()
        .nonnegative()
        .default(200)
        .describe('Overlap in characters between consecutive chunks.'),
    community_level: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Community hierarchy level used for graph search. Backend default when omitted.'),
    search_limit: z
        .number()
        .int()
        .positive()
        .default(5)
        .describe('Maximum number of results returned per graph search.'),
})
    .describe('Graph RAG configuration.');
export const ragConfigSchema = z
    .discriminatedUnion('strategy', [naiveRagConfigSchema, graphRagConfigSchema])
    .describe('RAG strategy for the collection: "naive" vector search or "graph" RAG.');
export const knowledgeCollectionSchema = z
    .strictObject({
    description: z.string().optional().describe('What this collection contains.'),
    documents: z
        .array(z.string().min(1))
        .min(1)
        .describe('Local document file paths, relative to the flow directory. Uploaded into the collection at push time.'),
    rag: ragConfigSchema
        .default({ strategy: 'naive' })
        .describe('RAG strategy and its configuration. Defaults to naive with standard chunking.'),
})
    .describe('One named knowledge collection built from local documents.');
export const knowledgeSectionSchema = z
    .record(symbolicNameSchema, knowledgeCollectionSchema)
    .default({})
    .describe('Knowledge collections, keyed by symbolic name.');
