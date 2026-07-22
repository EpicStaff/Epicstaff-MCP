import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { EpicStaffClient } from '../http/client.js';

/**
 * Knowledge / RAG API — ported from features/knowledge-sources/services/
 * {collections-api,documents-api,naive-rag,graph-rag}.service.ts.
 *
 * The RAG chain is a pipeline, not a single POST:
 * create collection → upload documents → attach strategy → trigger async indexing.
 */
export type RagType = 'naive' | 'graph';

export interface SourceCollection {
  collection_id?: number;
  id?: number;
  collection_name: string;
  status?: string;
  [key: string]: unknown;
}

/** `GET source-collections/{id}/documents/` response (CollectionDocumentsViewSet.list). */
export interface CollectionDocuments {
  collection_id: number;
  collection_name: string;
  document_count: number;
  documents: Array<Record<string, unknown>>;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

/**
 * `POST naive-rag/collections/{id}/naive-rag/` response envelope.
 * The backend wraps the created row under `naive_rag` and exposes its id as
 * `naive_rag_id` (see NaiveRagViewSet.create_or_update / NaiveRagSerializer).
 */
interface NaiveRagCreateResponse {
  message?: string;
  naive_rag?: { naive_rag_id?: number };
}

/** `POST graph-rag/collections/{id}/graph-rag/` response — same envelope shape. */
interface GraphRagCreateResponse {
  message?: string;
  graph_rag?: { graph_rag_id?: number };
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class KnowledgeApi {
  constructor(private readonly client: EpicStaffClient) {}

  async listCollections(): Promise<SourceCollection[]> {
    return unwrap(
      await this.client.get<Paginated<SourceCollection> | SourceCollection[]>('source-collections/', {
        query: { limit: 1000 },
      }),
    );
  }

  async getCollection(collectionId: number): Promise<SourceCollection> {
    return this.client.get(`source-collections/${collectionId}/`);
  }

  async createCollection(collectionName: string): Promise<SourceCollection> {
    return this.client.post('source-collections/', { body: { collection_name: collectionName } });
  }

  /** Upload local files as collection documents (multipart `files`, like the frontend). */
  async uploadDocuments(collectionId: number, filePaths: string[]): Promise<unknown> {
    const formData = new FormData();
    for (const filePath of filePaths) {
      const buffer = readFileSync(filePath);
      formData.append('files', new Blob([new Uint8Array(buffer)]), basename(filePath));
    }
    return this.client.post(`documents/source-collection/${collectionId}/upload/`, { formData });
  }

  /** List the documents of one collection (nested route, returns collection info + documents). */
  async listDocuments(collectionId: number): Promise<CollectionDocuments> {
    return this.client.get(`source-collections/${collectionId}/documents/`);
  }

  /** Delete documents by id across collections (`POST documents/bulk-delete/`). */
  async deleteDocuments(documentIds: number[]): Promise<unknown> {
    return this.client.post('documents/bulk-delete/', { body: { document_ids: documentIds } });
  }

  /**
   * Re-trigger indexing of every RAG strategy attached to a collection — the
   * step the pusher runs after document changes so retrieval sees the new set.
   * Returns the rags that were kicked off.
   */
  async reindexCollection(collectionId: number): Promise<Array<{ rag_id: number; rag_type: RagType }>> {
    const collection = await this.getCollection(collectionId);
    const rags = (collection.rag_configurations ?? []) as Array<{ rag_id: number; rag_type: RagType }>;
    await Promise.all(rags.map((rag) => this.startIndexing(rag.rag_id, rag.rag_type)));
    return rags.map((rag) => ({ rag_id: rag.rag_id, rag_type: rag.rag_type }));
  }

  /**
   * Create (or idempotently update) the naive RAG for a collection and return
   * its backend id. The endpoint is `create_or_update` server-side, so a repeat
   * call for the same collection returns the same row rather than duplicating.
   */
  async createNaiveRag(collectionId: number, embedderId: number): Promise<number> {
    const response = await this.client.post<NaiveRagCreateResponse>(
      `naive-rag/collections/${collectionId}/naive-rag/`,
      { body: { embedder_id: embedderId } },
    );
    const id = response.naive_rag?.naive_rag_id;
    if (id === undefined) {
      throw new Error(
        `naive-rag creation did not return a naive_rag_id (got: ${JSON.stringify(response)}).`,
      );
    }
    return id;
  }

  /** Create (or idempotently update) the graph RAG for a collection; returns its backend id. */
  async createGraphRag(collectionId: number, embedderId: number, llmId: number): Promise<number> {
    const response = await this.client.post<GraphRagCreateResponse>(
      `graph-rag/collections/${collectionId}/graph-rag/`,
      { body: { embedder_id: embedderId, llm_id: llmId } },
    );
    const id = response.graph_rag?.graph_rag_id;
    if (id === undefined) {
      throw new Error(
        `graph-rag creation did not return a graph_rag_id (got: ${JSON.stringify(response)}).`,
      );
    }
    return id;
  }

  /** Kick off async indexing; readiness is checked via get_collection_status. */
  async startIndexing(ragId: number, ragType: RagType): Promise<{ detail: string }> {
    return this.client.post('process-rag-indexing/', { body: { rag_id: ragId, rag_type: ragType } });
  }

  /**
   * Delete a source collection and everything derived from it — documents, attached
   * RAG strategies, and the pgvector index. Irreversible. Backend responds 204.
   */
  async deleteCollection(collectionId: number): Promise<void> {
    await this.client.delete<void>(`source-collections/${collectionId}/`);
  }
}
