import { z } from "zod";

/** A count of tokens, turns or steps. */
const Count = z.number().int().nonnegative();

/** A named piece of the context and its estimated tokens: a skill, a tool or an extension's section. */
const NamedTokens = z.strictObject({ name: z.string().max(256), tokens: Count });

/**
 * The context split by what fills it, in estimated tokens (SPEC-0001, "M1.13 的上下文细分与套餐用量").
 *
 * @remarks
 * Each group's `tokens` counts the whole group, so it can be a little more than its items added
 * up. Lists go from most tokens to fewest, then by name.
 */
export const ContextParts = z.strictObject({
  /** The instructions and pi's own sections: its preamble, tool notes, rules, docs, addendum and directory. */
  system: Count,
  /** `project_context`, by memory file as pi names it. */
  memory: z.strictObject({
    tokens: Count,
    files: z.array(z.strictObject({ path: z.string().max(4096), tokens: Count })).readonly(),
  }),
  skills: z.strictObject({ tokens: Count, items: z.array(NamedTokens).readonly() }),
  /** pi's own tools and its built-in extensions' `codemode` and `tool_search`. */
  builtin: z.strictObject({ tokens: Count, items: z.array(NamedTokens).readonly() }),
  /** `mcp__<server>__<tool>` tools by server, and the `mcp_servers` section in the total. */
  mcp: z.strictObject({
    tokens: Count,
    servers: z.array(z.strictObject({ name: z.string().max(256), tools: Count, tokens: Count })).readonly(),
  }),
  /** Every other tool and section, by name. */
  extensions: z.strictObject({ tokens: Count, items: z.array(NamedTokens).readonly() }),
});
export type ContextParts = z.infer<typeof ContextParts>;

/** What pi keeps free before it compacts on its own; `"off"` when it does not; `null` when not known. */
export const ContextReserve = z.union([Count, z.literal("off")]).nullable();
export type ContextReserve = z.infer<typeof ContextReserve>;

/** The subscriptions whose usage Atrium asks for (ADR-0010). */
export const PlanProvider = z.enum(["openai-codex", "anthropic"]);
export type PlanProvider = z.infer<typeof PlanProvider>;

/**
 * A subscription's usage, as Atrium's extension found it (SPEC-0001, "M1.13 的上下文细分与套餐用量").
 */
export const PlanUsage = z.strictObject({
  provider: PlanProvider,
  /** The plan's name as the provider gives it, such as `plus`; `null` when it gives none. */
  plan: z.string().min(1).max(32).nullable(),
  windows: z
    .array(
      z.strictObject({
        /** How long the window is; `null` when not known. */
        seconds: z.number().int().positive().nullable(),
        /** The model a window counts alone, as the provider names it; `null` for all models. */
        model: z.string().min(1).max(64).nullable(),
        usedPercent: z.number().min(0).max(100),
        /** When it resets, in milliseconds since the epoch; `null` when not known. */
        resetsAt: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(8)
    .readonly(),
  /** When it was found, in milliseconds since the epoch. */
  at: z.number().int().nonnegative(),
});
export type PlanUsage = z.infer<typeof PlanUsage>;

/**
 * A session's status bar figures, each `null` while unknown (SPEC-0001, "状态栏（M1.8）").
 *
 * @remarks
 * `turns`, `steps`, `tokens` and `cost` are pi's `get_session_stats`, over the whole session file;
 * `reasoning` and `branchTokens` the host adds up from the entries; `context` is pi's estimate
 * with the host's split of it and pi's compaction reserve; `timing` the host measured while it
 * ran; `plan` the usage of the subscription of the session's model.
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
      /** What fills it; `null` when pi stated no system prompt on the branch. */
      parts: ContextParts.nullable(),
      reserve: ContextReserve,
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
  plan: PlanUsage.nullable(),
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
  plan: null,
};

/** A status bar group's id, as preferences keep it. */
export const StatusGroupId = z.string().min(1).max(64);
