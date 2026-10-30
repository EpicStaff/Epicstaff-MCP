import type { ApiClient } from '../http/client.js';
import { type Paginated, unwrap } from './paging.js';

/**
 * Flow versions API — ported from the version methods of features/flows/services/flows-api.service.ts
 * and the DTOs in features/flows/models/graph.model.ts. Backend: GraphVersionViewSet
 * (tables/views/model_view_sets.py) — org-scoped through the version's graph; a version of a
 * flow outside the active org is a 404.
 *
 * A version is a named snapshot of a flow. Restoring it rewrites that flow in place (optimistically
 * locked by the flow's `save_version`); "create graph" makes a brand-new flow from it instead.
 */
export interface GraphVersionDto {
  id: number;
  graph_id: number;
  name: string;
  description: string;
  created_at: string;
}

export interface GraphVersionCreateRequest {
  graph_id: number;
  name: string;
  description?: string;
}

export interface GraphVersionUpdateRequest {
  name: string;
  description: string;
}

/** A node or edge the restore could not bring back (its dependency is gone). */
export interface RestoreWarning {
  type: 'node_skipped' | 'edge_dropped' | string;
  node_name?: string;
  node_type?: string;
  node_id?: number;
  missing_node_id?: number;
  [key: string]: unknown;
}

export interface GraphRestoreResponse {
  restored: boolean;
  graph_id: number;
  warnings: RestoreWarning[];
  /** Set when the restore was asked to back up the current state first (`?backup=true`). */
  auto_backup_version_id?: number | null;
  node_id_map?: Record<string, number>;
}

export interface CreateGraphFromVersionResponse {
  created: boolean;
  graph_id: number;
  warnings: RestoreWarning[];
}

export class GraphVersionsApi {
  constructor(private readonly client: ApiClient) {}

  /** Versions of one flow, newest first (the backend orders by `-created_at`). */
  async list(graphId: number): Promise<GraphVersionDto[]> {
    return unwrap(
      await this.client.get<Paginated<GraphVersionDto> | GraphVersionDto[]>('graph-versions/', {
        query: { graph_id: graphId, limit: 1000 },
      }),
    );
  }

  async get(id: number): Promise<GraphVersionDto> {
    return this.client.get<GraphVersionDto>(`graph-versions/${id}/`);
  }

  async create(request: GraphVersionCreateRequest): Promise<GraphVersionDto> {
    return this.client.post<GraphVersionDto>('graph-versions/', { body: request });
  }

  async update(id: number, request: GraphVersionUpdateRequest): Promise<GraphVersionDto> {
    return this.client.patch<GraphVersionDto>(`graph-versions/${id}/`, { body: request });
  }

  /**
   * Restore the version into its flow. `saveVersion` is the flow's current save_version (the
   * restore is refused with 409 when the flow changed since); `backup` first saves the current
   * state as a version of its own.
   */
  async restore(id: number, saveVersion: number, backup: boolean): Promise<GraphRestoreResponse> {
    return this.client.post<GraphRestoreResponse>(`graph-versions/${id}/restore/`, {
      body: { save_version: saveVersion },
      ...(backup ? { query: { backup: 'true' } } : {}),
    });
  }

  /** Make a brand-new, independent flow from the version (the original flow is untouched). */
  async createGraph(id: number): Promise<CreateGraphFromVersionResponse> {
    return this.client.post<CreateGraphFromVersionResponse>(`graph-versions/${id}/create-graph/`, { body: {} });
  }
}
