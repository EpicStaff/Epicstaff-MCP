/** Ported from frontend `models/end-node.model.ts` + bulk-save emission in `utils/save/payload.ts`. */

import type { NodeDtoMetadata } from '../graph.js';

export interface EndNodeDto {
  id: number;
  graph: number;
  output_map: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /** Added by the serializer (always "__end_node__" but may vary in UI). */
  node_name?: string;
}

/** Bulk-save item body for an end node (no `node_name` on the wire). */
export interface EndNodeWrite {
  graph: number;
  output_map: Record<string, unknown>;
  metadata: NodeDtoMetadata;
}
