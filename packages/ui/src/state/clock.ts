import { createContext, useContext } from "react";

/** The time source of the UI (coding-standards, "时间一律通过注入的 Clock 取"). */
export interface UiClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /**
   * Calls `tick` every `ms` milliseconds.
   *
   * @returns A function that stops it.
   */
  every(ms: number, tick: () => void): () => void;
}

/**
 * The real clock.
 *
 * @remarks
 * The one place in the UI that reads the system time and sets intervals; components get time
 * through `useClock`, so tests can pass another.
 *
 * @sideEffects `every` sets an interval until stopped.
 */
const systemClock: UiClock = {
  now: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

/** The clock components use; the real one unless a test provides another. */
export const ClockContext = createContext<UiClock>(systemClock);

/**
 * The clock to read time from.
 *
 * @remarks
 * See `systemClock`.
 *
 * @sideEffects none
 * @returns The clock.
 */
export function useClock(): UiClock {
  return useContext(ClockContext);
}
