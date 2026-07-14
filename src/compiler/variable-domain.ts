/**
 * The flow's **variable domain** — the authoritative set of top-level variables the
 * start node seeds into flow state.
 *
 * Backend contract (`src/django_app/.../graph_serializers.py` GraphOrganizationSerializer):
 * `start_node.variables` IS the flow's variable domain. Every `user_variables` /
 * `persistent_variables` key a caller supplies must already exist in it, or the backend
 * rejects the request ("Variable `<key>` is not in domain"). A variable a node only ever
 * *produces* via `output_variable_path` is still part of that domain — it exists in state
 * once the producer runs — so it must appear in `start_node.variables` too.
 *
 * Declaration in the `variables:` section is optional and authors routinely rely on
 * `output_variable_path` alone, which would otherwise leave the emitted domain missing
 * those names. This module closes that gap: it force-completes the domain from what the
 * flow actually produces, so the emitted start node never under-declares.
 */
import type { FlowSource } from '../flow-source/schema/index.js';
import { declarationDefault } from '../flow-source/schema/variables.js';
import { isVarPathError, parseVarPath } from './varpath.js';

/**
 * Top-level variable names written by any node's `output_variable_path`
 * (e.g. `variables.quote.total` → `quote`). Cross-session `variables.shared[...]`
 * writes and malformed paths carry no top-level name and are skipped — malformed
 * paths are reported separately by the dataflow validator.
 */
export function producedTopLevelNames(source: FlowSource): string[] {
  const names = new Set<string>();
  for (const node of Object.values(source.flow.nodes)) {
    const writePath = (node as { output_variable_path?: unknown }).output_variable_path;
    if (typeof writePath !== 'string' || writePath.trim() === '') continue;
    const parsed = parseVarPath(writePath);
    if (isVarPathError(parsed) || parsed.isShared) continue;
    const [root] = parsed.segments;
    if (root !== undefined) names.add(root);
  }
  return [...names];
}

/**
 * EpicStaff convention: every flow's variable domain carries `context`. The native
 * editor seeds it into every start node, it is the default node output slot
 * (`output_map` defaults to `{context: 'variables.context'}`), and downstream reads of
 * `variables.context` assume its presence. The backend does not *require* it (a missing
 * `context` fail-softs to `'not found'`), but emitting it keeps compiler-built flows
 * consistent with natively-authored ones. It is the lowest-precedence seed — a
 * declaration, an inline initial value, or a producer of `context` all override it.
 */
export const CONVENTIONAL_DOMAIN_VARIABLES: Readonly<Record<string, unknown>> = { context: null };

/**
 * The complete `variables` object seeded into the start node. Precedence, lowest to
 * highest:
 *  0. conventional variables (`context`) — always present, freely overridden;
 *  1. produced top-level variables — seeded `null` (a producer overwrites them before
 *     any legal read; the dataflow validator guarantees no read precedes production on a
 *     reaching path, so this placeholder is never observed in a clean-building flow);
 *  2. declared `variables:` defaults — an intentional default wins over the placeholder;
 *  3. inline `start.initial_state` — has the final say.
 */
export function buildStartVariableDomain(
  source: FlowSource,
  startInitialState: Record<string, unknown>,
): Record<string, unknown> {
  const domain: Record<string, unknown> = { ...CONVENTIONAL_DOMAIN_VARIABLES };
  for (const name of producedTopLevelNames(source)) {
    domain[name] = null;
  }
  for (const [name, declaration] of Object.entries(source.variables ?? {})) {
    domain[name] = declarationDefault(declaration);
  }
  Object.assign(domain, startInitialState);
  return domain;
}

/**
 * The full value persisted to `start_node.variables`, in EpicStaff's native **wrapped**
 * scheme. The native editor stores the domain under a `variables` key and pairs it with a
 * `persistent_variables` map of `{user, organization}` path lists (the buckets that mark
 * which domain variables persist per-user or per-org — read by the backend
 * `PersistentVariablesService`). The runtime accepts a flat domain too (via
 * `session_manager._get_actual_variables`, which falls back to the whole object), but
 * emitting the wrapped envelope keeps compiler-built flows scheme-identical to native
 * ones and gives them the persistence buckets. `variables_constants.py`:
 * DOMAIN_VARIABLES_KEY="variables", DOMAIN_PERSISTENT_KEY="persistent_variables",
 * DOMAIN_USER_KEY="user", DOMAIN_ORGANIZATION_KEY="organization".
 */
export function buildStartNodeVariables(
  source: FlowSource,
  startInitialState: Record<string, unknown>,
): Record<string, unknown> {
  return {
    variables: buildStartVariableDomain(source, startInitialState),
    persistent_variables: { user: [], organization: [] },
  };
}
