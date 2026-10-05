/**
 * Ported from frontend `visual-programming/core/models/python-node.model.ts`,
 * `shared/models/tools/python-code.model.ts`, and the bulk-save emission in
 * `visual-programming/utils/save/payload.ts` (which sends `python_code` = node data minus `use_storage`).
 */

import type { NodeDtoMetadata } from '../graph.js';

/** A secret a python code block may read, by name (`DeclaredSecretRef`). Never carries the value. */
export interface DeclaredSecretRef {
  id: number;
  name: string;
}

/** Read shape of a python code row (`GetPythonCodeRequest`). `secrets` is the read side of `secret_ids`. */
export interface GetPythonCodeDto {
  id: number;
  libraries: string[];
  code: string;
  entrypoint: string;
  secrets?: DeclaredSecretRef[];
}

/**
 * Client-side python code shape (frontend `CustomPythonCode`). The frontend also keeps
 * a display-only `secret_names` list next to `secret_ids`; the backend ignores it, so it
 * is not modelled here.
 */
export interface CustomPythonCode {
  id?: number | null;
  name: string;
  libraries: string[];
  code: string;
  entrypoint: string;
  use_storage?: boolean;
  /** Secrets this code may read (write side of `GetPythonCodeDto.secrets`). */
  secret_ids?: number[];
}

/** `python_code` as emitted inside a python-node bulk-save item: `CustomPythonCode` minus `use_storage`. */
export type PythonNodeCodeWrite = Omit<CustomPythonCode, 'use_storage'>;

export interface PythonNodeDto {
  id: number;
  node_name: string;
  graph: number;
  python_code: GetPythonCodeDto;
  input_map: Record<string, unknown>;
  test_input: Record<string, string | number | boolean>;
  output_variable_path: string | null;
  metadata: Record<string, unknown>;
  use_storage?: boolean;
}

export interface PythonNodeWrite {
  node_name: string;
  graph: number;
  python_code: PythonNodeCodeWrite;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  use_storage: boolean;
  test_input: Record<string, string | number | boolean>;
  metadata: NodeDtoMetadata;
}
