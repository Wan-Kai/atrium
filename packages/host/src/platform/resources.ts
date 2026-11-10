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

/**
 * A map whose entries count as open resources of a kind, one per key.
 *
 * @remarks
 * For bookkeeping a leak test must see emptied: an entry left after its session went shows up in
 * `ResourceTracker.snapshot` (testing.md, "泄漏测试"), as the kickoffs and forks of study sessions
 * (SPEC-0008, "验证 · 泄漏").
 *
 * @sideEffects Updates the tracker's count as keys come and go.
 */
export class CountedMap<K, V> extends Map<K, V> {
  readonly #releases = new Map<K, () => void>();

  /**
   * An empty map counting under `kind`.
   *
   * @remarks
   * See `CountedMap`.
   *
   * @sideEffects none
   * @param resources - The tracker.
   * @param kind - The kind its entries count as.
   */
  constructor(
    private readonly resources: ResourceTracker,
    private readonly kind: string,
  ) {
    super();
  }

  /**
   * Sets a key's value, counting a key new to the map.
   *
   * @remarks
   * See `Map.set`.
   *
   * @sideEffects Updates the map and the count.
   * @param key - The key.
   * @param value - The value.
   * @returns The map.
   */
  override set(key: K, value: V): this {
    // `Map`'s constructor calls `set` before the fields exist; it adds nothing here.
    if (this.#releases !== undefined && !this.has(key)) this.#releases.set(key, this.resources.acquire(this.kind));
    return super.set(key, value);
  }

  /**
   * Removes a key, no longer counting it.
   *
   * @remarks
   * See `Map.delete`.
   *
   * @sideEffects Updates the map and the count.
   * @param key - The key.
   * @returns Whether it was there.
   */
  override delete(key: K): boolean {
    this.#releases.get(key)?.();
    this.#releases.delete(key);
    return super.delete(key);
  }

  /**
   * Removes every key, no longer counting them.
   *
   * @remarks
   * See `Map.clear`.
   *
   * @sideEffects Updates the map and the count.
   */
  override clear(): void {
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    super.clear();
  }
}
