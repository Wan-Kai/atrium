import { type Clock, trackedTimeout } from "./clock";
import type { ResourceTracker } from "./resources";

/**
 * At most `limit` events per key in any sliding window of `windowMs`; `limit` 0 means no limit.
 *
 * @remarks
 * For "同一个 IP 每分钟最多新建 30 条流" (SPEC-0005, "relay 的线路协议 · 上限"). A sliding window
 * keeps a burst at a minute's edge to 30 too, which a fixed per-minute counter would let double.
 * Keys whose window has passed are swept by one timer that runs only while there are keys, so an
 * idle relay holds no timer and no memory for addresses it has not seen for a minute.
 *
 * @sideEffects Holds timestamps per key; schedules the sweep timer while any key is held.
 */
export class SlidingWindowLimit {
  readonly #clock: Clock;
  readonly #resources: ResourceTracker;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #events = new Map<string, number[]>();
  #cancelSweep: (() => void) | null = null;

  /**
   * Creates an empty limit.
   *
   * @remarks
   * The clock is injected so tests step through the window (coding-standards.md, "异步与取消").
   *
   * @sideEffects none
   * @param clock - Time source.
   * @param resources - Counts the sweep timer.
   * @param limit - Events allowed per window; 0 turns the limit off.
   * @param windowMs - Window length.
   */
  constructor(clock: Clock, resources: ResourceTracker, limit: number, windowMs: number) {
    this.#clock = clock;
    this.#resources = resources;
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /**
   * Records one event for `key` if the window has room.
   *
   * @remarks
   * Checking and recording in one call keeps a refused attempt from using up the budget.
   *
   * @sideEffects Records a timestamp; may start the sweep timer.
   * @param key - What is limited, here an IP address.
   * @returns Whether the event is allowed.
   */
  take(key: string): boolean {
    if (this.#limit === 0) return true;
    const now = this.#clock.now();
    // Stryker disable next-line ArrayDeclaration: whatever stands in for "no events" is filtered out as not a recent time.
    const recent = (this.#events.get(key) ?? []).filter((time) => now - time < this.#windowMs);
    if (recent.length >= this.#limit) return false;
    recent.push(now);
    this.#events.set(key, recent);
    this.#scheduleSweep();
    return true;
  }

  /**
   * Number of keys held, for tests and the resource log.
   *
   * @remarks
   * Shows that the sweep forgets addresses once their window has passed.
   *
   * @sideEffects none
   * @returns The key count.
   */
  get size(): number {
    return this.#events.size;
  }

  /**
   * Forgets every key and stops the sweep.
   *
   * @remarks
   * Called when the relay closes so no timer outlives it.
   *
   * @sideEffects Clears the map; cancels the sweep timer.
   */
  clear(): void {
    this.#events.clear();
    this.#cancelSweep?.();
    this.#cancelSweep = null;
  }

  /**
   * Starts the sweep timer unless it already runs.
   *
   * @remarks
   * One timer for all keys instead of one per key.
   *
   * @sideEffects Schedules a timer.
   */
  #scheduleSweep(): void {
    if (this.#cancelSweep !== null) return;
    this.#cancelSweep = trackedTimeout(this.#clock, this.#resources, () => this.#sweep(), this.#windowMs);
  }

  /**
   * Drops keys whose newest event has left the window, and runs again while keys remain.
   *
   * @remarks
   * A key with a recent event is kept whole; `take` trims its old events when it is used.
   *
   * @sideEffects Deletes keys; may schedule the next sweep.
   */
  #sweep(): void {
    this.#cancelSweep = null;
    const now = this.#clock.now();
    for (const [key, times] of this.#events) {
      if (times.every((time) => now - time >= this.#windowMs)) this.#events.delete(key);
    }
    if (this.#events.size > 0) this.#scheduleSweep();
  }
}
