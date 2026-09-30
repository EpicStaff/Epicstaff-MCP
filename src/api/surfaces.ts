import type { EpicStaffClient } from '../http/client.js';

/**
 * Surface API — ported from features/agent-definitions/services/surfaces-api.service.ts
 * and models/surface.model.ts. Catalog surfaces only: inline surfaces have no route —
 * they travel inside node write payloads.
 */
export type ToolMode = 'allow' | 'deny';
export type PermTriState = 'allow' | 'unset' | 'deny';

export interface SurfacePythonTool {
  python_tool: number;
  mode: ToolMode;
}

export interface SurfaceMcpTool {
  mcp_tool: number;
  mode: ToolMode;
}

export interface SurfaceStorageItem {
  storage_file: number;
  can_list: PermTriState;
  can_view: PermTriState;
  can_edit: PermTriState;
  can_delete: PermTriState;
}

export interface SurfaceNaiveSearchConfig {
  search_limit: number;
  similarity_threshold: string | number;
}

export interface SurfaceGraphBasicSearchConfig {
  prompt?: string | null;
  k: number;
  max_context_tokens: number;
}

export interface SurfaceGraphLocalSearchConfig {
  prompt?: string | null;
  text_unit_prop: number;
  community_prop: number;
  conversation_history_max_turns: number;
  top_k_entities: number;
  top_k_relationships: number;
  max_context_tokens: number;
}

export interface SurfaceKnowledge {
  collection: number;
  naive_search_config?: SurfaceNaiveSearchConfig | null;
  graph_basic_search_config?: SurfaceGraphBasicSearchConfig | null;
  graph_local_search_config?: SurfaceGraphLocalSearchConfig | null;
}

export interface Surface {
  id: number;
  organization: number;
  name: string;
  description: string;
  instructions: string;
  owner_agent: number | null;
  allow_creation: boolean;
  python_tools: SurfacePythonTool[];
  mcp_tools: SurfaceMcpTool[];
  storage_items: SurfaceStorageItem[];
  knowledge: SurfaceKnowledge[];
}

export interface CreateSurfaceRequest {
  name: string;
  description?: string;
  instructions?: string;
  owner_agent?: number | null;
  allow_creation?: boolean;
  python_tools?: SurfacePythonTool[];
  mcp_tools?: SurfaceMcpTool[];
  storage_items?: SurfaceStorageItem[];
  knowledge?: SurfaceKnowledge[];
}

interface Paginated<T> {
  count: number;
  results: T[];
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class SurfacesApi {
  constructor(private readonly client: EpicStaffClient) {}

  async list(): Promise<Surface[]> {
    return unwrap(await this.client.get<Paginated<Surface> | Surface[]>('surfaces/', { query: { limit: 1000 } }));
  }

  async get(id: number): Promise<Surface> {
    return this.client.get(`surfaces/${id}/`);
  }

  async create(request: CreateSurfaceRequest): Promise<Surface> {
    return this.client.post('surfaces/', { body: request });
  }

  async update(id: number, request: CreateSurfaceRequest): Promise<Surface> {
    return this.client.put(`surfaces/${id}/`, { body: request });
  }

  /** Delete a catalog surface. Backend responds 204 (SurfaceViewSet is a plain ModelViewSet). */
  async delete(id: number): Promise<void> {
    await this.client.delete<void>(`surfaces/${id}/`);
  }
}
