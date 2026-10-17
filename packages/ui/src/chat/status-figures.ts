import type { PlanUsage, Plans, SessionMetrics, StatusBarChoices } from "@atrium/protocol";

/** The tokens pi counted for the whole session file. */
type Tokens = NonNullable<SessionMetrics["tokens"]>;
/** The context's size and split. */
type Context = NonNullable<SessionMetrics["context"]>;
/** A subscription's usage, as the host found it. */
type Plan = PlanUsage;

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
  { id: "plan", name: "套餐", description: "当前订阅的用量，悬停看所有订阅和重置时间", defaultVisible: true },
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

/** The kinds of the context card's rows, in their order (SPEC-0001, "M1.13 的上下文细分与套餐用量"). */
export type ContextRowKey = "messages" | "system" | "memory" | "skills" | "builtin" | "mcp" | "extensions";

/** A row of the context card: what it counts, its tokens, how many things, and those things. */
export interface ContextRow {
  readonly key: ContextRowKey;
  readonly name: string;
  readonly tokens: number;
  /** How many files, skills or tools; `null` for a row of no such things. */
  readonly count: number | null;
  /** What the row opens to, most tokens first; empty for a row that does not open. */
  readonly items: readonly { readonly name: string; readonly tokens: number }[];
}

/** The rows' names. */
const ROW_NAMES: Readonly<Record<ContextRowKey, string>> = {
  messages: "对话消息",
  system: "系统提示词",
  memory: "记忆文件",
  skills: "Skills",
  builtin: "内置工具",
  mcp: "MCP 工具",
  extensions: "扩展",
};

/**
 * The context split by what fills it, with what pi keeps free and what is left.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): the conversation is what the other rows leave of
 * the context, never below none, as they are estimates; a row of no tokens is left out but the
 * conversation's. A memory file is named by its path; an MCP server by its name and how many tools
 * it has. What is free is the window less the context and the reserve, never below none. Whether
 * pi compacts on its own is on (with a reserve), off, or unknown. Unknown unless the context's
 * tokens and parts are known.
 *
 * @sideEffects none
 * @param context - The context.
 * @returns The rows, the reserve, whether pi compacts on its own and what is free, or `null`.
 */
export function contextRows(context: Context): {
  readonly rows: readonly ContextRow[];
  readonly reserve: number | null;
  readonly compaction: "on" | "off" | "unknown";
  readonly free: number;
} | null {
  const { tokens, parts, reserve } = context;
  if (tokens === null || parts === null) return null;
  const { system, memory, skills, builtin, mcp, extensions } = parts;
  const others: ContextRow[] = [
    { key: "system", name: ROW_NAMES.system, tokens: system, count: null, items: [] },
    {
      key: "memory",
      name: ROW_NAMES.memory,
      tokens: memory.tokens,
      count: memory.files.length,
      items: memory.files.map(({ path, tokens: fileTokens }) => ({ name: path, tokens: fileTokens })),
    },
    { key: "skills", name: ROW_NAMES.skills, tokens: skills.tokens, count: skills.items.length, items: skills.items },
    {
      key: "builtin",
      name: ROW_NAMES.builtin,
      tokens: builtin.tokens,
      count: builtin.items.length,
      items: builtin.items,
    },
    {
      key: "mcp",
      name: ROW_NAMES.mcp,
      tokens: mcp.tokens,
      count: mcp.servers.reduce((total, server) => total + server.tools, 0),
      items: mcp.servers.map((server) => ({ name: `${server.name} · ${server.tools} 个`, tokens: server.tokens })),
    },
    {
      key: "extensions",
      name: ROW_NAMES.extensions,
      tokens: extensions.tokens,
      count: extensions.items.length,
      items: extensions.items,
    },
  ];
  const used = others.reduce((total, row) => total + row.tokens, 0);
  const messages: ContextRow = {
    key: "messages",
    name: ROW_NAMES.messages,
    tokens: Math.max(0, tokens - used),
    count: null,
    items: [],
  };
  return {
    rows: [messages, ...others.filter((row) => row.tokens > 0)],
    reserve: typeof reserve === "number" ? reserve : null,
    compaction: reserve === "off" ? "off" : reserve === null ? "unknown" : "on",
    free: Math.max(0, context.window - tokens - (typeof reserve === "number" ? reserve : 0)),
  };
}

/**
 * A part of the context window as a percentage, one decimal.
 *
 * @remarks
 * As the context card writes each row's share (SPEC-0001, "M1.13 的上下文细分与套餐用量").
 *
 * @sideEffects none
 * @param tokens - The part.
 * @param window - The window.
 * @returns The text, such as `8.2%`.
 */
export function windowShare(tokens: number, window: number): string {
  return `${((tokens / window) * 100).toFixed(1)}%`;
}

/** A week, in seconds. */
const WEEK = 604_800;

/** A minute, an hour and a day, in milliseconds. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The days of the week, as a reset time names them, Sunday first. */
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** The providers' names on the plan card (SPEC-0001, "M1.13 的上下文细分与套餐用量", "M1.14 的套餐总览"). */
const PROVIDER_NAMES: Readonly<Record<Plan["provider"], string>> = {
  "openai-codex": "ChatGPT",
  anthropic: "Claude",
  xai: "Grok",
};

/**
 * How much of a subscription is used: the most of any of its windows, whole.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): the window nearest its limit is the one that binds.
 *
 * @sideEffects none
 * @param plan - The usage.
 * @returns The percentage, or `null` without windows.
 */
export function planPercent(plan: Plan): number | null {
  if (plan.windows.length === 0) return null;
  return Math.round(Math.max(...plan.windows.map((window) => window.usedPercent)));
}

