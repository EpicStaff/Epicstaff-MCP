/** Ported from frontend `visual-programming/utils/save/metadata.ts`. */

import type { NodeDtoMetadata } from '../models/graph.js';
import type { GraphNodeBase } from './graph-state.js';

export function toNodeMetadata(node: GraphNodeBase): NodeDtoMetadata {
  return {
    position: node.position,
    color: node.color,
    icon: node.icon,
    size: node.size,
    ...(node.nodeNumber != null ? { nodeNumber: node.nodeNumber } : {}),
  };
}
