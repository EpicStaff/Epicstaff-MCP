/**
 * Client-side graph state — the input model for the bulk-save payload builder.
 *
 * Mirrors the EpicStaff frontend canvas model (`visual-programming/core/models/node.model.ts`
 * + `connection.model.ts`) closely enough that `buildBulkSavePayload` is a mechanical
 * port of `utils/save/{diff,payload}.ts`.
 *
 * Node `id` is a client-minted uuid (see `mintTempId`); `backendId` is the persisted
 * primary key (`null` for nodes not yet saved).
 */
export {};
