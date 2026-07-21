import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { runTool } from './auth-org.tools.js';

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
}
