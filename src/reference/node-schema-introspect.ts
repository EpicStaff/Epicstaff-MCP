/**
 * Derives the per-node field catalog directly from the authoring zod schema
 * (`src/flow-source/schema/flow.ts`). Because the field list comes from the schema
 * itself, it can never drift from what the loader actually accepts — the schema is
 * the single source of truth for mechanical field info. Human prose and runtime
 * caveats live separately in `node-reference.ts`.
 */
import type { z } from 'zod';

import { FORBIDDEN_NODE_TYPES, nodeSchema, type FlowNodeType } from '../flow-source/schema/flow.js';

export interface NodeField {
  name: string;
  description: string;
  required: boolean;
}

export interface NodeSchemaInfo {
  type: FlowNodeType;
  deprecated: boolean;
  fields: NodeField[];
}

/** Fields present on every node that carry no authoring signal. */
const OMITTED_FIELDS = new Set(['type', 'position']);
const FORBIDDEN = new Set<string>(FORBIDDEN_NODE_TYPES);

/** Walk the discriminated union and extract each writable node type's fields. */
export function introspectNodeSchemas(): NodeSchemaInfo[] {
  const options = nodeSchema.options as unknown as z.AnyZodObject[];
  const result: NodeSchemaInfo[] = [];

  for (const option of options) {
    const shape = option.shape as Record<string, z.ZodTypeAny>;
    const typeName = (shape.type as z.ZodLiteral<string>)._def.value;
    if (FORBIDDEN.has(typeName)) {
      continue; // llm / code-agent are never valid — omit from the catalog entirely
    }

    const fields: NodeField[] = [];
    for (const [name, field] of Object.entries(shape)) {
      if (OMITTED_FIELDS.has(name)) {
        continue;
      }
      fields.push({
        name,
        description: field.description ?? '',
        required: !field.isOptional(),
      });
    }

    result.push({ type: typeName as FlowNodeType, deprecated: typeName === 'crew', fields });
  }

  return result;
}
