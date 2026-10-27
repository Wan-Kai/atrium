import type { Clock } from "@atrium/remote-crypto";

/** Deadline and cancellation for one harness operation. */
export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One outstanding selective receive. */
interface Waiter<T> {
  readonly matches: (value: T) => boolean;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Buffers arrivals until a test asks for a matching item.
 * @remarks Selective receives preserve unrelated controls and events instead of racing listeners.
 * @sideEffects Schedules cancellable deadlines on the injected clock.
 */
export class Inbox<T> {
  readonly #items: T[] = [];
  readonly #waiters = new Set<Waiter<T>>();
  readonly #clock: Clock;
  #error: Error | undefined;

  /**
   * Creates an empty inbox.
   * @remarks The same clock can drive deterministic timeout tests.
   * @sideEffects none
   * @param clock - Source of deadlines.
   */
  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Delivers an arrival to the oldest matching waiter or buffers it.
   * @remarks Socket callbacks never need to await a test.
   * @sideEffects Settles a pending receive.
   * @param value - The arrival.
   */
  push(value: T): void {
    if (this.#error !== undefined) return;
    const waiter = [...this.#waiters].find((candidate) => candidate.matches(value));
    if (waiter === undefined) this.#items.push(value);
    else waiter.resolve(value);
  }

  /**
   * Receives the first matching arrival, including already buffered arrivals.
   * @remarks Every settlement removes both the deadline and abort listener.
   * @sideEffects Consumes an item or registers a waiter and deadline.
   * @param matches - Selection predicate.
   * @param options - Deadline and optional abort signal.
   * @returns The matching arrival.
   */
  next(matches: (value: T) => boolean, options: WaitOptions = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new Error("aborted"));
    const index = this.#items.findIndex(matches);
    if (index !== -1) return Promise.resolve(this.#items.splice(index, 1)[0] as T);
    if (this.#error !== undefined) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      /**
       * Releases this receive's bookkeeping.
       * @remarks Called before either promise settlement.
       * @sideEffects Removes a waiter, timer and abort listener.
       */
      const clean = (): void => {
        this.#waiters.delete(waiter);
        cancel();
        options.signal?.removeEventListener("abort", abort);
      };
      const waiter: Waiter<T> = {
        matches,
        resolve: (value) => {
          clean();
          resolve(value);
        },
        reject: (error) => {
          clean();
          reject(error);
        },
      };
      /**
       * Cancels only this receive.
       * @remarks Other callers may still be waiting for different messages.
       * @sideEffects Rejects this receive and releases its resources.
       */
      const abort = (): void => waiter.reject(new Error("aborted"));
      const cancel = this.#clock.setTimeout(() => waiter.reject(new Error("timeout")), options.timeoutMs ?? 5_000);
      this.#waiters.add(waiter);
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Fails pending and future receives while preserving already received items.
   * @remarks A final authenticated control can precede a socket close in the same turn.
   * @sideEffects Rejects pending receives and cancels their timers.
   * @param error - Terminal failure.
   */
  fail(error: Error): void {
    this.#error ??= error;
    for (const waiter of this.#waiters) waiter.reject(this.#error);
  }
}
