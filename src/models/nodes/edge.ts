/** Ported from frontend `models/edge.model.ts` + the edge emission in `utils/save/payload.ts`. */

export interface EdgeDto {
  id: number;
  start_node_id: number;
  end_node_id: number;
  graph: number;
  metadata: Record<string, unknown>;
}

/**
 * Edge item created via bulk-save. Endpoints reference either a persisted node
 * (`*_node_id`) or a node being created in the same payload (`*_temp_id`).
 * `metadata` is present only when the edge has user-adjusted waypoints.
 */
export interface BulkEdgeCreate {
  graph: number;
  start_node_id?: number;
  start_temp_id?: string;
  end_node_id?: number;
  end_temp_id?: string;
  metadata?: Record<string, unknown>;
}

/** Edge item updated via bulk-save (waypoint changes) — always carries merged metadata. */
export interface BulkEdgeUpdate {
  id: number;
  graph: number;
  start_node_id?: number;
  start_temp_id?: string;
  end_node_id?: number;
  end_temp_id?: string;
  metadata: Record<string, unknown>;
}
