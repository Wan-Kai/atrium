import { z } from "zod";

/** A count of tokens, turns or steps. */
const Count = z.number().int().nonnegative();

/**
 * A session's status bar figures, each `null` while unknown (SPEC-0001, "状态栏（M1.8）").
 *
 * @remarks
 * `turns`, `steps`, `tokens` and `cost` are pi's `get_session_stats`, over the whole session file;
 * `reasoning` and `branchTokens` the host adds up from the entries; `context` is pi's estimate
 * with the host's split of it; `timing` the host measured while it ran.
 */
export const SessionMetrics = z.strictObject({
  turns: Count.nullable(),
  steps: Count.nullable(),
  tokens: z.strictObject({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count }).nullable(),
  /** US dollars, at API prices. */
  cost: z.number().nonnegative().nullable(),
  /** Reasoning tokens, part of the output; `null` when no message reported any. */
  reasoning: Count.nullable(),
  /** The current branch's tokens, all four kinds. */
  branchTokens: Count,
  context: z
    .strictObject({
      /** `null` after a compaction until the next reply. */
      tokens: Count.nullable(),
      window: z.number().int().positive(),
      /** Estimates of the system prompt and the tools' definitions; `null` when unknown. */
      system: Count.nullable(),
      tools: Count.nullable(),
    })
    .nullable(),
  timing: z
    .strictObject({
      /** Every request's time, added up. */
      modelMs: Count,
      /** The average time to the first output. */
      ttftMs: Count.nullable(),
      /** Output tokens a second of the last reply that had output. */
      tps: z.number().nonnegative().nullable(),
    })
    .nullable(),
});
export type SessionMetrics = z.infer<typeof SessionMetrics>;

/** The figures of a session nothing is known of yet. */
export const UNKNOWN_METRICS: SessionMetrics = {
  turns: null,
  steps: null,
  tokens: null,
  cost: null,
  reasoning: null,
  branchTokens: 0,
  context: null,
  timing: null,
};

/** A status bar group's id, as preferences keep it. */
export const StatusGroupId = z.string().min(1).max(64);
