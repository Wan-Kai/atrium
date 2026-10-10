import type { SessionMetrics, StatusBarChoices } from "@atrium/protocol";

/** The tokens pi counted for the whole session file. */
type Tokens = NonNullable<SessionMetrics["tokens"]>;
/** The context's size and split. */
type Context = NonNullable<SessionMetrics["context"]>;

/** A group of the status bar, as the registry lists it (SPEC-0001, "状态栏"). */
export interface StatusGroup {
  readonly id: string;
  readonly name: string;
  /** One line on what it shows, for the panel that switches groups on and off. */
  readonly description: string;
  readonly defaultVisible: boolean;
}

/**
 * The status bar's groups, in the order they show.
 *
 * @remarks
 * A new figure goes into a group's card, or a new group here; the bar itself does not change
 * (SPEC-0001, "状态栏"). Summaries and cards are drawn by `status-bar.tsx`.
 */
export const STATUS_GROUPS: readonly StatusGroup[] = [
  { id: "session", name: "会话统计", description: "轮数、步数、输出速度", defaultVisible: true },
  { id: "tokens", name: "Token 用量", description: "总用量与缓存命中率", defaultVisible: true },
  { id: "context", name: "上下文", description: "已用比例，悬停看分段", defaultVisible: true },
  { id: "cost", name: "费用", description: "按 API 价格折算，订阅不实际付费", defaultVisible: false },
];

/**
 * A count of tokens in a few characters.
 *
 * @remarks
 * As the prototype writes it: whole below a thousand, rounded thousands as `K`, millions with one
 * decimal as `M`.
 *
 * @sideEffects none
 * @param count - The tokens.
 * @returns The text.
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}K`;
  return String(count);
}

/**
 * A count written whole, thousands separated, as the cards show it.
 *
 * @remarks
 * See `formatTokens` for the short form.
 *
 * @sideEffects none
 * @param count - The count.
 * @returns The text.
 */
export function formatWhole(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}

/**
 * A duration in seconds with one decimal.
 *
 * @remarks
 * As the cards show the model's time and the time to the first output.
 *
 * @sideEffects none
 * @param ms - Milliseconds.
 * @returns The text.
 */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * Output tokens a second, rounded.
 *
 * @remarks
 * See `formatSeconds`.
 *
 * @sideEffects none
 * @param tps - The speed.
 * @returns The text, without its unit.
 */
export function formatSpeed(tps: number): string {
  return String(Math.round(tps));
}

/**
 * A cost in dollars, approximate.
 *
 * @remarks
 * Converted at API prices; a subscription pays none of it (SPEC-0001, "状态栏").
 *
 * @sideEffects none
 * @param cost - US dollars.
 * @returns The text.
 */
export function formatCost(cost: number): string {
  return `≈ $${cost.toFixed(2)}`;
}

/**
 * All the tokens pi counted.
 *
 * @remarks
 * See `cacheHit`.
 *
 * @sideEffects none
 * @param tokens - The four kinds.
 * @returns Their sum.
 */
export function totalTokens(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * The share of the input read from the cache, in whole percent.
 *
 * @remarks
 * `cacheRead` ÷ (`input` + `cacheRead` + `cacheWrite`) (SPEC-0001, "状态栏"); unknown without input.
 *
 * @sideEffects none
 * @param tokens - The four kinds.
 * @returns The percentage, or `null`.
 */
export function cacheHit(tokens: Tokens): number | null {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return input === 0 ? null : Math.round((tokens.cacheRead / input) * 100);
}

/**
 * How much of the context window is used, in whole percent.
 *
 * @remarks
 * Unknown after a compaction until the next reply (SPEC-0001, "状态栏（M1.8）").
 *
 * @sideEffects none
 * @param context - The context.
 * @returns The percentage, or `null`.
 */
export function contextPercent(context: Context): number | null {
  return context.tokens === null ? null : Math.round((context.tokens / context.window) * 100);
}

/**
 * The colour the context's figure takes.
 *
 * @remarks
 * Yellow past 70%, red past 85% (SPEC-0001, "状态栏").
 *
 * @sideEffects none
 * @param percent - The context used, or `null`.
 * @returns The level.
 */
export function contextLevel(percent: number | null): "normal" | "warn" | "danger" {
  // Stryker disable next-line ConditionalExpression: `null` compares as 0, which is normal too.
  if (percent === null || percent <= 70) return "normal";
  return percent > 85 ? "danger" : "warn";
}

/**
 * The context split into the system prompt, the tools and the conversation.
 *
 * @remarks
 * The conversation is what is left, never below none, as the shares are estimates (SPEC-0001,
 * "上下文分段"); unknown unless all three can be told.
 *
 * @sideEffects none
 * @param context - The context.
 * @returns The three parts, or `null`.
 */
export function contextSegments(
  context: Context,
): { readonly system: number; readonly tools: number; readonly messages: number } | null {
  const { tokens, system, tools } = context;
  if (tokens === null || system === null || tools === null) return null;
  return { system, tools, messages: Math.max(0, tokens - system - tools) };
}

/**
 * The groups the bar shows, in the registry's order.
 *
 * @remarks
 * A group not chosen either way shows as its default says, so one added later appears unless
 * switched off (SPEC-0001, "状态栏（M1.8）").
 *
 * @sideEffects none
 * @param choices - The groups switched from their default.
 * @returns Their ids.
 */
export function shownGroups(choices: StatusBarChoices): string[] {
  return STATUS_GROUPS.filter((group) => choices[group.id] ?? group.defaultVisible).map((group) => group.id);
}

/**
 * The choices after switching one group on or off.
 *
 * @remarks
 * Only switches away from a default are kept; choices of groups this version does not know stay
 * as they are.
 *
 * @sideEffects none
 * @param choices - The choices so far.
 * @param id - The group.
 * @param on - Whether it shows.
 * @returns The new choices.
 */
export function withChoice(choices: StatusBarChoices, id: string, on: boolean): StatusBarChoices {
  const { [id]: _before, ...others } = choices;
  const group = STATUS_GROUPS.find((candidate) => candidate.id === id);
  return group?.defaultVisible === on ? others : { ...others, [id]: on };
}
