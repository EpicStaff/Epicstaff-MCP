/**
 * `flow.lock.json` — per-flow-directory record of what has been pushed to the
 * backend: backend ids and content hashes per entity, plus uploaded document
 * state. The pusher diffs current content hashes against the lock to decide
 * what to create/update.
 *
 * Content hashing is sha256 over canonical JSON (recursively sorted object
 * keys), so hashes are stable regardless of key order.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

export const LOCKFILE_NAME = 'flow.lock.json';

const lockEntityEntrySchema = z.strictObject({
  backendId: z.number().int(),
  contentHash: z.string().min(1),
});

const lockDocumentEntrySchema = z.strictObject({
  hash: z.string().min(1),
  /** Backend id of the knowledge collection (or storage target) the document was uploaded to. */
  uploadedTo: z.number().int().nullable(),
});

export const flowLockSchema = z.strictObject({
  flowName: z.string().min(1),
  graphId: z.number().int().nullable(),
  saveVersion: z.number().int().nonnegative(),
  /** Keyed by `<section>.<name>`, e.g. `agents.researcher`. */
  entities: z.record(z.string(), lockEntityEntrySchema),
  /** Keyed by document path relative to the flow directory. */
  documents: z.record(z.string(), lockDocumentEntrySchema),
});

export type LockEntityEntry = z.infer<typeof lockEntityEntrySchema>;
export type LockDocumentEntry = z.infer<typeof lockDocumentEntrySchema>;
export type FlowLock = z.infer<typeof flowLockSchema>;

export function createLock(flowName: string): FlowLock {
  return { flowName, graphId: null, saveVersion: 0, entities: {}, documents: {} };
}

/** Lock key for an entity, e.g. `entityKey('agents', 'researcher')` → `"agents.researcher"`. */
export function entityKey(section: string, name: string): string {
  return `${section}.${name}`;
}

/**
 * Read the lockfile of a flow directory. Returns `null` when no lockfile
 * exists yet; throws when the file exists but is corrupt (that is an
 * exceptional state the caller must surface, not silently reset).
 */
export async function readLock(flowDir: string): Promise<FlowLock | null> {
  const lockPath = path.join(flowDir, LOCKFILE_NAME);
  let text: string;
  try {
    text = await fs.readFile(lockPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw cause;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new Error(`corrupt lockfile ${lockPath}: ${(cause as Error).message}`);
  }
  const parsed = flowLockSchema.safeParse(data);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const detail =
      firstIssue !== undefined ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'invalid shape';
    throw new Error(`corrupt lockfile ${lockPath}: ${detail}`);
  }
  return parsed.data;
}

/** Write the lockfile with stable key ordering and a trailing newline. */
export async function writeLock(flowDir: string, lock: FlowLock): Promise<void> {
  const lockPath = path.join(flowDir, LOCKFILE_NAME);
  const stable: FlowLock = {
    flowName: lock.flowName,
    graphId: lock.graphId,
    saveVersion: lock.saveVersion,
    entities: sortRecord(lock.entities),
    documents: sortRecord(lock.documents),
  };
  await fs.writeFile(lockPath, `${JSON.stringify(stable, null, 2)}\n`, 'utf8');
}

export function getEntity(lock: FlowLock, section: string, name: string): LockEntityEntry | undefined {
  return lock.entities[entityKey(section, name)];
}

/** Immutable upsert of one entity entry. */
export function setEntity(
  lock: FlowLock,
  section: string,
  name: string,
  entry: LockEntityEntry,
): FlowLock {
  return { ...lock, entities: { ...lock.entities, [entityKey(section, name)]: entry } };
}

/** Immutable removal of one entity entry (e.g. after a backend delete). */
export function removeEntity(lock: FlowLock, section: string, name: string): FlowLock {
  const key = entityKey(section, name);
  const { [key]: _removed, ...entities } = lock.entities;
  return { ...lock, entities };
}

export function getDocument(lock: FlowLock, documentPath: string): LockDocumentEntry | undefined {
  return lock.documents[documentPath];
}

/** Immutable upsert of one document entry. */
export function setDocument(
  lock: FlowLock,
  documentPath: string,
  entry: LockDocumentEntry,
): FlowLock {
  return { ...lock, documents: { ...lock.documents, [documentPath]: entry } };
}

/** True when the entity is missing from the lock or its content hash changed. */
export function isEntityDirty(
  lock: FlowLock,
  section: string,
  name: string,
  currentHash: string,
): boolean {
  return getEntity(lock, section, name)?.contentHash !== currentHash;
}

/**
 * Canonical JSON: object keys recursively sorted, arrays kept in order,
 * `undefined` object values dropped. Deterministic input for hashing.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 (hex) of the canonical JSON form of a value. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = canonicalize(entry);
      }
    }
    return sorted;
  }
  return value;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key] as T;
  }
  return sorted;
}
