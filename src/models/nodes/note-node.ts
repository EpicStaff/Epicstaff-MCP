/** GraphNote. Ported from frontend `models/graph-note.model.ts` + bulk-save emission in `utils/save/payload.ts`. */

import type { NodeDtoMetadata } from '../graph.js';

export interface GraphNoteDto {
  id: number;
  node_name: string;
  graph: number;
  content: string;
  metadata: Record<string, unknown>;
}

/** Note metadata carries the note's background color alongside the standard node metadata. */
export type GraphNoteMetadataWrite = NodeDtoMetadata & { backgroundColor: string | null };

export interface GraphNoteWrite {
  node_name: string;
  graph: number;
  content: string;
  metadata: GraphNoteMetadataWrite;
}
