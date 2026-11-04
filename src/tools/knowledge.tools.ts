import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  type EstimateDocumentConfig,
  type ImportFromStorageResponse,
  KnowledgeApi,
  NAIVE_CHUNK_OVERLAP_BOUNDS,
  NAIVE_CHUNK_SIZE_BOUNDS,
  NAIVE_CHUNK_STRATEGIES,
  type NaiveRagDocumentConfig,
  type RagType,
  STORAGE_IMPORT_MAX_IDS,
} from '../api/knowledge.js';
import { StorageApi } from '../api/storage.js';
import { ApiError } from '../http/errors.js';
import { runTool } from './auth-org.tools.js';
import { idOrName } from './catalog-helpers.js';

/** Characters of chunk text list_indexed_chunks returns per chunk unless asked for more. */
const DEFAULT_CHUNK_TEXT_CHARS = 1000;

/** The naive RAG of a collection — the only strategy with per-document configs, estimates and stored chunks. */
async function naiveRagOf(knowledge: KnowledgeApi, collectionId: number, purpose: string): Promise<number> {
  const collection = await knowledge.getCollection(collectionId);
  const rags = (collection.rag_configurations ?? []) as Array<{ rag_id: number; rag_type: RagType }>;
  const naive = rags.find((rag) => rag.rag_type === 'naive');
  if (naive !== undefined) return naive.rag_id;
  throw new Error(
    rags.length > 0
      ? `Collection #${collectionId} has only a graph RAG — ${purpose} is available for naive RAG only.`
      : `Collection #${collectionId} has no RAG attached (attach_rag) — ${purpose} needs a naive RAG.`,
  );
}

/** The configs of the named documents (document id or exact file name); all of them when none is named. */
function selectDocumentConfigs(
  configs: NaiveRagDocumentConfig[],
  documents: Array<number | string> | undefined,
  collectionId: number,
): NaiveRagDocumentConfig[] {
  if (documents === undefined) return configs;
  return documents.map((document) => {
    const matches = configs.filter((config) =>
      typeof document === 'number' ? config.document_id === document : config.file_name === document,
    );
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Document "${document}" is ambiguous in collection #${collectionId} — pass its document id.`);
    }
    const available = configs
      .map((config) => `${config.file_name} (${config.document_id})`)
      .slice(0, 30)
      .join(', ');
    throw new Error(
      `Document ${JSON.stringify(document)} has no naive RAG config in collection #${collectionId}. ` +
        `Configured documents: ${available || '(none)'}.`,
    );
  });
}

/**
 * Document management for knowledge collections — the standalone counterpart of
 * what push_flow does for flow-owned collections: list, upload (+ re-index),
 * delete (+ re-index). Lets a corpus evolve without editing any flow source.
 *
 * Note for flow-owned collections: push_flow tracks its documents by content
 * hash in flow.lock.json, so documents added here from outside the flow source
 * are invisible to it (and never removed by it). That's fine — uploads are
 * additive — but the flow.yaml documents list stays the source of truth only
 * for the files it names.
 */
