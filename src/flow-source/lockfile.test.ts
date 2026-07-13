import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LOCKFILE_NAME,
  canonicalJson,
  contentHash,
  createLock,
  entityKey,
  getDocument,
  getEntity,
  isEntityDirty,
  readLock,
  removeEntity,
  setDocument,
  setEntity,
  writeLock,
} from './lockfile.js';

describe('lockfile', () => {
  let flowDir: string;

  beforeEach(async () => {
    flowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-mcp-lock-'));
  });

  afterEach(async () => {
    await fs.rm(flowDir, { recursive: true, force: true });
  });

  it('round-trips through write and read', async () => {
    let lock = createLock('research-and-write');
    lock = { ...lock, graphId: 42, saveVersion: 3 };
    lock = setEntity(lock, 'agents', 'researcher', { backendId: 7, contentHash: 'abc123' });
    lock = setEntity(lock, 'surfaces', 'web_research', { backendId: 9, contentHash: 'def456' });
    lock = setDocument(lock, 'docs/handbook.md', { hash: 'aaa', uploadedTo: 12 });

    await writeLock(flowDir, lock);
    const restored = await readLock(flowDir);

    expect(restored).toEqual(lock);
    expect(getEntity(restored!, 'agents', 'researcher')).toEqual({
      backendId: 7,
      contentHash: 'abc123',
    });
    expect(getDocument(restored!, 'docs/handbook.md')).toEqual({ hash: 'aaa', uploadedTo: 12 });
  });

  it('writes with stable, sorted keys and a trailing newline', async () => {
    let lock = createLock('flow');
    lock = setEntity(lock, 'surfaces', 'zeta', { backendId: 1, contentHash: 'z' });
    lock = setEntity(lock, 'agents', 'alpha', { backendId: 2, contentHash: 'a' });

    await writeLock(flowDir, lock);
    const text = await fs.readFile(path.join(flowDir, LOCKFILE_NAME), 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('agents.alpha')).toBeLessThan(text.indexOf('surfaces.zeta'));
  });

  it('returns null when no lockfile exists', async () => {
    expect(await readLock(flowDir)).toBeNull();
  });

  it('throws on a corrupt lockfile', async () => {
    await fs.writeFile(path.join(flowDir, LOCKFILE_NAME), 'not json at all', 'utf8');
    await expect(readLock(flowDir)).rejects.toThrow(/corrupt lockfile/);
  });

  it('throws on a lockfile with an invalid shape', async () => {
    await fs.writeFile(path.join(flowDir, LOCKFILE_NAME), JSON.stringify({ nope: true }), 'utf8');
    await expect(readLock(flowDir)).rejects.toThrow(/corrupt lockfile/);
  });

  it('updates entities and documents immutably', () => {
    const original = createLock('flow');
    const updated = setEntity(original, 'agents', 'researcher', {
      backendId: 1,
      contentHash: 'h1',
    });

    expect(original.entities).toEqual({});
    expect(updated.entities[entityKey('agents', 'researcher')]).toEqual({
      backendId: 1,
      contentHash: 'h1',
    });

    const removed = removeEntity(updated, 'agents', 'researcher');
    expect(removed.entities).toEqual({});
    expect(updated.entities).not.toEqual({});
  });

  it('detects dirty entities by content hash', () => {
    let lock = createLock('flow');
    expect(isEntityDirty(lock, 'agents', 'researcher', 'h1')).toBe(true);

    lock = setEntity(lock, 'agents', 'researcher', { backendId: 1, contentHash: 'h1' });
    expect(isEntityDirty(lock, 'agents', 'researcher', 'h1')).toBe(false);
    expect(isEntityDirty(lock, 'agents', 'researcher', 'h2')).toBe(true);
  });
});

describe('content hashing', () => {
  it('is stable across object key order', () => {
    const first = contentHash({ b: 1, a: { d: 2, c: 3 } });
    const second = contentHash({ a: { c: 3, d: 2 }, b: 1 });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when values change and when array order changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ items: [1, 2] })).not.toBe(contentHash({ items: [2, 1] }));
  });

  it('drops undefined object values in canonical form', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
  });
});
