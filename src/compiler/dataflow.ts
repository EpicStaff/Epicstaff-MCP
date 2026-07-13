/**
 * Compile-time dataflow validation over the flow's `variables` state.
 *
 * EpicStaff's runtime state is an untyped, fail-soft `DotDict`: a read of a path
 * nothing produced silently becomes `None`/`"not found"`/`|default`. This stage adds
 * the guarantee the runtime lacks — that a variable a node reads can actually be there —
 * using a **may-reach** policy:
 *
 *  - root ≠ `variables` / malformed path  → ERROR (mirrors the runtime `ValueError`)
 *  - `variables.shared[...]`, `|default`, `"__all__"`  → allowed, unchecked
 *  - produced on ≥1 path that reaches the reader, or declared  → silent
 *  - produced somewhere but not on a reaching path  → WARNING
 *  - produced nowhere and not declared  → ERROR (the pure typo)
 *
 * Reachability is over-approximated for leniency (see `buildAncestors`).
 */
import { type Diagnostic, makeError, makeWarning } from '../flow-source/diagnostics.js';
import type { FlowSource } from '../flow-source/schema/index.js';
import { isVarPathError, parseVarPath, sharesPrefix } from './varpath.js';

interface ProducedPath {
  node: string;
  segments: string[];
}

export function validateDataflow(source: FlowSource): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodes = source.flow.nodes;

  // --- declared variables (seeded at start → available everywhere) ---
  const declared: string[][] = [
    ...Object.keys(source.variables ?? {}).map((name) => [name]),
    ...startInitialStateKeys(source).map((name) => [name]),
  ];

  // --- producers (output_variable_path per node) + write-path validation ---
  const producedByNode = new Map<string, string[][]>();
  const producedAll: ProducedPath[] = [];
  for (const [nodeName, node] of Object.entries(nodes)) {
    const writePath = (node as { output_variable_path?: unknown }).output_variable_path;
    if (typeof writePath !== 'string' || writePath.trim() === '') continue;
    const parsed = parseVarPath(writePath);
    if (isVarPathError(parsed)) {
      diagnostics.push(makeError(`flow.nodes.${nodeName}.output_variable_path`, parsed.error));
      continue;
    }
    if (parsed.isShared) continue;
    const list = producedByNode.get(nodeName) ?? [];
    list.push(parsed.segments);
    producedByNode.set(nodeName, list);
    producedAll.push({ node: nodeName, segments: parsed.segments });
  }

  const ancestors = buildAncestors(source);

  // --- consumers (input_map on nodes + conditional-edge condition input_map) ---
  for (const [nodeName, node] of Object.entries(nodes)) {
    const inputMap = (node as { input_map?: Record<string, string> }).input_map;
    if (inputMap) {
      checkReads(inputMap, nodeName, `flow.nodes.${nodeName}.input_map`);
    }
  }
  source.flow.edges.forEach((edge, index) => {
    if (edge.condition?.input_map) {
      checkReads(edge.condition.input_map, edge.from, `flow.edges[${index}].condition.input_map`);
    }
  });

  return diagnostics;

  function checkReads(inputMap: Record<string, string>, readerNode: string, basePath: string): void {
    for (const [key, rawValue] of Object.entries(inputMap)) {
      if (rawValue === '__all__') continue; // whole-state read
      const readPath = `${basePath}.${key}`;
      const parsed = parseVarPath(rawValue);
      if (isVarPathError(parsed)) {
        diagnostics.push(makeError(readPath, parsed.error));
        continue;
      }
      if (parsed.isShared || parsed.hasDefault) continue;

      const read = parsed.segments;
      const reaching = [...declared, ...ancestorProduced(readerNode)];
      if (reaching.some((produced) => sharesPrefix(read, produced))) {
        continue; // may-reach: produced on some reaching path (or declared)
      }
      const producedElsewhere = producedAll.find((produced) => sharesPrefix(read, produced.segments));
      if (producedElsewhere) {
        diagnostics.push(
          makeWarning(
            readPath,
            `reads 'variables.${read.join('.')}' which is produced by '${producedElsewhere.node}', ` +
              `but no path from it reaches '${readerNode}' — it may be unset at runtime.`,
          ),
        );
      } else {
        diagnostics.push(
          makeError(
            readPath,
            `reads 'variables.${read.join('.')}' which no node produces and isn't declared. ` +
              `Declare it under 'variables:' (with a default), add a '|default' to the read, ` +
              `or produce it upstream via output_variable_path.`,
          ),
        );
      }
    }
  }

  function ancestorProduced(readerNode: string): string[][] {
    const result: string[][] = [];
    for (const ancestor of ancestors.get(readerNode) ?? new Set<string>()) {
      for (const segments of producedByNode.get(ancestor) ?? []) {
        result.push(segments);
      }
    }
    return result;
  }
}

/** Top-level keys of the start node's inline `initial_state` (each seeded as `variables.<key>`). */
function startInitialStateKeys(source: FlowSource): string[] {
  for (const node of Object.values(source.flow.nodes)) {
    if (node.type === 'start') {
      return Object.keys((node as { initial_state?: Record<string, unknown> }).initial_state ?? {});
    }
  }
  return [];
}

/**
 * ancestors[N] = every node that can reach N. Forward edges come from plain edges plus
 * decision-table / CDT routes. A node with an outgoing conditional edge routes to a
 * runtime-decided target we cannot know, so it is treated as able to reach every node
 * (over-approximation → keeps may-reach false positives near zero). A node never counts
 * as its own ancestor: a node's own output does not satisfy its own input.
 */
function buildAncestors(source: FlowSource): Map<string, Set<string>> {
  const nodeNames = Object.keys(source.flow.nodes);
  const successors = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (!successors.has(from)) successors.set(from, new Set());
    successors.get(from)!.add(to);
  };

  for (const edge of source.flow.edges) {
    if (edge.to !== undefined) {
      add(edge.from, edge.to);
    } else {
      // conditional edge — dynamic target: over-approximate to all nodes.
      for (const target of nodeNames) if (target !== edge.from) add(edge.from, target);
    }
  }
  for (const [name, node] of Object.entries(source.flow.nodes)) {
    if (node.type === 'decision-table') {
      for (const rule of node.rules) add(name, rule.next_node);
      if (node.default_next_node) add(name, node.default_next_node);
    } else if (node.type === 'classification-decision-table') {
      for (const category of node.categories) add(name, category.next_node);
      if (node.default_next_node) add(name, node.default_next_node);
    }
  }

  // Reverse-reachability: ancestors[N] via BFS over reversed edges.
  const ancestors = new Map<string, Set<string>>();
  for (const target of nodeNames) {
    const seen = new Set<string>();
    const queue: string[] = [target];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [from, tos] of successors) {
        if (tos.has(current) && !seen.has(from)) {
          seen.add(from);
          queue.push(from);
        }
      }
    }
    seen.delete(target); // never its own ancestor
    ancestors.set(target, seen);
  }
  return ancestors;
}
