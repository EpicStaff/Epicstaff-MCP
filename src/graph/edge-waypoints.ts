/** Ported from frontend `visual-programming/utils/save/edge-waypoints.helpers.ts`. */

import type { GraphEdgeState, GraphPoint } from './graph-state.js';

export function hasPersistedWaypoints(edge: GraphEdgeState): boolean {
  return edge.userAdjustedWaypoints === true && (edge.waypoints?.length ?? 0) > 0;
}

export function waypointsChanged(previous: GraphPoint[] | undefined, current: GraphPoint[] | undefined): boolean {
  if ((previous?.length ?? 0) !== (current?.length ?? 0)) return true;
  return JSON.stringify(previous ?? []) !== JSON.stringify(current ?? []);
}

export function mergeWaypointsIntoMetadata(
  existingMetadata: Record<string, unknown>,
  waypoints: GraphPoint[]
): Record<string, unknown> {
  return { ...existingMetadata, waypoints };
}
