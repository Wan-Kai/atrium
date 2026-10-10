import type { SessionStats } from "@earendil-works/pi-coding-agent";

/** What the status bar takes from pi's `get_session_stats` (SPEC-0001, "状态栏（M1.8）"). */
export interface PiStats {
  /** User messages in the whole session file, steers among them. */
  readonly turns: number;
  /** Tool calls in the whole session file. */
  readonly steps: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** US dollars, at API prices. */
  readonly cost: number;
  /** pi's estimate of the current branch's context; `null` without a model or a window. */
  readonly context: { readonly tokens: number | null; readonly window: number } | null;
}

/**
 * A count as the protocol carries it.
 *
 * @remarks
 * pi adds up what providers report; one that is not a whole number of zero or more, as a
 * provider's mistake could make it, is rounded, and anything not finite or below zero is 0.
 *
 * @sideEffects none
 * @param value - pi's figure.
 * @returns The count.
 */
function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * Takes the status bar's figures from pi's statistics.
 *
 * @remarks
 * pi counts the whole session file, other branches and compactions included (pi-internals.md §2,
 * "统计"). Its context is `null` after a compaction until the next reply, and missing without a
 * model or a context window.
 *
 * @sideEffects none
 * @param stats - pi's `get_session_stats`.
 * @returns The figures.
 */
export function piStatsOf(stats: SessionStats): PiStats {
  const { tokens, contextUsage } = stats;
  const window = count(contextUsage?.contextWindow ?? 0);
  return {
    turns: count(stats.userMessages),
    steps: count(stats.toolCalls),
    tokens: {
      input: count(tokens.input),
      output: count(tokens.output),
      cacheRead: count(tokens.cacheRead),
      cacheWrite: count(tokens.cacheWrite),
    },
    cost: Number.isFinite(stats.cost) ? Math.max(0, stats.cost) : 0,
    context:
      // Stryker disable next-line ConditionalExpression: a missing context has no window either.
      contextUsage === undefined || window === 0
        ? null
        : { tokens: contextUsage.tokens === null ? null : count(contextUsage.tokens), window },
  };
}
