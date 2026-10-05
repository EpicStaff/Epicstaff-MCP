/** Ported from frontend `pages/flows-page/components/flow-visual-programming/models/subgraph-node.model.ts` + bulk-save emission in `visual-programming/utils/save/payload.ts`. */

import type { GetGraphLightRequest, NodeDtoMetadata } from '../graph.js';

export interface SubGraphNodeDto {
  id: number;
  node_name: string;
  graph: number;
  /** Null when the referenced flow was deleted (`on_delete=SET_NULL`). */
  subgraph: number | null;
  /** Nested light graph object (populated by backend serializer). */
  subgraph_detail?: GetGraphLightRequest;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  metadata: Record<string, unknown>;
}

export interface SubGraphNodeWrite {
  node_name: string;
  graph: number;
  subgraph: number | null;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  metadata: NodeDtoMetadata;
}
