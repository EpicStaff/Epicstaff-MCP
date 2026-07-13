/**
 * Ported from frontend `models/python-node.model.ts`,
 * `features/tools/models/python-code.model.ts`, and the bulk-save emission in
 * `utils/save/payload.ts` (which sends `python_code` = node data minus `use_storage`).
 */

import type { NodeDtoMetadata } from '../graph.js';

export interface GetPythonCodeDto {
  id: number;
  libraries: string[];
  code: string;
  entrypoint: string;
}

/** Client-side python code shape (frontend `CustomPythonCode`). */
export interface CustomPythonCode {
  id?: number | null;
  name: string;
  libraries: string[];
  code: string;
  entrypoint: string;
  use_storage?: boolean;
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
  stream_config?: Record<string, boolean>;
  metadata: Record<string, unknown>;
  use_storage?: boolean;
}

export interface PythonNodeWrite {
  node_name: string;
  graph: number;
  python_code: PythonNodeCodeWrite;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  stream_config: Record<string, boolean>;
  use_storage: boolean;
  test_input: Record<string, string | number | boolean>;
  metadata: NodeDtoMetadata;
}
