/**
 * API parity check: `npm run parity-check -- <epicstaff-checkout> [--allowlist <file>] [--json] [--strict]`.
 *
 * Lists every EpicStaff API route (Django `router.register` / `path()` under `api/`) and graph node
 * list (`NODE_TYPE_REGISTRY` + crew `GraphData`) of the checkout, and diffs them against the API paths
 * this tree's `src/` sends and the node lists push_flow emits (`BulkSavePayload`). Whatever MCP does not
 * cover must be named in the allowlist (default `scripts/parity-allowlist.json`) with a reason.
 *
 * Exit 0: no unallowlisted gap. Exit 1: a route or node list is neither covered nor allowlisted (or,
 * with --strict, an allowlist entry is stale). Exit 2: bad arguments or an unreadable checkout.
 * Reads the checkout's files only — nothing of it is imported or executed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  collectMcpApiPaths,
  collectMcpNodeLists,
  collectUpstreamNodeLists,
  collectUpstreamRoutes,
  isAllowlist,
} from './parity-check-lib.js';

const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const allowlistIndex = args.indexOf('--allowlist');
  const allowlistPath =
    allowlistIndex === -1 ? join(mcpRoot, 'scripts', 'parity-allowlist.json') : resolve(args[allowlistIndex + 1] ?? '');
  const checkoutArg = args.find(
    (arg, index) => !arg.startsWith('--') && (allowlistIndex === -1 || index !== allowlistIndex + 1),
  );
  if (checkoutArg === undefined) {
    fail('usage: npm run parity-check -- <epicstaff-checkout> [--allowlist <file>] [--json] [--strict]');
  }
  const checkout = resolve(checkoutArg);
  if (!existsSync(join(checkout, 'src', 'django_app', 'django_app', 'urls.py'))) {
    fail(`${checkout} is not an EpicStaff checkout (src/django_app/django_app/urls.py is missing).`);
  }
  if (!existsSync(allowlistPath)) fail(`Allowlist not found: ${allowlistPath}`);
  const allowlist: unknown = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  if (!isAllowlist(allowlist)) {
    fail(`${allowlistPath}: expected { routes: [{ pattern, category, reason }], nodeLists?: [{ name, reason }] }.`);
  }

  const { routes, unresolvedModules } = collectUpstreamRoutes(checkout);
  const upstreamNodeLists = collectUpstreamNodeLists(checkout);
  if (routes.length === 0 || upstreamNodeLists.length === 0) {
    fail(`Found ${routes.length} routes and ${upstreamNodeLists.length} node lists in ${checkout} — the parser no longer understands the checkout.`);
  }
  const report = buildReport(
    routes,
    collectMcpApiPaths(mcpRoot),
    upstreamNodeLists,
    collectMcpNodeLists(mcpRoot),
    allowlist,
  );
  const nodeListGaps = report.nodeLists.missingInMcp.length + report.nodeLists.unknownUpstream.length;
  const stale = report.staleUnmatched.length + report.staleCovered.length;
  const failed = report.gaps.length > 0 || nodeListGaps > 0 || (strict && stale > 0);

  if (json) {
    process.stdout.write(`${JSON.stringify({ checkout, unresolvedModules, ...report }, null, 2)}\n`);
    process.exit(failed ? 1 : 0);
  }

  const lines: string[] = [
    `EpicStaff checkout: ${checkout}`,
    `Routes under api/: ${report.upstreamRouteCount} — covered ${report.coveredRoutes.length}, ` +
      `allowlisted ${report.allowlistedRoutes.length}, gaps ${report.gaps.length}`,
  ];
  if (unresolvedModules.length > 0) lines.push(`Not EpicStaff URLconfs (skipped): ${unresolvedModules.join(', ')}`);
  if (report.gaps.length > 0) {
    lines.push('', 'Routes neither used by MCP nor allowlisted:');
    for (const gap of report.gaps) lines.push(`  ${gap.route}    (${gap.source})`);
  }
  lines.push(
    '',
    `Node lists: upstream ${report.nodeLists.upstream.length}, MCP ${report.nodeLists.mcp.length}`,
  );
  if (report.nodeLists.missingInMcp.length > 0) {
    lines.push(`  Upstream node lists push_flow never sends: ${report.nodeLists.missingInMcp.join(', ')}`);
  }
  if (report.nodeLists.unknownUpstream.length > 0) {
    lines.push(`  Node lists MCP sends that upstream no longer has: ${report.nodeLists.unknownUpstream.join(', ')}`);
  }
  if (stale > 0) {
    lines.push('', `Stale allowlist entries${strict ? '' : ' (warning; --strict fails on them)'}:`);
    for (const pattern of report.staleCovered) lines.push(`  ${pattern}    — every matching route is covered now; remove it`);
    for (const pattern of report.staleUnmatched) lines.push(`  ${pattern}    — matches no upstream route`);
  }
  lines.push('', failed ? 'FAIL' : 'OK');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(failed ? 1 : 0);
}

main();
