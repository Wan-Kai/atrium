import type { UiClock } from "../state/clock";

/**
 * Supplies deterministic time and counts live timers for Phone browser tests.
 * @remarks A full redraw is not needed per frame; jumping time also exercises skipped frames.
 * @sideEffects none until advancing; registered callbacks run on advance.
 * @returns The clock, advance operation and active timer count.
 */
export function remoteTestClock() {
  let now = 0;
  const timers = new Set<{ at: number; repeat: number; callback: () => void }>();
  const clock: UiClock = {
    now: () => now,
    every(ms, callback) {
      const timer = { at: now + ms, repeat: ms, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    after(ms, callback) {
      const timer = { at: now + ms, repeat: 0, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (now < timer.at) continue;
        if (timer.repeat === 0) timers.delete(timer);
        else timer.at = now + timer.repeat;
        timer.callback();
      }
    },
    count: () => timers.size,
  };
}