export function registerKnowledgeTools(server: McpServer, context: AppContext): void {
  const knowledge = new KnowledgeApi(context.client);

  server.registerTool(
    'list_documents',
    {
      title: 'List documents in a knowledge collection',
      description:
        'List the documents stored in a knowledge (RAG) source collection: id, file name, and metadata. ' +
        'Use list_source_collections to find the collection id.',
      inputSchema: {
        collection_id: z.number().int().describe('Backend id of the source collection.'),
      },
    },
    async ({ collection_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return knowledge.listDocuments(collection_id);
      }),
  );

  server.registerTool(
    'upload_documents',
    {
      title: 'Upload documents to a knowledge collection',
      description:
        'Upload local files as documents of an existing knowledge collection and (by default) re-trigger ' +
        'indexing of every RAG strategy attached to it, so agents can retrieve the new content once ' +
        'indexing completes (check with get_collection_status). Paths must be absolute. ' +
        'For flow-owned collections prefer adding the files to flow.yaml and re-running push_flow, ' +
        'which keeps the flow source authoritative; this tool is for ad-hoc corpus updates.',
      inputSchema: {
        collection_id: z.number().int().describe('Backend id of the source collection.'),
        file_paths: z
          .array(z.string())
          .min(1)
          .describe('Absolute paths of the local files to upload.'),
        reindex: z
          .boolean()
          .optional()
          .describe('Re-trigger indexing of attached RAG strategies after upload (default true).'),
      },
    },
    async ({ collection_id, file_paths, reindex }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const missing = file_paths.filter((path) => !existsSync(path));
        if (missing.length > 0) {
          throw new Error(`file(s) not found: ${missing.join(', ')}`);
        }
        const uploaded = await knowledge.uploadDocuments(collection_id, file_paths);
        const reindexed = reindex === false ? [] : await knowledge.reindexCollection(collection_id);
        return {
          uploaded,
          reindexed,
          next:
            reindex === false
              ? 'Indexing NOT triggered — the new documents are not retrievable until you re-index.'
              : 'Indexing started. Poll get_collection_status until the RAG status is completed.',
        };
      }),
  );

  server.registerTool(
    'delete_documents',
    {
      title: 'Delete documents from knowledge collections',
      description:
        'Delete documents by document id (see list_documents). When collection_id is given, re-triggers ' +
        'indexing of that collection afterwards so retrieval stops seeing the removed content. ' +
        'Deletion is permanent.',
      inputSchema: {
        document_ids: z.array(z.number().int()).min(1).describe('Ids of the documents to delete.'),
        collection_id: z
          .number()
          .int()
          .optional()
          .describe('Collection to re-index after deletion (omit to skip re-indexing).'),
      },
    },
    async ({ document_ids, collection_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const deleted = await knowledge.deleteDocuments(document_ids);
        const reindexed =
          collection_id === undefined ? [] : await knowledge.reindexCollection(collection_id);
        return {
          deleted,
          reindexed,
          next:
            collection_id === undefined
              ? 'No re-index requested — removed content may remain retrievable until the collection is re-indexed.'
              : 'Indexing started. Poll get_collection_status until the RAG status is completed.',
        };
      }),
  );

  server.registerTool(
    'import_documents_from_storage',
    {
      title: 'Import storage files into a knowledge collection',
      description:
        'Copy files that are already in the organization\'s EpicStaff storage into a knowledge collection as ' +
        'documents (no local upload), then (by default) re-trigger indexing like upload_documents. Name each file ' +
        'or folder by storage path ("docs/" or "docs/guide.pdf") or storage id; a folder imports every file ' +
        'beneath it. Files the collection cannot take — unsupported type, too large, or already present with the ' +
        'same name and size — are skipped and listed, the rest are imported. Needs Knowledge Sources CREATE and ' +
        'Files READ.',
      inputSchema: {
        collection_id: z.number().int().describe('Backend id of the source collection.'),
        storage: z
          .array(idOrName)
          .min(1)
          .max(STORAGE_IMPORT_MAX_IDS)
          .describe('Storage files / folders: a path ("docs/guide.pdf", "docs/") or a storage id.'),
        reindex: z
          .boolean()
          .optional()
          .describe('Re-trigger indexing of attached RAG strategies after the import (default true).'),
      },
    },
    async ({ collection_id, storage: storageRefs, reindex }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const storage = new StorageApi(context.client);
        // One lookup per path, in turn: a long list must not burst the backend (folders cover many files anyway).
        const storageIds = new Set<number>();
        for (const ref of storageRefs) {
          storageIds.add(typeof ref === 'number' ? ref : await storage.resolveItemId(ref));
        }
        let imported: ImportFromStorageResponse;
        try {
          imported = await knowledge.importFromStorage(collection_id, [...storageIds]);
        } catch (error) {
          if (error instanceof ApiError && error.bodyExcerpt?.includes('nothing_to_import')) {
            throw new Error(
              'Nothing was imported: every selected file was skipped (unsupported type, too large, or already in ' +
                `the collection with the same name and size). ${error.bodyExcerpt}`,
            );
          }
          throw error;
        }
        const reindexed =
          reindex === false || imported.documents.length === 0 ? [] : await knowledge.reindexCollection(collection_id);
        return {
          message: imported.message,
          documents: imported.documents,
          skipped: imported.skipped,
          reindexed,
          next:
            reindex === false
              ? 'Indexing NOT triggered — the imported documents are not retrievable until you re-index.'
              : reindexed.length > 0
                ? 'Indexing started. Poll get_collection_status until the RAG status is completed.'
                : 'No RAG strategy is attached (or nothing new was imported) — nothing to index; attach_rag to make it searchable.',
        };
      }),
  );

  server.registerTool(
    'estimate_rag_indexing',
    {
      title: 'Estimate the cost of indexing a collection',
      description:
        'Read-only token and cost estimate of (re-)indexing a collection\'s naive RAG: document and chunk counts, ' +
        'embedding tokens (exact or approximated) and USD cost when the model price is known. Pass chunk_size / ' +
        'chunk_overlap / chunk_strategy to estimate a what-if chunking without saving it. Nothing is indexed or ' +
        'changed. Not available for graph RAG. Needs Knowledge Sources UPDATE (like indexing).',
      inputSchema: {
        collection_id: z.number().int().describe('Backend id of the source collection.'),
        documents: z
          .array(idOrName)
          .min(1)
          .optional()
          .describe('Only these documents (document id or exact file name — list_documents). Default: all.'),
        chunk_size: z
          .number()
          .int()
          .min(NAIVE_CHUNK_SIZE_BOUNDS.min)
          .max(NAIVE_CHUNK_SIZE_BOUNDS.max)
          .optional()
          .describe('What-if chunk size for every selected document.'),
        chunk_overlap: z
          .number()
          .int()
          .min(NAIVE_CHUNK_OVERLAP_BOUNDS.min)
          .max(NAIVE_CHUNK_OVERLAP_BOUNDS.max)
          .optional()
          .describe('What-if chunk overlap for every selected document.'),
        chunk_strategy: z.enum(NAIVE_CHUNK_STRATEGIES).optional().describe('What-if chunking strategy.'),
      },
    },
    async ({ collection_id, documents, chunk_size, chunk_overlap, chunk_strategy }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const ragId = await naiveRagOf(knowledge, collection_id, 'an indexing estimate');
        const configs = selectDocumentConfigs(
          await knowledge.listNaiveRagDocumentConfigs(ragId),
          documents,
          collection_id,
        );
        if (configs.length === 0) {
          throw new Error(`Collection #${collection_id} has no documents configured for its naive RAG — nothing to estimate.`);
        }
        const whatIf = {
          ...(chunk_size !== undefined ? { chunk_size } : {}),
          ...(chunk_overlap !== undefined ? { chunk_overlap } : {}),
          ...(chunk_strategy !== undefined ? { chunk_strategy } : {}),
        };
        const overrides: EstimateDocumentConfig[] | undefined =
          Object.keys(whatIf).length > 0
            ? configs.map((config) => ({ document_config_id: config.naive_rag_document_id, ...whatIf }))
            : undefined;
        const estimate = await knowledge.estimateIndexing(
          ragId,
          'naive',
          configs.map((config) => config.naive_rag_document_id),
          overrides,
        );
        return {
          collection_id,
          rag_id: ragId,
          chunking: overrides !== undefined ? { what_if: whatIf } : 'the saved per-document settings',
          ...estimate,
        };
      }),
  );

  server.registerTool(
    'list_indexed_chunks',
    {
      title: 'List the indexed chunks of a document',
      description:
        'Read the chunks a collection\'s naive RAG indexed for one document, in document order — what retrieval ' +
        'actually searches. Use it to debug retrieval: empty or garbled text, chunks too big or too small. Text is ' +
        `cut at ${DEFAULT_CHUNK_TEXT_CHARS} characters per chunk unless text_chars says otherwise.`,
      inputSchema: {
        collection_id: z.number().int().describe('Backend id of the source collection.'),
        document: idOrName.describe('The document: its document id or exact file name (list_documents).'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        text_chars: z
          .number()
          .int()
          .min(50)
          .max(20_000)
          .optional()
          .describe(`Characters of each chunk's text to return (default ${DEFAULT_CHUNK_TEXT_CHARS}).`),
      },
    },
    async ({ collection_id, document, limit, offset, text_chars }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const ragId = await naiveRagOf(knowledge, collection_id, 'listing indexed chunks');
        const [config] = selectDocumentConfigs(await knowledge.listNaiveRagDocumentConfigs(ragId), [document], collection_id);
        if (config === undefined) throw new Error(`Document ${JSON.stringify(document)} not found.`);
        const page = await knowledge.listIndexedChunks(config.naive_rag_document_id, limit, offset);
        const maxChars = text_chars ?? DEFAULT_CHUNK_TEXT_CHARS;
        return {
          document: {
            document_id: config.document_id,
            file_name: config.file_name,
            document_config_id: config.naive_rag_document_id,
            ...(config.status !== undefined ? { status: config.status } : {}),
          },
          count: page.count,
          offset,
          chunks: page.results.map((chunk) => ({
            chunk_index: chunk.chunk_index,
            token_count: chunk.token_count,
            text: chunk.text.length > maxChars ? `${chunk.text.slice(0, maxChars)}…` : chunk.text,
            ...(chunk.text.length > maxChars ? { text_length: chunk.text.length } : {}),
            ...(Object.keys(chunk.metadata ?? {}).length > 0 ? { metadata: chunk.metadata } : {}),
          })),
          ...(page.count === 0
            ? { note: 'No chunks stored — the document has not been indexed yet (get_collection_status).' }
            : {}),
        };
      }),
  );
}
