import type { ResourceTracker } from "./resources";

/** Source of time and timers; injected so tests can use a fake clock. */
export interface Clock {
  /** Current epoch milliseconds. */
  now(): number;
  /** Schedules `callback` after `ms`; returns a function that cancels it. */
  setTimeout(callback: () => void, ms: number): () => void;
}

/**
 * The real clock backed by `Date.now` and `setTimeout`.
 *
 * @remarks
 * Production code never calls the globals directly (coding-standards.md, "异步与取消"), so this
 * is the only place they appear.
 *
 * @sideEffects `setTimeout` registers a real timer that keeps the event loop alive until it fires
 * or is cancelled.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
};

/**
 * Schedules a timer that is counted as an open resource until it fires or is cancelled.
 *
 * @remarks
 * Leak tests check that the `timer` count returns to its baseline after an operation, so every
 * host timer goes through here (testing.md, "性能与资源泄漏").
 *
 * @sideEffects Registers a timer on `clock`; increments the `timer` resource count, which is
 * released exactly once when the timer fires or is cancelled.
 * @param clock - Clock to schedule on.
 * @param resources - Tracker that counts the timer.
 * @param callback - Function to run when due.
 * @param ms - Delay in milliseconds.
 * @returns A cancel function; calling it after the timer fired does nothing.
 */
export function trackedTimeout(clock: Clock, resources: ResourceTracker, callback: () => void, ms: number): () => void {
  const release = resources.acquire("timer");
  const cancel = clock.setTimeout(() => {
    release();
    callback();
  }, ms);
  return () => {
    cancel();
    release();
  };
}
