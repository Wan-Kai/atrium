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
 * Atrium's cat, small, blinking before "进行中".
 *
 * @remarks
 * The mark stands for a run going on (design-language, "标志"): the logo's ears and eyes in flat
 * colours, small enough for the line; the stylesheet blinks the eyes, and stills them under
 * reduced motion.
 *
 * @sideEffects none
 * @returns The cat, hidden from assistive technology.
 */
function RunCat() {
  return (
    <svg aria-hidden viewBox="0 0 1024 1024" className="atrium-run-cat" data-testid="run-cat">
      <rect width="1024" height="1024" rx="230" fill="#6c86cc" />
      <g transform="translate(-50 20)">
        <path
          d="M190 1120 Q170 820 200 560 L262 250 L450 410 Q640 360 830 410 L1018 250 L1080 560 Q1110 820 1090 1120 Z"
          fill="#f6ede1"
          stroke="#f6ede1"
          strokeWidth="120"
          strokeLinejoin="round"
        />
        <g className="atrium-run-cat-eyes" fill="#1f2537">
          <ellipse cx="512" cy="730" rx="40" ry="58" />
          <ellipse cx="768" cy="730" rx="40" ry="58" />
        </g>
      </g>
    </svg>
  );
}

/**
 * "进行中 · 12s": the run in progress, with the blinking cat, a shimmer and a live timer.
 *
 * @remarks
 * Shown from sending until the run's turn has something to show, and then as the process
 * header while the run lasts (SPEC-0001, "过程的呈现"; design-language, "动效"). The timer
 * counts from the run's start on the host's clock and ticks once a second, with tabular digits so
 * it does not jump; before the host has started the run there is no timer.
 *
 * @sideEffects Ticks the clock once a second while mounted.
 * @param props - When the run started, or `null` before it has.
 * @returns The status line.
 */
export function RunStatus({ startedAt }: { readonly startedAt: number | null }) {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => clock.every(1000, () => setNow(clock.now())), [clock]);
  return (
    <p className="flex items-center gap-2 text-[length:var(--fs-meta)] tabular-nums" data-testid="run-status">
      <RunCat />
      <span>
        <span className="atrium-shimmer">进行中</span>
        {startedAt === null ? null : (
          <span className="text-[var(--text-dim)]"> · {formatElapsed(now - startedAt)}</span>
        )}
      </span>
    </p>
  );
}
