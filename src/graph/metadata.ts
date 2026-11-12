/** Ported from frontend `visual-programming/utils/save/metadata.ts`. */

import type { NodeDtoMetadata } from '../models/graph.js';
import type { GraphNoteMetadataWrite } from '../models/nodes/note-node.js';
import type { GraphNodeBase, NoteGraphNode } from './graph-state.js';

/** Colour, icon and size come from frontend constants, so only the position is persisted. */
export function toNodeMetadata(node: GraphNodeBase): NodeDtoMetadata {
  return { position: node.position };
}

/** A note is user-resizable and user-coloured, so unlike other nodes it persists both. */
export function toNoteMetadata(node: NoteGraphNode): GraphNoteMetadataWrite {
  return {
    ...toNodeMetadata(node),
    size: node.size,
    backgroundColor: node.data.backgroundColor ?? null,
    fontSize: node.data.fontSize ?? null,
    linkedRegion: node.data.linkedRegion ?? null,
  };
}
