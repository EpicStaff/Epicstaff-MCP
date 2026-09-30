import { resolve as resolvePath } from 'node:path';

import { GraphsApi } from '../api/graphs.js';
import { type BuildArtifact, collectRefs } from '../compiler/artifact.js';
import type { AppContext } from '../context.js';
import { readLock } from '../flow-source/lockfile.js';
import type { GetGraphLightRequest } from '../models/graph.js';
import { logger } from '../util/logger.js';

/**
 * Subgraph flow-reference resolver.
 *
 * Every other graph ref is backed by an EntityPlan, so the entity pusher's idMap
 * already carries it by the time the graph is pushed. Subgraph refs are the one
 * exception — `compiler/emit.ts` emits `{$ref: "flows.…"}` with no plan, because a
 * subgraph always points at a graph that ALREADY exists on the backend. Nothing is
 * created or pushed here; this only looks up ids so `GraphPusher` can substitute them.
 *
 * Two ref forms, matching the two ways flow source can name a subgraph:
 *   `flows.existing:<remote graph name>` → matched by name against `graph-light/`
 *   `flows.<sibling flow dir name>`      → that sibling's `flow.lock.json` graphId
 */
const FLOWS_PREFIX = 'flows.';
const EXISTING_PREFIX = 'existing:';

/** Returns ref key → backend graph id for every `flows.*` ref in the artifact's graph. */
export async function resolveFlowRefs(
  artifact: BuildArtifact,
  flowDir: string,
  context: AppContext,
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();

  const flowKeys = [...collectRefs(artifact.graph)].filter((key) => key.startsWith(FLOWS_PREFIX));
  if (flowKeys.length === 0) return resolved;

  const graphs = new GraphsApi(context.client);
  let remoteGraphs: GetGraphLightRequest[] | null = null;

  for (const key of flowKeys) {
    const target = key.slice(FLOWS_PREFIX.length);

    if (target.startsWith(EXISTING_PREFIX)) {
      const remoteName = target.slice(EXISTING_PREFIX.length);
      // One list call serves every existing: ref in the flow.
      remoteGraphs ??= await graphs.listLight();
      const matches = remoteGraphs.filter((graph) => graph.name === remoteName);
      if (matches.length === 0) {
        const available = remoteGraphs.map((graph) => `"${graph.name}"`).join(', ');
        throw new Error(
          `Subgraph node references graph { existing: "${remoteName}" }, which does not exist in this ` +
            `organization. Available graphs: ${available || '(none)'}.`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Subgraph node references graph { existing: "${remoteName}" }, but ${matches.length} graphs share ` +
            `that name (ids ${matches.map((graph) => graph.id).join(', ')}). Rename one, or reference the ` +
            `sibling flow directory instead.`,
        );
      }
      resolved.set(key, matches[0]!.id);
      logger.info(`Subgraph ref { existing: "${remoteName}" } → graph #${matches[0]!.id}`);
      continue;
    }

    // Sibling flow directory, resolved next to the flow being pushed.
    const siblingDir = resolvePath(flowDir, '..', target);
    const siblingLock = await readLock(siblingDir);
    if (!siblingLock) {
      throw new Error(
        `Subgraph node references sibling flow "${target}", but no flow.lock.json was found at ` +
          `${siblingDir}. Push that flow first, or reference the remote graph with ` +
          `{ existing: "<graph name>" }.`,
      );
    }
    if (siblingLock.graphId === null) {
      throw new Error(
        `Subgraph node references sibling flow "${target}", but its flow.lock.json has no graphId — ` +
          `it has never been pushed. Push ${siblingDir} first.`,
      );
    }
    resolved.set(key, siblingLock.graphId);
    logger.info(`Subgraph ref "${target}" → graph #${siblingLock.graphId}`);
  }

  return resolved;
}
