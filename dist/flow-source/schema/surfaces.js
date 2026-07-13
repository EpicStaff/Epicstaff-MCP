/**
 * `surfaces` section — named resource bundles (tools + storage files + knowledge
 * collections + instructions) attached to agents and flow nodes.
 *
 * Two families share the same body shape:
 *  - catalog surfaces (this section): named, reusable, optionally agent-owned;
 *  - inline surfaces (on agent/task nodes): same body, no name, no owner.
 */
import { z } from 'zod';
import { entityRef, entityRefSchema, existingRefSchema, symbolicNameSchema, } from './common.js';
export const toolModeSchema = z
    .enum(['allow', 'deny'])
    .describe('Tool permission: "deny" always wins over "allow" when surfaces are combined.');
const surfaceToolObjectSchema = z.strictObject({
    tool: entityRef('The tool this entry grants or denies.'),
    mode: toolModeSchema.default('allow'),
});
/** A tool entry: bare reference shorthand (mode "allow") or `{tool, mode}`. */
const surfaceToolEntrySchema = z
    .union([
    symbolicNameSchema.transform((name) => ({ tool: name, mode: 'allow' })),
    existingRefSchema.transform((ref) => ({ tool: ref, mode: 'allow' })),
    surfaceToolObjectSchema,
])
    .describe('A tool grant. Shorthand: a bare reference means {tool: <ref>, mode: "allow"}. Use {tool, mode: "deny"} to hard-deny.');
export const storageAccessSchema = z
    .enum(['allow', 'unset', 'deny'])
    .describe('Tri-state storage permission. When surfaces are combined: deny > allow > unset.');
export const surfaceStorageItemSchema = z
    .strictObject({
    file: z
        .string()
        .min(1)
        .describe('Remote storage file or folder path, e.g. "reports/summary.md". Resolved against org storage at push time.'),
    can_list: storageAccessSchema.default('unset'),
    can_view: storageAccessSchema.default('unset'),
    can_edit: storageAccessSchema.default('unset'),
    can_delete: storageAccessSchema.default('unset'),
})
    .describe('Per-file storage permissions (tri-state per operation).');
const surfaceKnowledgeObjectSchema = z
    .strictObject({
    collection: entityRef('The knowledge collection this surface exposes.'),
    naive_config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Naive-search overrides for this surface (passed through). Collection must have naive RAG.'),
    graph_basic_config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Graph basic-search overrides (passed through). Collection must have graph RAG.'),
    graph_local_search_config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Graph local-search overrides (passed through). Collection must have graph RAG.'),
})
    .superRefine((entry, ctx) => {
    const configCount = [
        entry.naive_config,
        entry.graph_basic_config,
        entry.graph_local_search_config,
    ].filter((config) => config !== undefined).length;
    if (configCount > 1) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'at most one of naive_config / graph_basic_config / graph_local_search_config may be set',
        });
    }
});
/** A knowledge entry: bare collection reference shorthand, or an object with a search-config override. */
const surfaceKnowledgeEntrySchema = z
    .union([
    symbolicNameSchema.transform((name) => ({ collection: name })),
    existingRefSchema.transform((ref) => ({ collection: ref })),
    surfaceKnowledgeObjectSchema,
])
    .describe('A knowledge grant. Shorthand: a bare reference exposes the collection with its default search config.');
/** Shared body of catalog and inline surfaces. */
const surfaceBodyShape = {
    description: z.string().optional().describe('What this surface bundles and why.'),
    instructions: z
        .string()
        .default('')
        .describe('Extra instructions injected into the agent when this surface is attached.'),
    python_tools: z
        .array(surfaceToolEntrySchema)
        .default([])
        .describe('Python tool grants (references into tools.python_code_tools or existing remote tools).'),
    mcp_tools: z
        .array(surfaceToolEntrySchema)
        .default([])
        .describe('MCP tool grants (references into tools.mcp_tools or existing remote tools).'),
    storage: z
        .array(surfaceStorageItemSchema)
        .default([])
        .describe('Storage file permissions (tri-state per operation, per file).'),
    knowledge: z
        .array(surfaceKnowledgeEntrySchema)
        .default([])
        .describe('Knowledge collections exposed by this surface.'),
};
/** Inline surface: embedded in a node, same shape as a catalog surface minus name/sharing. */
export const inlineSurfaceSchema = z
    .strictObject(surfaceBodyShape)
    .describe('Ad-hoc surface embedded in a node. Same shape as a catalog surface but unnamed, not shareable, and deleted with the node.');
/** Catalog surface: named (by map key), reusable, optionally owned by one agent. */
export const catalogSurfaceSchema = z
    .strictObject({
    ...surfaceBodyShape,
    owner_agent: entityRefSchema
        .optional()
        .describe('When set, this surface is agent-specific: only the owning agent may attach it. Omit for a shared surface.'),
})
    .describe('One named catalog surface.');
export const surfacesSectionSchema = z
    .record(symbolicNameSchema, catalogSurfaceSchema)
    .default({})
    .describe('Catalog surfaces, keyed by symbolic name.');
