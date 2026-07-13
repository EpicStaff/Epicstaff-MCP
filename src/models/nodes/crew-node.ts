/**
 * Crew (project) node — deprecated but still supported by the bulk-save protocol.
 * Ported from frontend `models/crew-node.model.ts` + bulk-save emission in `utils/save/payload.ts`.
 */

import type { NodeDtoMetadata } from '../graph.js';

export interface CrewNodeDto {
  id: number;
  node_name: string;
  graph: number;
  /** Nested project object populated by the backend serializer. */
  crew: unknown;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  stream_config?: Record<string, boolean>;
  metadata: Record<string, unknown>;
}

export interface CrewNodeWrite {
  node_name: string;
  graph: number;
  crew_id: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  stream_config: Record<string, boolean>;
  metadata: NodeDtoMetadata;
}
