/**
 * API parity between an EpicStaff checkout and this MCP tree — the pure part of
 * `scripts/parity-check.ts`, kept free of process / console handling so it can be unit-tested.
 *
 * Upstream side (read from the checkout, never imported or executed):
 *  - every route the Django URLconf serves under `api/`: `router.register(...)` prefixes (a router
 *    prefix stands for its list/detail/@action routes, written `<prefix>/*`) and `path(...)` routes,
 *    following `include("<module>.urls")` from `src/django_app/django_app/urls.py`;
 *  - every graph node list: the bulk-save `NODE_TYPE_REGISTRY` keys
 *    (`tables/services/graph_bulk_save_service/registry.py`) and the crew `GraphData` `*_node_list`
 *    fields (`src/shared/models/graph_nodes.py`; its `*_node_data_list` trigger fields count under their
 *    `*_node_list` name).
 * MCP side:
 *  - every API path literal in `src/**` (string and template literals ending in `/`, `${…}` as a
 *    parameter) — the requests the API clients and tools send;
 *  - the node lists of `BulkSavePayload` (`src/models/graph.ts`), what push_flow emits.
 *
 * A route is covered when an MCP path matches it segment by segment (parameters match any segment,
 * the best-agreeing route wins); a router prefix is covered by any MCP path under it that no path()
 * route claims (see {@link reachedRoutes}). What is not covered must be allowlisted with a reason
 * (`scripts/parity-allowlist.json`).
 *
 * Limitation: a viewset's `@action` routes are not enumerated — a router prefix stands for all of
 * them, so a new action on an already-used viewset does not show up as a gap.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface UpstreamRoute {
  /** Relative to `/api/`, parameters as `{}`; a router prefix is `<prefix>/*`. */
  route: string;
  kind: 'router' | 'path';
  /** File the route is declared in, relative to the checkout. */
  source: string;
}

export interface AllowlistEntry {
  /** Glob over the normalized route: `*` matches any run of characters. */
  pattern: string;
  category: string;
  reason: string;
}

export interface NodeListAllowlistEntry {
  name: string;
  reason: string;
}

export interface Allowlist {
  routes: AllowlistEntry[];
  nodeLists?: NodeListAllowlistEntry[];
}

export interface ParityReport {
  upstreamRouteCount: number;
  coveredRoutes: string[];
  allowlistedRoutes: Array<{ route: string; category: string }>;
  /** Not covered and not allowlisted: the failures. */
  gaps: UpstreamRoute[];
  /** Allowlist patterns that match no upstream route at all. */
  staleUnmatched: string[];
  /** Allowlist patterns whose every matching route is covered by MCP now. */
  staleCovered: string[];
  nodeLists: {
    upstream: string[];
    mcp: string[];
    /** Upstream lists push_flow never sends. */
    missingInMcp: string[];
    /** Lists MCP sends that upstream no longer knows (a removed or renamed node type). */
    unknownUpstream: string[];
    allowlisted: string[];
  };
}

// ----- Python source helpers ------------------------------------------------------------------

