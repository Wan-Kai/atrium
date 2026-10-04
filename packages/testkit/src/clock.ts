interface PendingTimer {
  readonly dueAt: number;
  readonly callback: () => void;
}

/**
 * A manually advanced clock for tests.
 *
 * @remarks
 * Production code reads time only through an injected clock (coding-standards.md, "异步与取消"),
 * so tests can step through timeouts such as the 2-second stop fence without sleeping. It matches
 * the host's `Clock` interface structurally, so testkit does not import the host
 * (overview.md, "包之间的依赖").
 *
 * @sideEffects Holds scheduled callbacks in memory until they fire or are cancelled.
 */
export class FakeClock {
  #now: number;
  #timers: PendingTimer[] = [];

  /**
   * Creates a clock frozen at the given time.
   *
   * @remarks
   * A fixed start keeps timestamps in assertions deterministic.
   *
   * @sideEffects none
   * @param start - Initial epoch milliseconds.
   */
  constructor(start = 0) {
    this.#now = start;
  }

  /**
   * Returns the current fake time.
   *
   * @remarks
   * Mirrors `Date.now()` so code under test can stamp events.
   *
   * @sideEffects none
   * @returns Epoch milliseconds.
   */
  now(): number {
    return this.#now;
  }

  /**
   * Schedules a callback to run once fake time reaches `now + ms`.
   *
   * @remarks
   * Returns a cancel function instead of a handle so callers cannot mix up handles from
   * different clocks.
   *
   * @sideEffects Registers a pending timer.
   * @param callback - Function to call when due.
   * @param ms - Delay in milliseconds; negative values count as zero.
   * @returns A function that cancels the timer if it has not fired.
   */
  setTimeout(callback: () => void, ms: number): () => void {
    const timer: PendingTimer = { dueAt: this.#now + Math.max(0, ms), callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((pending) => pending !== timer);
    };
  }

  /**
   * Moves time forward and fires every timer that becomes due, in due order.
   *
   * @remarks
   * Timers scheduled by a firing callback also run if they fall inside the window, matching how
   * real timers behave over the same span of time. Timers due together fire in scheduling order,
   * because the list is kept in that order and `toSorted` is stable.
   *
   * @sideEffects Advances the clock and runs due callbacks.
   * @param ms - How far to move forward.
   */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers.filter((timer) => timer.dueAt <= target).toSorted((a, b) => a.dueAt - b.dueAt)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((timer) => timer !== due);
      this.#now = due.dueAt;
      due.callback();
    }
    this.#now = target;
  }

  /**
   * Counts timers that have neither fired nor been cancelled.
   *
   * @remarks
   * Leak tests assert this returns to zero after an operation finishes.
   *
   * @sideEffects none
   * @returns The number of pending timers.
   */
  pendingTimers(): number {
    return this.#timers.length;
  }
}
