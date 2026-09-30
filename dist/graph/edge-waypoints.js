/** Ported from frontend `visual-programming/utils/save/edge-waypoints.helpers.ts`. */
export function hasPersistedWaypoints(edge) {
    return edge.userAdjustedWaypoints === true && (edge.waypoints?.length ?? 0) > 0;
}
export function waypointsChanged(previous, current) {
    if ((previous?.length ?? 0) !== (current?.length ?? 0))
        return true;
    return JSON.stringify(previous ?? []) !== JSON.stringify(current ?? []);
}
export function mergeWaypointsIntoMetadata(existingMetadata, waypoints) {
    return { ...existingMetadata, waypoints };
}
