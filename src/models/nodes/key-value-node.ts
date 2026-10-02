/**
 * Key-Value node — reads, writes or deletes keys of an org Key-Value table.
 * Ported from frontend `visual-programming/core/models/key-value-node.model.ts`,
 * `shared/models/node/key-value-mode.ts`, and the bulk-save emission in
 * `visual-programming/utils/save/payload.ts` (which always sends `output_variable_path: null`).
 */

import type { NodeDtoMetadata } from '../graph.js';

export type KeyValueMode = 'read' | 'write' | 'delete';

/**
 * A read or write entry. Read writes the stored value of `key` into the flow state path
 * `value` (None when the key is missing); write stores the value at the state path
 * `value`, which may end in `|default`.
 */
export interface KeyValueReadWriteEntry {
  key: string;
  value: string;
}

export interface KeyValueDeleteEntry {
  key: string;
}

export type KeyValueEntry = KeyValueReadWriteEntry | KeyValueDeleteEntry;

export interface KeyValueNodeData {
  key_value_table: number | null;
  mode: KeyValueMode;
  entries: KeyValueEntry[];
}

export interface KeyValueNodeDto extends KeyValueNodeData {
  id: number;
  graph: number;
  node_name: string;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  metadata: Record<string, unknown>;
  content_hash?: string;
}

export interface KeyValueNodeWrite {
  node_name: string;
  graph: number;
  input_map: Record<string, unknown>;
  /** No key-value mode writes an output — read values go to each entry's own path. */
  output_variable_path: null;
  key_value_table: number | null;
  mode: KeyValueMode;
  entries: KeyValueEntry[];
  metadata: NodeDtoMetadata;
}
