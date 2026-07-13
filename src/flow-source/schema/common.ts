/**
 * Shared building blocks for all flow-source section schemas:
 * symbolic names, entity references (local name or `{existing: ...}`),
 * position pins and input maps.
 */
import { z } from 'zod';

/** Symbolic names key every entity in a flow source and are used for cross-references. */
export const SYMBOLIC_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const symbolicNameSchema = z
  .string()
  .regex(
    SYMBOLIC_NAME_PATTERN,
    'symbolic names must start with a letter or underscore and may contain only letters, digits, underscores and dashes',
  )
  .describe(
    'Symbolic name of an entity defined in this flow source (a key of the corresponding section).',
  );

/** Reference to an entity that already exists on the EpicStaff backend. */
export const existingRefSchema = z.strictObject({
  existing: z
    .string()
    .min(1)
    .describe(
      'Name of an entity that already exists on the EpicStaff backend. It is reused as-is instead of being created from this flow source.',
    ),
});

export type ExistingRef = z.infer<typeof existingRefSchema>;

/**
 * Every cross-reference position accepts either a local symbolic name (a key in
 * the target section of this flow source) or `{existing: "<remote name>"}` to
 * reuse an entity that already exists on the backend.
 */
export type EntityRef = string | ExistingRef;

export const entityRefSchema: z.ZodType<EntityRef> = z.union([
  symbolicNameSchema,
  existingRefSchema,
]);

/** Build a described entity-reference schema for one reference position. */
export function entityRef(description: string): z.ZodType<EntityRef> {
  return z
    .union([symbolicNameSchema, existingRefSchema])
    .describe(`${description} Either a local symbolic name or {existing: "<remote name>"}.`);
}

/**
 * Flow source carries no layout coordinates — layout is computed at build time.
 * A node may optionally pin its position with this override.
 */
export const positionSchema = z
  .strictObject({
    x: z.number().describe('Canvas x coordinate.'),
    y: z.number().describe('Canvas y coordinate.'),
  })
  .describe(
    'Optional canvas position pin. Layout is normally computed automatically; set this only to pin one node in place.',
  );

export type NodePosition = z.infer<typeof positionSchema>;

export const inputMapSchema = z
  .record(z.string(), z.string())
  .describe(
    'Maps this node\'s named inputs to flow-state variable paths, e.g. { "query": "variables.user_query" }.',
  );
