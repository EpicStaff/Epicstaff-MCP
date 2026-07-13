import type { EpicStaffClient } from '../http/client.js';
import type { BulkSavePayload, CreateGraphDtoRequest, GetGraphLightRequest, GraphDto } from '../models/graph.js';

/**
 * Graph API — ported from features/flows/services/flows-api.service.ts.
 * Create the graph shell with POST graphs/, persist nodes+edges with the
 * bulk-save endpoint POST graphs/{id}/save/ (save_version optimistic lock).
 * Conditional edges are NOT part of bulk-save — they use conditionaledges/.
 */
interface Paginated<T> {
  count: number;
  results: T[];
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class GraphsApi {
  constructor(private readonly client: EpicStaffClient) {}

  async listLight(): Promise<GetGraphLightRequest[]> {
    return unwrap(
      await this.client.get<Paginated<GetGraphLightRequest> | GetGraphLightRequest[]>('graph-light/', {
        query: { limit: 1000 },
      }),
    );
  }

  async get(graphId: number): Promise<GraphDto> {
    // _ts cache-bust matches the frontend's getGraph()
    return this.client.get(`graphs/${graphId}/`, { query: { _ts: Date.now() } });
  }

  async create(request: CreateGraphDtoRequest): Promise<GraphDto> {
    return this.client.post('graphs/', { body: request });
  }

  /** The main persistence path — returns the full GraphDto incl. new backend ids + save_version. */
  async bulkSave(graphId: number, payload: BulkSavePayload): Promise<GraphDto> {
    return this.client.post(`graphs/${graphId}/save/`, { body: payload });
  }

  async delete(graphId: number): Promise<void> {
    await this.client.delete(`graphs/${graphId}/`);
  }

  // Conditional edges — dedicated endpoints (not in bulk-save, mirroring the frontend).
  async createConditionalEdge(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.post('conditionaledges/', { body });
  }

  async updateConditionalEdge(id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.put(`conditionaledges/${id}/`, { body });
  }

  async deleteConditionalEdge(id: number): Promise<void> {
    await this.client.delete(`conditionaledges/${id}/`);
  }
}
