/**
 * Flow-state variable path grammar — a faithful port of the runtime tokenizer in
 * `crew/utils/map_variables.py` and `crew/utils/set_output_variables.py`.
 *
 * A path is a `|`-separated `<path>|<default>` (default optional). The path itself
 * tokenizes with `\w+|\[\d+\]`; the first token must be `variables` (the runtime
 * raises `ValueError` otherwise). `variables.shared[<key>].<name>` is a special
 * cross-session (Redis) form the compiler cannot resolve statically.
 */
const TOKEN = /\w+|\[\d+\]/g;
const SHARED = /^variables\.shared\[([^\]]+)\]\.(.+)$/;
/** A legal path: a name, then any number of `.name` or `[index]` steps. */
const VALID_PATH = /^\w+(\.\w+|\[\d+\])*$/;
export function isVarPathError(value) {
    return value.error !== undefined;
}
/**
 * Parse a single `input_map` / `output_variable_path` value. Does not judge
 * availability — only shape (root, grammar, default/shared markers).
 */
export function parseVarPath(rawValue) {
    const [pathPart, ...defaultParts] = rawValue.split('|');
    const hasDefault = defaultParts.length > 0;
    const path = (pathPart ?? '').trim();
    if (path === '') {
        return { error: 'empty variable path' };
    }
    if (SHARED.test(path)) {
        return { raw: rawValue, root: 'variables', segments: [], hasDefault, isShared: true };
    }
    if (!VALID_PATH.test(path)) {
        return { error: `malformed variable path '${path}' (segments must be a name or [index])` };
    }
    const tokens = path.match(TOKEN) ?? [];
    const [root, ...segments] = tokens;
    if (root !== 'variables') {
        return {
            error: `variable path '${path}' must start with 'variables' (got '${root ?? ''}')`,
        };
    }
    return { raw: rawValue, root: 'variables', segments, hasDefault, isShared: false };
}
/** Canonical string for a parsed path's segment chain, e.g. `variables.a.b[0]`. */
export function pathString(parsed) {
    return ['variables', ...parsed.segments].join('.');
}
/**
 * True when two segment chains lie on the same root-to-leaf line — i.e. one is a
 * prefix of (or equal to) the other. Producing `variables.result` satisfies a read
 * of `variables.result.summary` (parent object), and producing the deep path
 * satisfies a read of the parent. Comparison is on the segment arrays after the root.
 */
export function sharesPrefix(a, b) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.every((segment, index) => segment === longer[index]);
}
