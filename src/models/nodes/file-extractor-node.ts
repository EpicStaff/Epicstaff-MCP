/** Ported from frontend `models/file-extractor.model.ts` + bulk-save emission in `utils/save/payload.ts`. */

import type { NodeDtoMetadata } from '../graph.js';

export interface FileExtractorNodeDto {
  id: number;
  node_name: string;
  graph: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  metadata: Record<string, unknown>;
}

export interface FileExtractorNodeWrite {
  node_name: string;
  graph: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  metadata: NodeDtoMetadata;
}
