/** Ported from frontend `visual-programming/utils/save/metadata.ts`. */
export function toNodeMetadata(node) {
    return {
        position: node.position,
        color: node.color,
        icon: node.icon,
        size: node.size,
        ...(node.nodeNumber != null ? { nodeNumber: node.nodeNumber } : {}),
    };
}
