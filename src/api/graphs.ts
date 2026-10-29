import type { ApiClient } from '../http/client.js';
import type {
  BulkSavePayload,
  CreateGraphDtoRequest,
  GetGraphLightRequest,
  GraphDto,
  PatchGraphDtoRequest,
} from '../models/graph.js';

import { type Paginated, unwrap } from './paging.js';

/**
 * Graph API — ported from features/flows/services/flows-api.service.ts.
 * Create the graph shell with POST graphs/, persist nodes+edges with the
 * bulk-save endpoint POST graphs/{id}/save/ (save_version optimistic lock).
 * The persistent-state lists are backend-derived (tables/views/model_view_sets.py).
 */

export class GraphsApi {
  constructor(private readonly client: ApiClient) {}

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

  /** Rename a graph. PATCH is optimistically locked like bulk-save — save_version is mandatory. */
  async rename(graphId: number, name: string, saveVersion: number): Promise<GraphDto> {
    return this.patch(graphId, { name, save_version: saveVersion });
  }

  /** PATCH graphs/{id}/ — only the writable graph metadata; the read-only authorship is never sent. */
  async patch(graphId: number, request: PatchGraphDtoRequest): Promise<GraphDto> {
    return this.client.patch(`graphs/${graphId}/`, { body: request });
  }

  /** Moves the flow to the recycle bin (restorable until purged). */
  async delete(graphId: number): Promise<void> {
    await this.client.delete(`graphs/${graphId}/`);
  }

  /** `copyGraph`: a new flow with the source's nodes and edges, under `name`. */
  async copy(graphId: number, name: string): Promise<GraphDto> {
    return this.client.post(`graphs/${graphId}/copy/`, { body: { name } });
  }

  /** `getSubflowUsage`: the flows that embed this one as a subflow. */
  async subflowUsage(graphId: number): Promise<{ parent_flow_ids: number[] }> {
    return this.client.get(`graphs/${graphId}/subflow-usage/`);
  }

  /**
   * Org-level persistent variables of every flow in the active org (`graph-organizations/`,
   * read-only — GraphOrganizationViewSet; the frontend does not call it). One row per flow.
   */
  async listOrganizationStates(): Promise<GraphOrganizationState[]> {
    return unwrap(
      await this.client.get<Paginated<GraphOrganizationState> | GraphOrganizationState[]>('graph-organizations/', {
        query: { limit: 1000 },
      }),
    );
  }

  /**
   * Per-user persistent variables (`graph-organization-users/`, read-only —
   * GraphOrganizationUserViewSet). One row per (flow, organization member).
   */
  async listOrganizationUserStates(): Promise<GraphOrganizationUserState[]> {
    return unwrap(
      await this.client.get<Paginated<GraphOrganizationUserState> | GraphOrganizationUserState[]>(
        'graph-organization-users/',
        { query: { limit: 1000 } },
      ),
    );
  }
}

/** GraphOrganizationSerializer: a flow's org-scoped persistent state. */
export interface GraphOrganizationState {
  id: number;
  graph: number;
  /** Values of the flow's `persistent_variables.organization` variables, carried across sessions. */
  persistent_variables: Record<string, unknown>;
  /** Seed template copied into each user's row. */
  user_variables: Record<string, unknown>;
}

/** GraphOrganizationUserSerializer: one member's persistent state for one flow. */
export interface GraphOrganizationUserState {
  id: number;
  graph: number;
  /** The rbac OrganizationUser (membership) id. */
  organization_user: number;
  /** Values of the flow's `persistent_variables.user` variables for this member. */
  persistent_variables: Record<string, unknown>;
}
