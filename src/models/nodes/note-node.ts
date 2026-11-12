/** GraphNote. Ported from frontend `visual-programming/core/models/graph-note.model.ts` + bulk-save emission in `visual-programming/utils/save/payload.ts`. */

import type { AuthorshipFields } from '../authorship.js';
import type { NodeDtoMetadata } from '../graph.js';

export interface GraphNoteDto extends AuthorshipFields {
  id: number;
  created_at: string;
  node_name: string;
  graph: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface NoteLinkedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A note is user-resizable and user-styled, so unlike other nodes it persists more than its position. */
export type GraphNoteMetadataWrite = NodeDtoMetadata & {
  size: { width: number; height: number };
  backgroundColor: string | null;
  fontSize: number | null;
  linkedRegion: NoteLinkedRegion | null;
};

export interface GraphNoteWrite {
  node_name: string;
  graph: number;
  content: string;
  metadata: GraphNoteMetadataWrite;
}
