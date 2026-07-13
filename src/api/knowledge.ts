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

interface Paginated<T> {
  count: number;
  results: T[];
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

  async createNaiveRag(collectionId: number, embedderId: number): Promise<{ id?: number; rag_id?: number }> {
    return this.client.post(`naive-rag/collections/${collectionId}/naive-rag/`, {
      body: { embedder_id: embedderId },
    });
  }

  async createGraphRag(
    collectionId: number,
    embedderId: number,
    llmId: number,
  ): Promise<{ id?: number; rag_id?: number }> {
    return this.client.post(`graph-rag/collections/${collectionId}/graph-rag/`, {
      body: { embedder_id: embedderId, llm_id: llmId },
    });
  }

  /** Kick off async indexing; readiness is checked via get_collection_status. */
  async startIndexing(ragId: number, ragType: RagType): Promise<{ detail: string }> {
    return this.client.post('process-rag-indexing/', { body: { rag_id: ragId, rag_type: ragType } });
  }
}
