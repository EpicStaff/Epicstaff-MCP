import { z } from 'zod';

/**
 * `variables:` section — declares the flow's state variables (names + initial values).
 *
 * EpicStaff's flow state is an untyped `DotDict`, so declarations are **names-only**:
 * there is no type to enforce. A declaration exists to (a) seed an initial value into
 * the start node's state and (b) give the dataflow validator an authoritative set of
 * "always-available" variables so a read that nothing produces isn't a false error.
 *
 * A declaration is either a bare value (used directly as the default) or an object with
 * an explicit `default` plus an optional `description`:
 *
 *   variables:
 *     topic: "AI agents"                 # bare value → default
 *     retries: 0
 *     escalation_id: { default: "", description: "Set on the urgent branch only." }
 *     org_config: { default: {}, persist: organization }   # persists across sessions
 *
 * `persist` marks a variable's value to be carried across sessions: `user` snapshots it
 * per organization-user, `organization` per organization. The compiler records the name
 * in the start node's `persistent_variables.{user,organization}` bucket; the backend
 * `PersistentVariablesService` seeds it from the previous ended session on the next run.
 */
export const variableDeclarationSchema = z.union([
  z
    .strictObject({
      default: z.unknown().describe('Initial value seeded into the flow state.'),
      description: z.string().optional().describe('What this variable holds.'),
      persist: z
        .enum(['user', 'organization'])
        .optional()
        .describe(
          'Carry this variable across sessions: "user" (per organization-user) or ' +
            '"organization" (per organization). Omit for a session-scoped variable.',
        ),
    })
    .describe('Explicit variable declaration.'),
  // Any bare JSON value is taken as the default. Kept last so the object form wins first.
  z.unknown().describe('Bare value — used directly as the variable default.'),
]);

export type VariableDeclarationSource = z.infer<typeof variableDeclarationSchema>;

export const variablesSectionSchema = z
  .record(z.string(), variableDeclarationSchema)
  .default({})
  .describe(
    'Flow state variables, keyed by name. Declaring is optional (open model) — any node ' +
      "output_variable_path also counts as producing a variable. Declared variables are seeded " +
      'into the start node and are treated as available everywhere by the dataflow validator.',
  );

export type VariablesSectionSource = z.infer<typeof variablesSectionSchema>;

/** The default value a declaration seeds into the start-node state. */
export function declarationDefault(declaration: VariableDeclarationSource): unknown {
  if (
    typeof declaration === 'object' &&
    declaration !== null &&
    !Array.isArray(declaration) &&
    'default' in declaration
  ) {
    return (declaration as { default: unknown }).default;
  }
  return declaration;
}

/** The persistence bucket a declaration opts into, or undefined for session-scoped. */
export function declarationPersist(
  declaration: VariableDeclarationSource,
): 'user' | 'organization' | undefined {
  if (
    typeof declaration === 'object' &&
    declaration !== null &&
    !Array.isArray(declaration) &&
    'persist' in declaration
  ) {
    return (declaration as { persist?: 'user' | 'organization' }).persist;
  }
  return undefined;
}
