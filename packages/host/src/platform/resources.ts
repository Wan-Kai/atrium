/**
 * Counts live resources by kind: connections, timers, child processes, open spans.
 *
 * @remarks
 * Leak tests assert these counts return to their baseline after repeated operations, which is
 * deterministic, unlike heap size (testing.md, "性能与资源泄漏"). The same counts are logged every
 * minute so leaks in real use show up as a rising line (observability.md, "和测试的关系").
 *
 * @sideEffects Holds counters in memory.
 */
export class ResourceTracker {
  readonly #counts = new Map<string, number>();

  /**
   * Records that one resource of `kind` is now open.
   *
   * @remarks
   * Returning the release function, instead of exposing a separate decrement, makes it hard to
   * release a resource twice or release the wrong kind.
   *
   * @sideEffects Increments the count for `kind`.
   * @param kind - Resource kind, such as `ws.connection` or `timer`.
   * @returns A function that releases this resource; only its first call has an effect.
   */
  acquire(kind: string): () => void {
    this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#counts.set(kind, (this.#counts.get(kind) ?? 1) - 1);
    };
  }

  /**
   * Returns the current count of every kind seen so far, including kinds back at zero.
   *
   * @remarks
   * Keeping zero entries lets a test compare before and after snapshots with one equality check.
   *
   * @sideEffects none
   * @returns A plain object keyed by kind, sorted by kind for stable output.
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.#counts.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
  }
}
