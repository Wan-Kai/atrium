/** How many visuals keep a snapshot (SPEC-0007, MV1 details). */
export const SNAPSHOTS_KEPT = 64;

/** How large the snapshots may be together, counted as the length of their `data:` addresses. */
export const SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** One visual's snapshot, and whether the page was dark when it was taken. */
interface Snapshot {
  readonly image: string;
  readonly dark: boolean;
}

/**
 * Every visual's latest snapshot, at most 64 of them and 32 MB together, the least recently taken
 * forgotten first.
 *
 * @remarks
 * SPEC-0007 ("截图怎么截") and its MV1 details: only in memory, only the latest of each visual. A
 * snapshot is shown only in the appearance it was taken in. The cards hold no copy of their own:
 * they read it from here and hear when it changes, so a forgotten one is gone everywhere (MV1
 * three-way review). An image larger than the whole limit is not kept.
 *
 * @sideEffects none; the instance keeps the images.
 */
export class VisualSnapshots {
  readonly #images = new Map<string, Snapshot>();
  readonly #listeners = new Set<() => void>();
  #bytes = 0;

  /**
   * The visual's snapshot, if there is one taken in this appearance.
   *
   * @remarks
   * One taken in the other appearance would show the wrong colours.
   *
   * @sideEffects none
   * @param key - The visual.
   * @param dark - Whether the page is dark now.
   * @returns The image, or `null`.
   */
  get(key: string, dark: boolean): string | null {
    const snapshot = this.#images.get(key);
    return snapshot === undefined || snapshot.dark !== dark ? null : snapshot.image;
  }

  /**
   * Keeps a visual's new snapshot, forgetting the least recent ones over the limits.
   *
   * @remarks
   * See the class.
   *
   * @sideEffects Updates the images; tells the listeners.
   * @param key - The visual.
   * @param image - The image, as a `data:` address.
   * @param dark - Whether the page was dark when it was taken.
   */
  set(key: string, image: string, dark: boolean): void {
    this.#forget(key);
    if (image.length <= SNAPSHOT_BYTES) {
      this.#images.set(key, { image, dark });
      this.#bytes += image.length;
    }
    while (this.#images.size > SNAPSHOTS_KEPT || this.#bytes > SNAPSHOT_BYTES) {
      const oldest = this.#images.keys().next();
      // Stryker disable next-line ConditionalExpression: over a limit, the map is never empty.
      if (oldest.done === true) break;
      this.#forget(oldest.value);
    }
    for (const listener of this.#listeners) listener();
  }

  /**
   * Hears every change.
   *
   * @remarks
   * For `useSyncExternalStore`.
   *
   * @sideEffects Adds the listener until stopped.
   * @param listener - Told after each change.
   * @returns Stops listening.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Forgets one visual's snapshot.
   *
   * @remarks
   * Keeps the byte count right.
   *
   * @sideEffects Updates the images.
   * @param key - The visual.
   */
  #forget(key: string): void {
    const snapshot = this.#images.get(key);
    if (snapshot === undefined) return;
    this.#images.delete(key);
    this.#bytes -= snapshot.image.length;
  }
}
