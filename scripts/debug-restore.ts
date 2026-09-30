/**
 * Debug CLI for restore_graph: `npm run debug:restore -- <dump.json> [--post <graphId>]`
 *
 * Builds the exact bulk-save payload restore_graph would send, prints its shape, and
 * (with --post) sends it to an existing empty graph so the backend's validation errors
 * are visible in full. Read-only unless --post is given.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GraphsApi } from '../src/api/graphs.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { buildBulkSavePayload } from '../src/graph/bulk-save.js';
import { prepareRestoreState } from '../src/pusher/restore.js';
import { ApiError } from '../src/http/errors.js';
import type { GraphDto } from '../src/models/graph.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dumpPath = args.find((a) => !a.startsWith('--'));
  const postIndex = args.indexOf('--post');
  const postGraphId = postIndex >= 0 ? Number(args[postIndex + 1]) : null;
  if (!dumpPath) {
    process.stderr.write('usage: npm run debug:restore -- <dump.json> [--post <graphId>]\n');
    process.exit(2);
  }

  const dto = JSON.parse(readFileSync(resolve(dumpPath), 'utf8')) as GraphDto;
  const { state, detached, remappedUuids, warnings } = prepareRestoreState(dto);
  const detachedPythonCode = detached.python_code_rows;
  const detachedAgentTasks = detached.agent_tasks;
  if (warnings.length) console.log('warnings:', warnings.join(' | '));
  console.log('remapped uuids:', remappedUuids);

  console.log(`source: "${dto.name}" (graph ${dto.id}) save_version ${dto.save_version}`);
  console.log(`state: ${state.nodes.length} nodes, ${state.edges.length} edges`);
  console.log(`detached: python_code=${detachedPythonCode} agent_tasks=${detachedAgentTasks}`);

  const payload = buildBulkSavePayload({
    graphId: postGraphId ?? 0,
    desired: state,
    remote: { nodes: [], edges: [] },
    saveVersion: 1,
  }) as unknown as Record<string, unknown>;

  console.log('\n=== payload top-level keys ===');
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      if (value.length > 0) console.log(`  ${key}: ${value.length}`);
    } else if (key === 'deleted') {
      const nonEmpty = Object.entries(value as Record<string, number[]>).filter(([, v]) => v.length > 0);
      console.log(`  deleted: ${nonEmpty.length === 0 ? '(all empty)' : JSON.stringify(Object.fromEntries(nonEmpty))}`);
    } else {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    }
  }

  // Show one representative item per populated node list, so field shape is visible.
  console.log('\n=== first item of each populated node list ===');
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith('_list') && Array.isArray(value) && value.length > 0) {
      const sample = JSON.stringify(value[0]);
      console.log(`  ${key}[0]: ${sample.length > 700 ? `${sample.slice(0, 700)}…` : sample}`);
    }
  }

  if (postGraphId == null) {
    console.log('\n(dry run — pass --post <graphId> to send it and see backend validation errors)');
    return;
  }

  const context = createContext(loadConfig());
  await context.auth.ensureAuthenticated();
  const graphs = new GraphsApi(context.client);
  const remote = await graphs.get(postGraphId);
  console.log(`\nposting to graph ${postGraphId} ("${remote.name}") save_version ${remote.save_version}`);

  const live = buildBulkSavePayload({
    graphId: postGraphId,
    desired: state,
    remote: { nodes: [], edges: [] },
    saveVersion: remote.save_version,
  });

  try {
    const saved = await graphs.bulkSave(postGraphId, live);
    console.log(`OK — save_version ${saved.save_version}`);
  } catch (error) {
    if (error instanceof ApiError) {
      console.log(`\nHTTP ${error.status} ${error.url}`);
      console.log(`message: ${error.message}`);
      if (error.validationErrors) console.log(`validationErrors:\n${JSON.stringify(error.validationErrors, null, 2)}`);
      if (error.bodyExcerpt) console.log(`bodyExcerpt:\n${error.bodyExcerpt}`);
    } else {
      console.log(`non-API error: ${error instanceof Error ? error.stack : String(error)}`);
    }
    process.exit(1);
  }
}

void main();
