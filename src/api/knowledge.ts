import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ApiClient } from '../http/client.js';

/**
 * Knowledge / RAG API — ported from features/knowledge-sources/services/
 * {collections-api,documents-api,naive-rag,graph-rag,rag-indexing}.service.ts. The indexed-chunk
 * listing has no frontend consumer: it is backend-derived from
 * `src/django_app/tables/views/knowledge_views/naive_rag_views.py` (NaiveRagChunkViewSet).
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

/** One row of `GET source-collections/{id}/available-rags/`. */
export interface AvailableRag {
  rag_id: number;
  rag_type: RagType;
  rag_status: string;
  collection_id: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Every non-terminal-failure RAG status. The endpoint defaults to `completed,new`,
 * which would hide a RAG that is still indexing right after a push.
 */
const SELECTABLE_RAG_STATUSES = 'new,processing,completed,warning,partial,outdated';

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

/**
 * `PUT graph-rag/{id}/index-config/` body — GraphRagIndexConfigUpdateSerializer.
 * All fields optional server-side; the backend requires at least one.
 */
export interface GraphRagIndexConfigUpdate {
  chunk_size?: number;
  chunk_overlap?: number;
  entity_types?: string[];
  max_gleanings?: number;
}

/** One row of `GET naive-rag/{id}/document-configs/` (DocumentConfigSerializer). */
export interface NaiveRagDocumentConfig {
  naive_rag_document_id: number;
  document_id: number;
  file_name: string;
  chunk_strategy?: string;
  chunk_size: number;
  chunk_overlap: number;
  status?: string;
  total_chunks?: number;
  [key: string]: unknown;
}

/**
 * `GET naive-rag/{id}/document-configs/` (`GetNaiveRagDocumentConfigsResponse`): the configs come
 * wrapped in an envelope, not as a DRF page (NaiveRagDocumentConfigViewSet.list_configs).
 */
export interface GetNaiveRagDocumentConfigsResponse {
  naive_rag_id: number;
  total_configs: number;
  configs: NaiveRagDocumentConfig[];
}

/** `PUT naive-rag/{id}/document-configs/bulk-update/` — per-document chunking fields. */
export interface NaiveRagChunkingUpdate {
  chunk_size?: number;
  chunk_overlap?: number;
}

/** NaiveRagDocumentConfig.ChunkStrategy. */
export const NAIVE_CHUNK_STRATEGIES = ['token', 'character', 'markdown', 'json', 'html', 'csv'] as const;
export type NaiveChunkStrategy = (typeof NAIVE_CHUNK_STRATEGIES)[number];

/** Backend bounds of a naive document config (tables/constants/knowledge_constants.py). */
export const NAIVE_CHUNK_SIZE_BOUNDS = { min: 20, max: 8000 } as const;
export const NAIVE_CHUNK_OVERLAP_BOUNDS = { min: 0, max: 1000 } as const;

/**
 * Unsaved chunking settings of one document for an estimate (`EstimateDocumentConfig`,
 * DocumentConfigEstimateOverrideSerializer) — validated like a bulk update, never persisted.
 */
export interface EstimateDocumentConfig {
  document_config_id: number;
  chunk_size?: number;
  chunk_overlap?: number;
  chunk_strategy?: NaiveChunkStrategy;
  additional_params?: Record<string, unknown>;
}

/** `POST process-rag-indexing/estimate/` response (`IndexingEstimate`). */
export interface IndexingEstimate {
  rag_type: RagType;
  document_count: number;
  chunk_count: number;
  embedding: {
    tokens: number;
    /** False when there is no exact tokenizer for the embedding provider and tokens are approximated. */
    exact: boolean;
    cost_usd: number | null;
  };
}

/** `POST documents/source-collection/{id}/from-storage/` — the skip reasons of StorageDocumentImportService. */
export type StorageImportSkipReason = 'unsupported_type' | 'too_large' | 'duplicate';

export interface StorageImportSkippedFile {
  storage_file_id: number;
  path: string;
  reason: StorageImportSkipReason;
}

/** 201 body of `POST documents/source-collection/{id}/from-storage/` (`ImportFromStorageResponse`). */
export interface ImportFromStorageResponse {
  message: string;
  documents: Array<Record<string, unknown>>;
  skipped: StorageImportSkippedFile[];
}

/** The most storage ids one import may select (ImportFromStorageSerializer `max_length`, default limits). */
export const STORAGE_IMPORT_MAX_IDS = 4000;

/** One indexed chunk of a naive RAG document (`naive-rag-document-chunks/`, NaiveRagChunkSerializer). */
export interface NaiveRagChunk {
  chunk_id: number;
  text: string;
  chunk_index: number;
  token_count: number | null;
  overlap_start_index: number | null;
  overlap_end_index: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class KnowledgeApi {
  constructor(private readonly client: ApiClient) {}

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

  /** RAGs attached to a collection that a knowledge-retriever node may search. */
  async listAvailableRags(collectionId: number): Promise<AvailableRag[]> {
    return this.client.get(`source-collections/${collectionId}/available-rags/`, {
      query: { status: SELECTABLE_RAG_STATUSES },
    });
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

  /**
   * Copy files from the organization's storage into a collection as new documents
   * (`importFromStorage`). Folder ids import every file beneath them; files the collection cannot take
   * (unsupported type, too large, already present with the same name and size) come back in `skipped`.
   * Backend: DocumentManagementViewSet.import_from_storage — Knowledge Sources CREATE + Files READ.
   */
  async importFromStorage(collectionId: number, storageFileIds: number[]): Promise<ImportFromStorageResponse> {
    return this.client.post<ImportFromStorageResponse>(`documents/source-collection/${collectionId}/from-storage/`, {
      body: { storage_file_ids: storageFileIds },
    });
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

  /**
   * Update the graph RAG index configuration (chunking, entity types, gleanings).
   * Must run BEFORE startIndexing — the config is read when indexing executes.
   */
  async updateGraphRagIndexConfig(graphRagId: number, config: GraphRagIndexConfigUpdate): Promise<void> {
    await this.client.put(`graph-rag/${graphRagId}/index-config/`, { body: { ...config } });
  }

  /**
   * Ensure every collection document has a naive-rag document config row.
   * Idempotent — only creates configs for documents that lack one (a Django
   * signal creates them on RAG creation, but documents uploaded later need this).
   */
  async initializeNaiveRagDocumentConfigs(naiveRagId: number): Promise<void> {
    await this.client.post(`naive-rag/${naiveRagId}/document-configs/initialize/`);
  }

  /** List the per-document chunking configs of a naive RAG (`getDocumentConfigs`, the `configs` envelope). */
  async listNaiveRagDocumentConfigs(naiveRagId: number): Promise<NaiveRagDocumentConfig[]> {
    const response = await this.client.get<
      GetNaiveRagDocumentConfigsResponse | Paginated<NaiveRagDocumentConfig> | NaiveRagDocumentConfig[]
    >(`naive-rag/${naiveRagId}/document-configs/`);
    return 'configs' in response ? response.configs : unwrap(response);
  }

  /**
   * Apply the same chunking parameters to a set of document configs.
   * Must run BEFORE startIndexing — chunking is read when indexing executes.
   */
  async bulkUpdateNaiveRagDocumentConfigs(
    naiveRagId: number,
    configIds: number[],
    update: NaiveRagChunkingUpdate,
  ): Promise<void> {
    await this.client.put(`naive-rag/${naiveRagId}/document-configs/bulk-update/`, {
      body: { config_ids: configIds, ...update },
    });
  }

  /**
   * Ensure every collection document has a config row, then apply the given
   * chunking parameters to all of them. Initialize always runs: the backend
   * signal creates config rows only when the NaiveRag row is FIRST created —
   * update pushes and later document uploads need it explicitly, and indexing
   * silently skips documents without a config row. Returns how many configs
   * were updated (0 when no chunking parameters were given).
   */
  async applyNaiveDocumentChunking(
    naiveRagId: number,
    chunking?: NaiveRagChunkingUpdate,
  ): Promise<number> {
    await this.initializeNaiveRagDocumentConfigs(naiveRagId);
    if (chunking === undefined || (chunking.chunk_size === undefined && chunking.chunk_overlap === undefined)) {
      return 0;
    }
    const configs = await this.listNaiveRagDocumentConfigs(naiveRagId);
    if (configs.length === 0) return 0;
    await this.bulkUpdateNaiveRagDocumentConfigs(
      naiveRagId,
      configs.map((config) => config.naive_rag_document_id),
      chunking,
    );
    return configs.length;
  }

  /**
   * Read-only token and cost estimate of indexing the given document configs of a naive RAG
   * (`estimateIndexing`, ProcessRagIndexingEstimateView). `documentConfigs` are unsaved chunking
   * settings to estimate with instead of the stored ones; they are validated but never persisted. Same
   * permission as indexing itself (Knowledge Sources UPDATE); a graph RAG is refused with a 400.
   */
  async estimateIndexing(
    ragId: number,
    ragType: RagType,
    documentConfigIds: number[],
    documentConfigs?: EstimateDocumentConfig[],
  ): Promise<IndexingEstimate> {
    const body = {
      rag_id: ragId,
      rag_type: ragType,
      document_config_ids: documentConfigIds,
      ...(documentConfigs?.length ? { document_configs: documentConfigs } : {}),
    };
    return this.client.post<IndexingEstimate>('process-rag-indexing/estimate/', { body });
  }

  /** One page of the indexed chunks of a naive RAG document config, in document order. */
  async listIndexedChunks(
    documentConfigId: number,
    limit: number,
    offset: number,
  ): Promise<Paginated<NaiveRagChunk>> {
    const response = await this.client.get<Paginated<NaiveRagChunk> | NaiveRagChunk[]>('naive-rag-document-chunks/', {
      query: { naive_rag_document_config: documentConfigId, limit, offset },
    });
    return Array.isArray(response) ? { count: response.length, results: response } : response;
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
