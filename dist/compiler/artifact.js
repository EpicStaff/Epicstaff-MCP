export function isSymbolicRef(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.$ref === 'string' &&
        Object.keys(value).length === 1);
}
/** Deep-replace every SymbolicRef with the backend id `resolve` returns. */
export function substituteRefs(value, resolve) {
    if (isSymbolicRef(value)) {
        return resolve(value.$ref);
    }
    if (Array.isArray(value)) {
        return value.map((item) => substituteRefs(item, resolve));
    }
    if (typeof value === 'object' && value !== null) {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = substituteRefs(entry, resolve);
        }
        return result;
    }
    return value;
}
/** Collect the ref keys used inside a payload template (for dependency checks). */
export function collectRefs(value, into = new Set()) {
    if (isSymbolicRef(value)) {
        into.add(value.$ref);
    }
    else if (Array.isArray(value)) {
        for (const item of value)
            collectRefs(item, into);
    }
    else if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value))
            collectRefs(entry, into);
    }
    return into;
}
