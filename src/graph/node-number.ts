/** Ported from frontend `visual-programming/core/helpers/node-number.util.ts`. */

import type { GraphNodeType } from './graph-state.js';

/** Node types the backend never numbers: they carry no #N badge. */
const UNNUMBERED_NODE_TYPES: ReadonlySet<GraphNodeType> = new Set<GraphNodeType>(['start', 'end', 'note']);

/** Whether nodes of `type` get a number from the graph's counter. */
export function isNumberedNodeType(type: GraphNodeType): boolean {
  return !UNNUMBERED_NODE_TYPES.has(type);
}
