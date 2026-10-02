/**
 * Which flow-state paths a node writes and reads — the per-node facts the dataflow
 * validator and the start-node variable domain both need.
 *
 * Most nodes write one `output_variable_path` and read their `input_map`. A key-value
 * node has neither (the backend always stores `output_variable_path: null`, and the
 * runtime ignores its input map): in read mode every entry's `value` is a write target,
 * in write mode every entry's `value` is a read source, and `{variables.…}` key
 * placeholders are reads in every mode (see `src/crew/services/graph/nodes/key_value_node.py`).
 */
import type { NodeSource } from '../flow-source/schema/index.js';
import { keyPlaceholderPaths } from './key-value-entries.js';

export interface NodeWritePath {
  /** Diagnostic path of the position that declares the write. */
  at: string;
  path: string;
}

export interface NodeReadPath {
  /** Diagnostic path of the position that declares the read. */
  at: string;
  path: string;
}

export function nodeWritePaths(node: NodeSource, nodePath: string): NodeWritePath[] {
  if (node.type === 'key-value') {
    if (node.mode !== 'read') return [];
    return node.entries.flatMap((entry, index) =>
      entry.value !== undefined ? [{ at: `${nodePath}.entries[${index}].value`, path: entry.value }] : [],
    );
  }
  const writePath = (node as { output_variable_path?: unknown }).output_variable_path;
  if (typeof writePath !== 'string' || writePath.trim() === '') return [];
  return [{ at: `${nodePath}.output_variable_path`, path: writePath }];
}

export function nodeReadPaths(node: NodeSource, nodePath: string): NodeReadPath[] {
  if (node.type === 'key-value') {
    return node.entries.flatMap((entry, index) => [
      ...keyPlaceholderPaths(entry.key).map((path) => ({ at: `${nodePath}.entries[${index}].key`, path })),
      ...(node.mode === 'write' && entry.value !== undefined
        ? [{ at: `${nodePath}.entries[${index}].value`, path: entry.value }]
        : []),
    ]);
  }
  const inputMap = (node as { input_map?: Record<string, string> }).input_map ?? {};
  return Object.entries(inputMap).map(([key, path]) => ({ at: `${nodePath}.input_map.${key}`, path }));
}
