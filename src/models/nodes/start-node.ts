/** Ported from frontend `pages/flows-page/components/flow-visual-programming/models/start-node.model.ts` + bulk-save emission in `visual-programming/utils/save/payload.ts`. */

import type { NodeDtoMetadata } from '../graph.js';

export interface StartNodeDto {
  id: number;
  graph: number;
  node_name: string;
  variables: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** Bulk-save item body for a start node (no `node_name` on the wire). */
export interface StartNodeWrite {
  graph: number;
  variables: Record<string, unknown>;
  metadata: NodeDtoMetadata;
}
