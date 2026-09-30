/**
 * Graph-level wire DTOs and the bulk-save payload type.
 *
 * Ported from the EpicStaff frontend:
 * - features/flows/models/graph.model.ts               (GraphDto, CreateGraphDtoRequest, UpdateGraphDtoRequest)
 * - visual-programming/core/models/node-metadata.model.ts (NodeDtoMetadata)
 * - visual-programming/utils/save/payload.ts            (bulk-save body shape)
 *
 * Intentionally excluded node types (never emitted by this module):
 * - llm_node_list        — legacy
 * - code_agent_node_list — deprecated
 * Their `deleted` id-list keys are kept (always empty) so the wire body shape
 * matches what the backend receives from the frontend byte-for-byte.
 */
export {};
