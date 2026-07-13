import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
function unwrap(response) {
    return Array.isArray(response) ? response : response.results;
}
export class KnowledgeApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async listCollections() {
        return unwrap(await this.client.get('source-collections/', {
            query: { limit: 1000 },
        }));
    }
    async getCollection(collectionId) {
        return this.client.get(`source-collections/${collectionId}/`);
    }
    async createCollection(collectionName) {
        return this.client.post('source-collections/', { body: { collection_name: collectionName } });
    }
    /** Upload local files as collection documents (multipart `files`, like the frontend). */
    async uploadDocuments(collectionId, filePaths) {
        const formData = new FormData();
        for (const filePath of filePaths) {
            const buffer = readFileSync(filePath);
            formData.append('files', new Blob([new Uint8Array(buffer)]), basename(filePath));
        }
        return this.client.post(`documents/source-collection/${collectionId}/upload/`, { formData });
    }
    async createNaiveRag(collectionId, embedderId) {
        return this.client.post(`naive-rag/collections/${collectionId}/naive-rag/`, {
            body: { embedder_id: embedderId },
        });
    }
    async createGraphRag(collectionId, embedderId, llmId) {
        return this.client.post(`graph-rag/collections/${collectionId}/graph-rag/`, {
            body: { embedder_id: embedderId, llm_id: llmId },
        });
    }
    /** Kick off async indexing; readiness is checked via get_collection_status. */
    async startIndexing(ragId, ragType) {
        return this.client.post('process-rag-indexing/', { body: { rag_id: ragId, rag_type: ragType } });
    }
}