/** Python source without docstrings / triple-quoted strings and `#` comment lines. */
export function stripPythonNoise(source: string): string {
  return source
    .replace(/("""|''')[\s\S]*?\1/g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** A Django route pattern in the parity form: `<int:pk>`, `(?P<x>…)` and f-string `{x}` become `{}`. */
export function normalizeDjangoRoute(route: string): string {
  return route
    .replace(/\(\?P<\w+>[^)]*\)/g, '{}')
    .replace(/<(?:\w+:)?\w+>/g, '{}')
    .replace(/\{[A-Za-z_]\w*\}/g, '{}')
    .replace(/^\^/, '')
    .replace(/\$$/, '');
}

interface ModuleRef {
  module: string;
  prefix: string;
}

/**
 * Parse one urls.py: its own routes (under `prefix`) and the modules it includes. Only literal
 * routes are understood; anything else is ignored rather than guessed.
 */
export function parseUrlsModule(
  source: string,
  prefix: string,
  sourceFile: string,
): { routes: UpstreamRoute[]; includes: ModuleRef[] } {
  const code = stripPythonNoise(source);
  const routes: UpstreamRoute[] = [];
  const includes: ModuleRef[] = [];

  // Routers: `name = DefaultRouter()`, `name.register(r"prefix", …)`, mounted by
  // `path("p/", include(name.urls))` or `urlpatterns = name.urls`.
  const routerNames = [...code.matchAll(/(\w+)\s*=\s*(?:DefaultRouter|SimpleRouter)\s*\(/g)].map((match) => match[1]!);
  const routerMounts = new Map<string, string[]>();
  for (const match of code.matchAll(/\bpath\(\s*r?(["'])(.*?)\1\s*,\s*include\(\s*(\w+)\.urls\s*\)/g)) {
    const mounts = routerMounts.get(match[3]!) ?? [];
    mounts.push(match[2]!);
    routerMounts.set(match[3]!, mounts);
  }
  for (const match of code.matchAll(/urlpatterns\s*\+?=\s*(\w+)\.urls\b/g)) {
    const mounts = routerMounts.get(match[1]!) ?? [];
    mounts.push('');
    routerMounts.set(match[1]!, mounts);
  }
  for (const match of code.matchAll(/(\w+)\.register\(\s*r?(["'])(.*?)\2/g)) {
    const routerName = match[1]!;
    if (!routerNames.includes(routerName)) continue;
    for (const mount of routerMounts.get(routerName) ?? []) {
      routes.push({
        route: normalizeDjangoRoute(`${prefix}${mount}${match[3]!}/*`),
        kind: 'router',
        source: sourceFile,
      });
    }
  }

  // path("route", view…) and path("prefix", include("module.urls")).
  for (const match of code.matchAll(/\bpath\(\s*(f?)r?(["'])(.*?)\2\s*,\s*(include\(\s*(?:r?(["'])([\w.]+)\5|\w+\.urls))?/g)) {
    const route = match[3]!;
    if (match[4] !== undefined) {
      if (match[6] !== undefined) includes.push({ module: match[6], prefix: `${prefix}${route}` });
      continue;
    }
    routes.push({ route: normalizeDjangoRoute(`${prefix}${route}`), kind: 'path', source: sourceFile });
  }
  return { routes, includes };
}

/** Every route of the checkout's Django URLconf that lives under `api/`, relative to it. */
export function collectUpstreamRoutes(checkout: string): { routes: UpstreamRoute[]; unresolvedModules: string[] } {
  const djangoRoot = join(checkout, 'src', 'django_app');
  const rootModule = 'django_app.urls';
  const routes: UpstreamRoute[] = [];
  const unresolvedModules: string[] = [];
  const visited = new Set<string>();
  const queue: ModuleRef[] = [{ module: rootModule, prefix: '' }];

  while (queue.length > 0) {
    const next = queue.shift()!;
    const key = `${next.prefix}|${next.module}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const file = join(djangoRoot, ...next.module.split('.')) + '.py';
    if (!existsSync(file)) {
      // Third-party URLconfs (health_check …) are not EpicStaff API.
      unresolvedModules.push(next.module);
      continue;
    }
    const parsed = parseUrlsModule(readFileSync(file, 'utf8'), next.prefix, relative(checkout, file));
    routes.push(...parsed.routes);
    queue.push(...parsed.includes);
  }

  const apiRoutes = new Map<string, UpstreamRoute>();
  for (const route of routes) {
    if (!route.route.startsWith('api/')) continue;
    const relativeRoute = route.route.slice('api/'.length);
    if (relativeRoute === '' || relativeRoute === '/*') continue;
    if (!apiRoutes.has(relativeRoute)) apiRoutes.set(relativeRoute, { ...route, route: relativeRoute });
  }
  return {
    routes: [...apiRoutes.values()].sort((left, right) => left.route.localeCompare(right.route)),
    unresolvedModules,
  };
}

/** The graph node lists upstream knows: bulk-save registry keys ∪ crew GraphData lists. */
export function collectUpstreamNodeLists(checkout: string): string[] {
  const names = new Set<string>();
  const registryFile = join(checkout, 'src/django_app/tables/services/graph_bulk_save_service/registry.py');
  if (existsSync(registryFile)) {
    const registry = stripPythonNoise(readFileSync(registryFile, 'utf8'));
    for (const match of registry.matchAll(/NodeTypeConfig\(\s*(?:list_key\s*=\s*)?["'](\w+)["']/g)) names.add(match[1]!);
  }
  const graphNodesFile = join(checkout, 'src/shared/models/graph_nodes.py');
  if (existsSync(graphNodesFile)) {
    const graphNodes = stripPythonNoise(readFileSync(graphNodesFile, 'utf8'));
    const body = /class GraphData\([^)]*\):\n((?:[ \t]+.*\n|\s*\n)*)/.exec(graphNodes)?.[1] ?? '';
    for (const match of body.matchAll(/^\s+(\w+_node(?:_data)?_list)\s*:/gm)) {
      names.add(match[1]!.replace(/_node_data_list$/, '_node_list'));
    }
  }
  return [...names].sort();
}

// ----- MCP side ---------------------------------------------------------------------------------

/** Every `.ts` file under `directory`, test files and generated code excluded. */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'generated') files.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** An API path the code may send: lowercase segments, ending in `/`, `${…}` read as a parameter. */
const API_PATH = /^[a-z][a-z0-9_-]*\/(?:(?:[a-z0-9_-]+|\{\})\/)*$/;

/** The API paths written as string or template literals in TypeScript source. */
export function extractApiPaths(source: string): string[] {
  // Comments first: an apostrophe in prose ("node's") would pair with a real literal's quote.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals = [
    ...[...code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((match) => match[1]!),
    ...[...code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((match) => match[1]!),
    ...[...code.matchAll(/`((?:[^`\\]|\\.)*)`/g)].map((match) => match[1]!),
  ];
  const paths = new Set<string>();
  for (const literal of literals) {
    const candidate = literal.replace(/\$\{[^}]*\}/g, '{}').replace(/^\/?api\//, '');
    if (API_PATH.test(candidate)) paths.add(candidate);
  }
  return [...paths];
}

export function collectMcpApiPaths(mcpRoot: string): string[] {
  const paths = new Set<string>();
  for (const file of sourceFiles(join(mcpRoot, 'src'))) {
    for (const path of extractApiPaths(readFileSync(file, 'utf8'))) paths.add(path);
  }
  return [...paths].sort();
}

/** The node lists push_flow sends: the `*_list` keys of `BulkSavePayload` (the edge list aside). */
export function collectMcpNodeLists(mcpRoot: string): string[] {
  const graphModel = readFileSync(join(mcpRoot, 'src/models/graph.ts'), 'utf8');
  const body = /export interface BulkSavePayload \{([\s\S]*?)\n\}/.exec(graphModel)?.[1] ?? '';
  return [...body.matchAll(/^\s+(\w+_list)\??:/gm)]
    .map((match) => match[1]!)
    .filter((name) => name !== 'edge_list')
    .sort();
}

// ----- Matching -----------------------------------------------------------------------------------

function segments(path: string): string[] {
  return path.replace(/\/$/, '').split('/');
}

function segmentsMatch(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === '{}' || right[index] === '{}' || segment === right[index]);
}

/** How closely a matching route agrees with a path: segments equal literally, or parameters on both sides. */
function agreement(route: string[], path: string[]): number {
  return route.filter((segment, index) => segment === path[index]).length;
}

/**
 * The upstream routes MCP reaches. A path() route is reached by the MCP path that matches it best: a
 * parameter matches any segment, but `naive-rag/{}/document-configs/bulk-update/` reaches its own
 * route, not `naive-rag/{}/document-configs/{}/`. A router prefix is reached by any MCP path under it
 * that no path() route claimed — `pythonnodes/{}/last-session-input/` does not make the `pythonnodes`
 * CRUD covered.
 */
export function reachedRoutes(routes: readonly UpstreamRoute[], mcpPaths: readonly string[]): Set<string> {
  const pathRoutes = routes.filter((route) => route.kind === 'path').map((route) => ({ route, parts: segments(route.route) }));
  const covered = new Set<string>();
  const unclaimed: string[][] = [];
  for (const path of mcpPaths) {
    const parts = segments(path);
    const matches = pathRoutes.filter((candidate) => segmentsMatch(candidate.parts, parts));
    if (matches.length === 0) {
      unclaimed.push(parts);
      continue;
    }
    const best = Math.max(...matches.map((candidate) => agreement(candidate.parts, parts)));
    for (const candidate of matches) {
      if (agreement(candidate.parts, parts) === best) covered.add(candidate.route.route);
    }
  }
  for (const route of routes) {
    if (route.kind !== 'router') continue;
    const prefix = segments(route.route.replace(/\/\*$/, ''));
    if (unclaimed.some((parts) => segmentsMatch(prefix, parts.slice(0, prefix.length)))) covered.add(route.route);
  }
  return covered;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function buildReport(
  upstreamRoutes: UpstreamRoute[],
  mcpPaths: string[],
  upstreamNodeLists: string[],
  mcpNodeLists: string[],
  allowlist: Allowlist,
): ParityReport {
  const matchers = allowlist.routes.map((entry) => ({ entry, regExp: globToRegExp(entry.pattern) }));
  const coveredRoutes: string[] = [];
  const allowlistedRoutes: Array<{ route: string; category: string }> = [];
  const gaps: UpstreamRoute[] = [];
  const patternHits = new Map<string, { total: number; covered: number }>(
    allowlist.routes.map((entry) => [entry.pattern, { total: 0, covered: 0 }]),
  );

  const reached = reachedRoutes(upstreamRoutes, mcpPaths);
  for (const route of upstreamRoutes) {
    const covered = reached.has(route.route);
    const allowedBy = matchers.filter((matcher) => matcher.regExp.test(route.route));
    for (const { entry } of allowedBy) {
      const hits = patternHits.get(entry.pattern)!;
      hits.total += 1;
      if (covered) hits.covered += 1;
    }
    if (covered) coveredRoutes.push(route.route);
    else if (allowedBy[0] !== undefined) allowlistedRoutes.push({ route: route.route, category: allowedBy[0].entry.category });
    else gaps.push(route);
  }

  const upstreamLists = new Set(upstreamNodeLists);
  const mcpLists = new Set(mcpNodeLists);
  const allowedLists = new Set((allowlist.nodeLists ?? []).map((entry) => entry.name));
  return {
    upstreamRouteCount: upstreamRoutes.length,
    coveredRoutes,
    allowlistedRoutes,
    gaps,
    staleUnmatched: [...patternHits].filter(([, hits]) => hits.total === 0).map(([pattern]) => pattern),
    staleCovered: [...patternHits]
      .filter(([, hits]) => hits.total > 0 && hits.covered === hits.total)
      .map(([pattern]) => pattern),
    nodeLists: {
      upstream: [...upstreamLists].sort(),
      mcp: [...mcpLists].sort(),
      missingInMcp: [...upstreamLists].filter((name) => !mcpLists.has(name) && !allowedLists.has(name)).sort(),
      unknownUpstream: [...mcpLists].filter((name) => !upstreamLists.has(name) && !allowedLists.has(name)).sort(),
      allowlisted: [...allowedLists].sort(),
    },
  };
}

export function isAllowlist(value: unknown): value is Allowlist {
  if (typeof value !== 'object' || value === null) return false;
  const { routes, nodeLists } = value as { routes?: unknown; nodeLists?: unknown };
  const validRoutes =
    Array.isArray(routes) &&
    routes.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AllowlistEntry).pattern === 'string' &&
        typeof (entry as AllowlistEntry).category === 'string' &&
        typeof (entry as AllowlistEntry).reason === 'string' &&
        (entry as AllowlistEntry).reason.trim() !== '',
    );
  const validNodeLists =
    nodeLists === undefined ||
    (Array.isArray(nodeLists) &&
      nodeLists.every(
        (entry: unknown) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as NodeListAllowlistEntry).name === 'string' &&
          typeof (entry as NodeListAllowlistEntry).reason === 'string',
      ));
  return validRoutes && validNodeLists;
}
