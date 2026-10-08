import { useEffect, useState } from "react";
import { useClock } from "../state/clock";

/**
 * Formats how long a run has taken.
 *
 * @remarks
 * Short and steady while it ticks: "12s", "2m 13s", "1h 4m".
 *
 * @sideEffects none
 * @param ms - Elapsed milliseconds.
 * @returns The duration.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * "进行中 · 12s": the run in progress, with a shimmer and a live timer.
 *
 * @remarks
 * The process header shows a shimmering "进行中" while a run lasts (SPEC-0001, "过程的呈现";
 * design-language, "动效"); the timer counts from the run's start on the host's clock and ticks
 * once a second, with tabular digits so it does not jump.
 *
 * @sideEffects Ticks the clock once a second while mounted.
 * @param props - When the run started.
 * @returns The status line.
 */
export function RunStatus({ startedAt }: { readonly startedAt: number }) {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => clock.every(1000, () => setNow(clock.now())), [clock]);
  return (
    <p className="text-[length:var(--fs-meta)] tabular-nums" data-testid="run-status">
      <span className="atrium-shimmer">进行中</span>
      <span className="text-[var(--text-dim)]"> · {formatElapsed(now - startedAt)}</span>
    </p>
  );
}
