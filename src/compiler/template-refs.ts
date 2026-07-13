/**
 * Non-numeric payload placeholders that the compiler emits alongside
 * {@link SymbolicRef} (`{$ref}`) and that the PUSHER must substitute before
 * POSTing a payload template.
 *
 * `SymbolicRef` covers "backend id of another entity in this artifact".
 * These refs cover positions where the flow source can only name a value the
 * backend knows by id (or that lives outside the source entirely):
 *
 *  - `{$model}`       — LLM model referenced by NAME in flow source. The pusher
 *                       resolves it to a model id via the `llm-models/` list
 *                       (using `provider` / `base_url` to disambiguate or to
 *                       create a custom model). Sits in the `model` position of
 *                       a `CreateLlmConfigRequest` payload template.
 *  - `{$env}`         — value of an environment variable (API keys, bot tokens).
 *                       Secrets never live in flow source; the pusher reads the
 *                       variable at push time.
 *  - `{$tool}`        — built-in catalog tool referenced by NAME. The pusher
 *                       resolves it to the backend tool id. Sits in the `tool`
 *                       position of a tool-config payload template.
 *  - `{$storageFile}` — org storage file referenced by PATH. The pusher resolves
 *                       it against org storage to a `storage_file` id. Sits in
 *                       surface `storage_items[].storage_file` positions.
 *
 * All guards mirror `isSymbolicRef` in `artifact.ts`: a plain object whose
 * marker key holds a string. `substituteRefs` walks over these objects without
 * touching them (they are not `{$ref}`), so the pusher must run its own
 * substitution pass for them.
 */

export interface ModelRef {
  $model: string;
  /** Optional disambiguation hint carried from the flow source. */
  provider?: string;
  base_url?: string;
}

/**
 * Detected by the `$model` marker key alone — emit may attach `provider` /
 * `base_url` hints alongside it, which the pusher can use to disambiguate
 * models sharing a name across providers.
 */
export function isModelRef(value: unknown): value is ModelRef {
  return (
    typeof value === 'object' && value !== null && typeof (value as ModelRef).$model === 'string'
  );
}

export interface EnvRef {
  /** Name of the environment variable to read at push time. */
  $env: string;
}

export function isEnvRef(value: unknown): value is EnvRef {
  return (
    typeof value === 'object' && value !== null && typeof (value as EnvRef).$env === 'string'
  );
}

export interface BuiltinToolRef {
  /** Backend catalog name of a built-in tool. */
  $tool: string;
}

export function isBuiltinToolRef(value: unknown): value is BuiltinToolRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BuiltinToolRef).$tool === 'string'
  );
}

export interface StorageFileRef {
  /** Org storage path, e.g. "reports/summary.md". */
  $storageFile: string;
}

export function isStorageFileRef(value: unknown): value is StorageFileRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StorageFileRef).$storageFile === 'string'
  );
}
