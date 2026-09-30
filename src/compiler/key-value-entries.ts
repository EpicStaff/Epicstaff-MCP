/**
 * Build-time check of key-value node entries.
 *
 * Ported from `src/django_app/tables/validators/key_value_entries_validator.py`
 * (KeyValueEntriesValidator) and `src/django_app/tables/constants/key_value_constants.py`,
 * which the backend runs on every bulk-save — reporting the same rules here turns a
 * whole-save 400 into a precise diagnostic on the offending entry. Messages follow the
 * backend wording so a user sees the same guidance in both places.
 */
import type { KeyValueMode } from '../models/nodes/key-value-node.js';

/** `MAX_KEYS_PER_REQUEST` — at most this many entries per node. */
export const KEY_VALUE_MAX_ENTRIES = 500;
/** `MAX_KEY_LENGTH`. */
export const KEY_VALUE_MAX_KEY_LENGTH = 512;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATE_PATH = /^variables\.\w+(?:\.\w+|\[(?:0|[1-9]\d*)\])*$/;
const PATH_NAME = /\w+/g;
const PATH_SEGMENT = /\w+|\[(?:0|[1-9]\d*)\]/g;
const PLACEHOLDER = /\{([^{}]+)\}/g;

/** DotDict attribute access finds these before a stored key (DOTDICT_METHOD_NAMES). */
const DOTDICT_METHOD_NAMES: ReadonlySet<string> = new Set([
  'add_property',
  'add_setter',
  'clear',
  'copy',
  'deep_dump',
  'fromkeys',
  'get',
  'items',
  'keys',
  'model_dump',
  'pop',
  'popitem',
  'setdefault',
  'update',
  'values',
]);

export interface KeyValueEntryInput {
  key: string;
  value?: string | undefined;
}

export interface KeyValueEntryIssue {
  /** Index of the offending entry, or null for a node-level problem. */
  index: number | null;
  message: string;
}

/** Validate a node's entries; returns every problem found (empty = valid). */
export function validateKeyValueEntries(mode: KeyValueMode, entries: KeyValueEntryInput[]): KeyValueEntryIssue[] {
  const issues: KeyValueEntryIssue[] = [];
  if (entries.length > KEY_VALUE_MAX_ENTRIES) {
    issues.push({ index: null, message: `A Key-Value node can have at most ${KEY_VALUE_MAX_ENTRIES} keys.` });
  }
  const writtenKeys = new Map<string, number>();
  const readTargets: Array<{ segments: string[]; target: string; index: number }> = [];

  entries.forEach((entry, index) => {
    let error = entryError(mode, entry);
    if (error === null && mode === 'write') {
      error = duplicateKeyError(entry.key, index, writtenKeys);
    } else if (error === null && mode === 'read') {
      error = targetConflictError((entry.value ?? '').trim(), index, readTargets);
    }
    if (error !== null) {
      issues.push({ index, message: error });
    }
  });
  return issues;
}

function entryError(mode: KeyValueMode, entry: KeyValueEntryInput): string | null {
  if (mode === 'delete' && entry.value !== undefined) {
    return "unknown fields ['value'] for mode 'delete'.";
  }
  if (entry.key.trim() === '') {
    return "'key' must be a non-empty string.";
  }
  if (mode !== 'delete' && (entry.value === undefined || entry.value.trim() === '')) {
    return "'value' must be a non-empty string.";
  }
  if (entry.key.length > KEY_VALUE_MAX_KEY_LENGTH) {
    return `'key' must be at most ${KEY_VALUE_MAX_KEY_LENGTH} characters.`;
  }
  const keyError = keyTemplateError(entry.key);
  if (keyError !== null || mode === 'delete') {
    return keyError;
  }
  const path = (entry.value ?? '').trim();
  if (mode === 'read' && path.includes('|')) {
    return "'value' is where the stored value goes: use a plain state path like 'variables.user.name', without '|default'.";
  }
  return statePathError(path.split('|', 1)[0] ?? '', "'value'");
}

function keyTemplateError(key: string): string | null {
  const leftover = key.replace(PLACEHOLDER, '');
  if (leftover.includes('{') || leftover.includes('}')) {
    return "'key' has an empty or unbalanced placeholder; use '{variables.<path>}', e.g. 'profile_{variables.user.id}'.";
  }
  for (const match of key.matchAll(PLACEHOLDER)) {
    const path = (match[1] ?? '').trim();
    const error = statePathError(path, `'key' placeholder '${path}'`);
    if (error !== null) {
      return error;
    }
  }
  if (!KEY_PATTERN.test(key.replace(PLACEHOLDER, '_'))) {
    return "'key' must use only letters, digits and _ outside {placeholders}, and must not start with a digit, e.g. 'profile_{variables.user.id}'.";
  }
  return null;
}

function duplicateKeyError(key: string, index: number, writtenKeys: Map<string, number>): string | null {
  const first = writtenKeys.get(key);
  if (first === undefined) {
    writtenKeys.set(key, index);
    return null;
  }
  return `key '${key}' is already written by entry ${first}; use a different key.`;
}

function targetConflictError(
  target: string,
  index: number,
  readTargets: Array<{ segments: string[]; target: string; index: number }>,
): string | null {
  const segments = target.match(PATH_SEGMENT) ?? [];
  for (const earlier of readTargets) {
    const shared = Math.min(segments.length, earlier.segments.length);
    if (segments.slice(0, shared).join('\u0000') !== earlier.segments.slice(0, shared).join('\u0000')) {
      continue;
    }
    if (segments.length === earlier.segments.length) {
      return `'${target}' is already filled by entry ${earlier.index}; use a different variable.`;
    }
    if (segments.length > shared) {
      return `'${target}' is inside '${earlier.target}' (entry ${earlier.index}); use a different variable.`;
    }
    return `'${target}' contains '${earlier.target}' (entry ${earlier.index}); use a different variable.`;
  }
  readTargets.push({ segments, target, index });
  return null;
}

function statePathError(statePath: string, label: string): string | null {
  if (!STATE_PATH.test(statePath)) {
    return `${label} must be a state path like 'variables.user.name'.`;
  }
  for (const name of statePath.match(PATH_NAME) ?? []) {
    if (name.startsWith('_')) {
      return `${label} names '${name}'; use a variable name without the leading '_'.`;
    }
    if (DOTDICT_METHOD_NAMES.has(name)) {
      return `${label} names '${name}', a built-in method; use a different variable name.`;
    }
  }
  return null;
}

/** The state paths inside a key's `{placeholders}` (each is a read of flow state). */
export function keyPlaceholderPaths(key: string): string[] {
  return [...key.matchAll(PLACEHOLDER)].map((match) => (match[1] ?? '').trim());
}
