/**
 * Which flow-state paths a node writes and reads — the per-node facts the dataflow
 * validator and the start-node variable domain both need.
 *
 * A node writes its one `output_variable_path` and reads its `input_map`.
 */
import type { NodeSource } from '../flow-source/schema/index.js';

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
  const writePath = (node as { output_variable_path?: unknown }).output_variable_path;
  if (typeof writePath !== 'string' || writePath.trim() === '') return [];
  return [{ at: `${nodePath}.output_variable_path`, path: writePath }];
}

export function nodeReadPaths(node: NodeSource, nodePath: string): NodeReadPath[] {
  const inputMap = (node as { input_map?: Record<string, string> }).input_map ?? {};
  return Object.entries(inputMap).map(([key, path]) => ({ at: `${nodePath}.input_map.${key}`, path }));
}
