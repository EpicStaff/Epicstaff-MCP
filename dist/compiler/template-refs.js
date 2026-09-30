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
/**
 * Detected by the `$model` marker key alone — emit may attach `provider` /
 * `base_url` hints alongside it, which the pusher can use to disambiguate
 * models sharing a name across providers.
 */
export function isModelRef(value) {
    return (typeof value === 'object' && value !== null && typeof value.$model === 'string');
}
export function isEnvRef(value) {
    return (typeof value === 'object' && value !== null && typeof value.$env === 'string');
}
export function isBuiltinToolRef(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.$tool === 'string');
}
export function isStorageFileRef(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.$storageFile === 'string');
}
