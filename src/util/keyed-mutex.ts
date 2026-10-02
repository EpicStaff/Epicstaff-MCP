/**
 * Run async work one at a time per key, in arrival order. Used to serialize pushes of the same
 * flow directory inside one server process: the MCP client may issue tool calls in parallel, and
 * two concurrent pushes of a lockfile-less flow would both create a graph shell and the same
 * entities before either lockfile write lands.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      // Drop the entry once nothing newer is queued behind this run.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Number of keys with work in flight (for tests). */
  get size(): number {
    return this.tails.size;
  }
}
