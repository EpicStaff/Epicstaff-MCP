import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

describe('KeyedMutex', () => {
  it('serializes work per key and keeps arrival order; other keys run in parallel', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const task = (key: string, label: string, ms: number) =>
      mutex.runExclusive(key, async () => {
        events.push(`start ${label}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`end ${label}`);
        return label;
      });
    const results = await Promise.all([task('a', 'a1', 30), task('a', 'a2', 1), task('b', 'b1', 5)]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    expect(events.indexOf('end a1')).toBeLessThan(events.indexOf('start a2'));
    expect(events.indexOf('start b1')).toBeLessThan(events.indexOf('end a1'));
    expect(mutex.size).toBe(0);
  });

  it('a failed run does not block the next one', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(mutex.runExclusive('k', async () => 'ok')).resolves.toBe('ok');
  });
});