/**
 * Whether a subscription's use is near its limit: 80% or more.
 *
 * @remarks
 * The plan's group and bars turn orange there (design-language, "状态栏").
 *
 * @sideEffects none
 * @param percent - The percentage used.
 * @returns Whether it is.
 */
export function planNearLimit(percent: number): boolean {
  return percent >= 80;
}

/**
 * A subscription's name on the plan card: the provider's name and the plan's.
 *
 * @remarks
 * The plan's name as the provider gives it, its first letter in capitals ("plus" is "Plus").
 *
 * @sideEffects none
 * @param plan - The usage.
 * @returns The name, such as "ChatGPT Plus".
 */
export function planName(plan: Pick<Plan, "provider" | "plan">): string {
  const name = plan.plan === null ? "" : ` ${plan.plan.charAt(0).toUpperCase()}${plan.plan.slice(1)}`;
  return `${PROVIDER_NAMES[plan.provider]}${name}`;
}

/** Providers whose models are on another provider's subscription (ADR-0012). */
const SUBSCRIPTION_OF: ReadonlyMap<string | null, Plan["provider"]> = new Map([
  // pi-claude-bridge reaches Claude through Claude Code's login, on the Claude subscription.
  ["claude-bridge", "anthropic"],
  // pi's newer "Sign in with ChatGPT", on the same ChatGPT plan as Codex's login.
  ["openai", "openai-codex"],
]);

/**
 * The subscription a model's provider is on, as the plans name it.
 *
 * @remarks
 * SPEC-0001 ("M1.14 的套餐总览"): `claude-bridge` is Claude's, `openai` ChatGPT's; any other is
 * its own.
 *
 * @sideEffects none
 * @param provider - The provider of the session's model, if any.
 * @returns The subscription's provider, or `null`.
 */
export function subscriptionOf(provider: string | null): string | null {
  return SUBSCRIPTION_OF.get(provider) ?? provider;
}

/**
 * The usage of the subscription the session's model is on, if found.
 *
 * @remarks
 * The plan group's summary counts this one alone (SPEC-0001, "M1.14 的套餐总览").
 *
 * @sideEffects none
 * @param plans - Every subscription's usage found.
 * @param provider - The provider of the session's model, if any.
 * @returns The usage, or `null`.
 */
export function currentPlan(plans: Plans, provider: string | null): Plan | null {
  const subscription = subscriptionOf(provider);
  return plans.find((plan) => plan.provider === subscription) ?? null;
}

/**
 * Every subscription's usage as the card lists it: the session's model's first, then as the host listed them.
 *
 * @remarks
 * SPEC-0001 ("M1.14 的套餐总览").
 *
 * @sideEffects none
 * @param plans - Every subscription's usage found.
 * @param provider - The provider of the session's model, if any.
 * @returns The usage, reordered.
 */
export function plansInOrder(plans: Plans, provider: string | null): Plans {
  const subscription = subscriptionOf(provider);
  return [
    ...plans.filter((plan) => plan.provider === subscription),
    ...plans.filter((plan) => plan.provider !== subscription),
  ];
}

/**
 * A product's name as the card writes it: Grok's run-together names split ("GrokBuild" is "Grok Build").
 *
 * @remarks
 * SPEC-0001 ("M1.14 的套餐总览").
 *
 * @sideEffects none
 * @param name - The name as the provider gives it.
 * @returns The name.
 */
export function partName(name: string): string {
  return name.replace(/(?<=[a-z])(?=[A-Z])/gu, " ");
}

/**
 * A window's name by its length, and the model it counts alone.
 *
 * @remarks
 * A week is "每周"; any other length in hours under two days ("5 小时窗口"), else in days; an
 * unknown length "额度". A model's window adds "· 模型名".
 *
 * @sideEffects none
 * @param window - The window's length and model.
 * @returns The name.
 */
export function windowName(window: Pick<Plan["windows"][number], "seconds" | "model">): string {
  const { seconds, model } = window;
  let name = "额度";
  if (seconds === WEEK) name = "每周";
  else if (seconds !== null) {
    name =
      seconds < 2 * 86_400
        ? `${String(Math.round(seconds / 3600))} 小时窗口`
        : `${String(Math.round(seconds / 86_400))} 天`;
  }
  return model === null ? name : `${name} · ${model}`;
}

/**
 * When a window resets, from now.
 *
 * @remarks
 * Within a day, how long until it ("4 小时 16 分后重置", "16 分后重置"); further off, the day and
 * time ("周日 08:00 重置"); past already, "即将重置", as the next ask will tell; unknown, nothing.
 *
 * @sideEffects none
 * @param resetsAt - When, in milliseconds since the epoch, or `null`.
 * @param now - The time now.
 * @returns The text, or `""`.
 */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "";
  const left = resetsAt - now;
  if (left <= 0) return "即将重置";
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.floor((left % HOUR) / MINUTE);
    return hours === 0 ? `${String(minutes)} 分后重置` : `${String(hours)} 小时 ${String(minutes)} 分后重置`;
  }
  const at = new Date(resetsAt);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  // Stryker disable next-line StringLiteral: a day of the week is always one of the seven.
  return `${WEEKDAYS[at.getDay()] ?? ""} ${time} 重置`;
}

/**
 * How long ago a plan's usage was found.
 *
 * @remarks
 * "刚刚" within a minute, then minutes, then hours.
 *
 * @sideEffects none
 * @param at - When, in milliseconds since the epoch.
 * @param now - The time now.
 * @returns The text.
 */
export function foundAgo(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return "刚刚";
  if (ago < HOUR) return `${String(Math.floor(ago / MINUTE))} 分钟前`;
  return `${String(Math.floor(ago / HOUR))} 小时前`;
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
