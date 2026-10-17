import type { PlanProvider } from "@atrium/protocol";
import type { PiEvent, PiResponseData } from "../process/pi-process";

/** The command the host asks a session's pi for a subscription's usage with: `/atrium-plan <provider>` (ADR-0010). */
export const PLAN_COMMAND = "atrium-plan";

/** The key of the status the extension reports a subscription's usage under. */
export const PLAN_STATUS = "atrium-plan";

/** The key of the status the extension reports Claude's usage under as replies bring it (ADR-0012). */
export const PLAN_REPLY_STATUS = "atrium-plan-reply";

/** A product's share of a window's use: part of the window's percentage, not a limit of its own. */
interface PlanPart {
  readonly name: string;
  readonly usedPercent: number;
}

/** A window of a subscription's usage, as the extension reports it. */
export interface PlanWindow {
  /** How long the window is; `null` when not known. */
  readonly seconds: number | null;
  /** The model the window counts alone; `null` for all models. */
  readonly model: string | null;
  readonly usedPercent: number;
  /** When it resets, in milliseconds since the epoch; `null` when not known. */
  readonly resetsAt: number | null;
  /** The window's use by product; Grok's alone, empty for the others (SPEC-0001, "M1.14 的套餐总览"). */
  readonly parts: readonly PlanPart[];
}

/** What the extension reports to the host: a subscription's usage, or why there is none. */
export type PlanReport =
  | { readonly provider: PlanProvider; readonly plan: string | null; readonly windows: readonly PlanWindow[] }
  | { readonly provider: PlanProvider; readonly failure: string };

/**
 * The subscriptions whose usage Atrium asks for (ADR-0010, ADR-0011), in the order they are listed.
 *
 * @remarks
 * The protocol's `PlanProvider` without importing its schema, which the extension's bundle would
 * then carry into every pi.
 */
export const PLAN_PROVIDERS: readonly PlanProvider[] = ["openai-codex", "anthropic", "xai"];

/**
 * Whether a provider is one Atrium asks for the usage of.
 *
 * @remarks
 * See `PLAN_PROVIDERS`.
 *
 * @sideEffects none
 * @param provider - The provider, as pi names it.
 * @returns Whether it is.
 */
export function isPlanProvider(provider: unknown): provider is PlanProvider {
  return PLAN_PROVIDERS.some((known) => known === provider);
}

/** A five-hour window, in seconds. */
const FIVE_HOURS = 18_000;

/** A week, in seconds. */
const WEEK = 604_800;

/** Most windows a report may carry, as the protocol allows. */
const MAX_WINDOWS = 8;

/** Longest model name a report may carry, as the protocol allows. */
const MAX_MODEL = 64;

/** Most products a window may carry, as the protocol allows. */
const MAX_PARTS = 16;

/** Longest product name a report may carry, as the protocol allows. */
const MAX_PART_NAME = 64;

/** Longest plan name a report may carry, as the protocol allows. */
const MAX_PLAN = 32;

/** Longest failure code a report may carry. */
const MAX_FAILURE = 40;

/**
 * Reads a field of a value that may be an object.
 *
 * @remarks
 * The usage answers and the reports are whatever JSON came.
 *
 * @sideEffects none
 * @param value - The value.
 * @param key - The field.
 * @returns The field's value, or `undefined`.
 */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

/**
 * A number, if the value is a finite one.
 *
 * @remarks
 * See `fieldOf`.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns The number, or `null`.
 */
function numberOf(value: unknown): number | null {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: JSON has no number that is not finite; the check narrows the type.
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A time in milliseconds since the epoch from an ISO date.
 *
 * @remarks
 * Claude gives reset times as ISO dates, Grok its period's bounds; one that does not parse is not known.
 *
 * @sideEffects none
 * @param value - The date.
 * @returns The time, or `null`.
 */
function isoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * ChatGPT's usage from its answer to `wham/usage`.
 *
 * @remarks
 * ADR-0010: `rate_limit.primary_window` and `secondary_window`, each `used_percent`,
 * `limit_window_seconds` and `reset_at` in seconds; `plan_type` names the plan. A window without a
 * percentage is left out; an answer with none is not usage.
 *
 * @sideEffects none
 * @param body - The answer.
 * @returns The plan and its windows, or `null`.
 */
export function codexUsage(body: unknown): { plan: string | null; windows: PlanWindow[] } | null {
  const limits = fieldOf(body, "rate_limit");
  const windows = ["primary_window", "secondary_window"].flatMap((key): PlanWindow[] => {
    const window = fieldOf(limits, key);
    const used = numberOf(fieldOf(window, "used_percent"));
    if (used === null) return [];
    const seconds = numberOf(fieldOf(window, "limit_window_seconds"));
    const reset = numberOf(fieldOf(window, "reset_at"));
    return [{ seconds, model: null, usedPercent: used, resetsAt: reset === null ? null : reset * 1000, parts: [] }];
  });
  if (windows.length === 0) return null;
  const plan = fieldOf(body, "plan_type");
  return { plan: typeof plan === "string" && plan !== "" ? plan : null, windows };
}

/** Claude's windows of the older answer: key, length and the model it counts alone. */
const CLAUDE_FLAT: readonly (readonly [string, number, string | null])[] = [
  ["five_hour", FIVE_HOURS, null],
  ["seven_day", WEEK, null],
  ["seven_day_opus", WEEK, "Opus"],
  ["seven_day_sonnet", WEEK, "Sonnet"],
];

/**
 * Claude's usage from its answer to `api/oauth/usage`.
 *
 * @remarks
 * ADR-0010: the newer answer lists `limits[]`, `session` and `weekly_all` a window each and
 * `weekly_scoped` one for each model (`scope.model.display_name`), with `percent` and `resets_at`;
 * other kinds are left out. Without them, the older `five_hour`, `seven_day`, `seven_day_opus` and
 * `seven_day_sonnet` that are not `null`, each `utilization` and `resets_at`. Claude names no plan.
 * An answer with no window is not usage; one with more than Atrium takes keeps the first eight.
 *
 * @sideEffects none
 * @param body - The answer.
 * @returns The windows, or `null`.
 */
export function claudeUsage(body: unknown): PlanWindow[] | null {
  const limits = fieldOf(body, "limits");
  const windows = Array.isArray(limits)
    ? limits.flatMap((limit: unknown): PlanWindow[] => {
        const kind = fieldOf(limit, "kind");
        const used = numberOf(fieldOf(limit, "percent"));
        const resetsAt = isoTime(fieldOf(limit, "resets_at"));
        if (used === null) return [];
        if (kind === "session") return [{ seconds: FIVE_HOURS, model: null, usedPercent: used, resetsAt, parts: [] }];
        if (kind === "weekly_all") return [{ seconds: WEEK, model: null, usedPercent: used, resetsAt, parts: [] }];
        const model = fieldOf(fieldOf(fieldOf(limit, "scope"), "model"), "display_name");
        if (kind !== "weekly_scoped" || typeof model !== "string" || model === "") return [];
        return [{ seconds: WEEK, model, usedPercent: used, resetsAt, parts: [] }];
      })
    : CLAUDE_FLAT.flatMap(([key, seconds, model]): PlanWindow[] => {
        const used = numberOf(fieldOf(fieldOf(body, key), "utilization"));
        if (used === null) return [];
        const resetsAt = isoTime(fieldOf(fieldOf(body, key), "resets_at"));
        return [{ seconds, model, usedPercent: used, resetsAt, parts: [] }];
      });
  // Atrium takes eight at most: one for each model past that would lose them all.
  return windows.length === 0 ? null : windows.slice(0, MAX_WINDOWS);
}

/** The providers whose replies carry Claude's subscription's usage: pi's own and pi-claude-bridge's (ADR-0012). */
const CLAUDE_REPLIERS: ReadonlySet<string> = new Set(["anthropic", "claude-bridge"]);

/**
 * Whether a model's replies carry Claude's subscription's usage.
 *
 * @remarks
 * See `CLAUDE_REPLIERS`.
 *
 * @sideEffects none
 * @param provider - The model's provider, as pi names it.
 * @returns Whether they do.
 */
export function repliesWithClaudeUsage(provider: string): boolean {
  return CLAUDE_REPLIERS.has(provider);
}

/** The prefix of the reply headers Claude's usage is in. */
const UNIFIED = "anthropic-ratelimit-unified";

/** Claude's windows the reply headers name: the abbreviation and the window's length. */
const UNIFIED_WINDOWS: readonly (readonly [string, number])[] = [
  ["5h", FIVE_HOURS],
  ["7d", WEEK],
];

/**
 * A number a header holds, if it holds one.
 *
 * @remarks
 * Headers are text; an empty one is not 0.
 *
 * @sideEffects none
 * @param value - The header's value.
 * @returns The number, or `null`.
 */
function headerNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Claude's usage from a reply's headers.
 *
 * @remarks
 * ADR-0012: `anthropic-ratelimit-unified-5h-utilization` and `-7d-utilization`, 0 to 1, each with
 * its `-reset` in seconds; names in any case. A window without its utilization is left out;
 * headers with neither are not usage. The percentage is kept to two places, as a fraction times
 * 100 is not always whole.
 *
 * @sideEffects none
 * @param headers - The reply's headers.
 * @returns The windows, or `null`.
 */
export function replyUsage(headers: Readonly<Record<string, string>>): PlanWindow[] | null {
  const named = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const windows = UNIFIED_WINDOWS.flatMap(([name, seconds]): PlanWindow[] => {
    const used = headerNumber(named.get(`${UNIFIED}-${name}-utilization`));
    if (used === null) return [];
    const reset = headerNumber(named.get(`${UNIFIED}-${name}-reset`));
    return [
      {
        seconds,
        model: null,
        usedPercent: Math.round(used * 10_000) / 100,
        resetsAt: reset === null ? null : reset * 1000,
        parts: [],
      },
    ];
  });
  return windows.length === 0 ? null : windows;
}

/**
 * Grok's usage from its answer to `cli-chat-proxy.grok.com/v1/billing?format=credits`.
 *
 * @remarks
 * ADR-0011, SPEC-0001 ("M1.14 的套餐总览"): one window, `config.creditUsagePercent` of the period
 * `config.currentPeriod` from `start` to `end`, which is when it resets; each of
 * `config.productUsage` a part, `product` and `usagePercent`. Grok leaves out a percentage of 0,
 * so a missing one counts as 0 for the window when the period is there, and for a product always;
 * a product without a name is left out. An answer with neither percentage nor period is not usage.
 *
 * @sideEffects none
 * @param body - The answer.
 * @returns The window, or `null`.
 */
export function grokUsage(body: unknown): PlanWindow[] | null {
  const config = fieldOf(body, "config");
  const period = fieldOf(config, "currentPeriod");
  const used = numberOf(fieldOf(config, "creditUsagePercent"));
  if (used === null && (typeof period !== "object" || period === null)) return null;
  const start = isoTime(fieldOf(period, "start"));
  const end = isoTime(fieldOf(period, "end"));
  const products = fieldOf(config, "productUsage");
  const parts = Array.isArray(products)
    ? products.flatMap((product: unknown): PlanPart[] => {
        const name = fieldOf(product, "product");
        if (typeof name !== "string" || name === "") return [];
        return [{ name, usedPercent: numberOf(fieldOf(product, "usagePercent")) ?? 0 }];
      })
    : [];
  return [
    {
      // Stryker disable next-line ConditionalExpression: `null > start` is false too; the check narrows the type.
      seconds: start !== null && end !== null && end > start ? Math.round((end - start) / 1000) : null,
      model: null,
      usedPercent: used ?? 0,
      resetsAt: end,
      parts: parts.slice(0, MAX_PARTS),
    },
  ];
}

/**
 * A reported window's products, made to fit the protocol, or `null` when they cannot be.
 *
 * @remarks
 * See `readPlanReport`. None reported is none.
 *
 * @sideEffects none
 * @param value - The products as reported.
 * @returns The products.
 */
function reportedParts(value: unknown): PlanPart[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PARTS) return null;
  const read = value.flatMap((part: unknown): PlanPart[] => {
    const name = fieldOf(part, "name");
    const used = numberOf(fieldOf(part, "usedPercent"));
    if (typeof name !== "string" || name === "" || used === null) return [];
    return [{ name: name.slice(0, MAX_PART_NAME), usedPercent: Math.min(100, Math.max(0, used)) }];
  });
  return read.length === value.length ? read : null;
}

/**
 * A reported window, made to fit the protocol, or `null` when it cannot be.
 *
 * @remarks
 * See `readPlanReport`.
 *
 * @sideEffects none
 * @param value - The window as reported.
 * @returns The window.
 */
function reportedWindow(value: unknown): PlanWindow | null {
  const used = numberOf(fieldOf(value, "usedPercent"));
  const parts = reportedParts(fieldOf(value, "parts"));
  if (used === null || parts === null) return null;
  const seconds = numberOf(fieldOf(value, "seconds"));
  const reported = numberOf(fieldOf(value, "resetsAt"));
  const resetsAt = reported === null ? null : Math.round(reported);
  const model = fieldOf(value, "model");
  return {
    // Stryker disable next-line ConditionalExpression: `Number.isSafeInteger` is false for `null` too; the check narrows the type.
    seconds: seconds !== null && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null,
    model: typeof model === "string" && model !== "" ? model.slice(0, MAX_MODEL) : null,
    usedPercent: Math.min(100, Math.max(0, used)),
    // Stryker disable next-line ConditionalExpression: `Number.isSafeInteger` is false for `null` too; the check narrows the type.
    resetsAt: resetsAt !== null && Number.isSafeInteger(resetsAt) && resetsAt >= 0 ? resetsAt : null,
    parts,
  };
}

/**
 * Reads the extension's report of a subscription's usage, as it set it in its status.
 *
 * @remarks
 * The host takes nothing from the extension on trust (security.md, "Atrium 自带的 pi 扩展"): the
 * provider must be one Atrium asks for; a failure is a short code of lowercase letters, digits and
 * `_`; at most eight windows, each with a percentage, which is held to 0–100, a length that is a
 * positive safe whole number of seconds or none, a reset time not before the epoch and a safe whole
 * number once rounded or none, a model name cut to 64 characters, and at most sixteen products,
 * each a name cut to 64 characters and a percentage held to 0–100 (none reported is none); a plan
 * name is cut to 32. Anything else is no report.
 *
 * @sideEffects none
 * @param text - The status's text.
 * @returns The report, or `null`.
 */
export function readPlanReport(text: string | undefined): PlanReport | null {
  let parsed: unknown;
  try {
    // Stryker disable next-line StringLiteral: no text and text that is not JSON both throw into the catch.
    parsed = JSON.parse(text ?? "");
  } /* Stryker disable next-line BlockStatement: an empty catch leaves nothing parsed, which has no provider either. */ catch {
    return null;
  }
  const provider = fieldOf(parsed, "provider");
  if (!isPlanProvider(provider)) return null;
  const failure = fieldOf(parsed, "failure");
  if (failure !== undefined) {
    return typeof failure === "string" && /^[a-z0-9_]+$/u.test(failure) && failure.length <= MAX_FAILURE
      ? { provider, failure }
      : null;
  }
  const windows = fieldOf(parsed, "windows");
  if (!Array.isArray(windows) || windows.length > MAX_WINDOWS) return null;
  const read = windows.flatMap((window: unknown) => reportedWindow(window) ?? []);
  if (read.length !== windows.length) return null;
  const plan = fieldOf(parsed, "plan");
  return {
    provider,
    plan: typeof plan === "string" && plan !== "" ? plan.slice(0, MAX_PLAN) : null,
    windows: read,
  };
}

/**
 * The usage a reply brought, if pi's event is the extension's report of it.
 *
 * @remarks
 * ADR-0012: the status `atrium-plan-reply`, read as `readPlanReport` reads the query's; a failure
 * there is no report, for a reply reports usage alone.
 *
 * @sideEffects none
 * @param event - One of pi's events.
 * @returns The report, or `null`.
 */
export function planReplyOf(event: PiEvent): Extract<PlanReport, { windows: unknown }> | null {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: pi gives a status key to setStatus alone; the first two checks narrow the type.
  if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== PLAN_REPLY_STATUS)
    return null;
  const report = readPlanReport(event.statusText);
  return report === null || "failure" in report ? null : report;
}

/**
 * Whether a command is Atrium's plan query, which only its extension registers.
 *
 * @remarks
 * As for Fast: the host sends `/atrium-plan` only once pi lists it, or pi would pass the words to
 * the model (ADR-0010).
 *
 * @sideEffects none
 * @param command - The command as pi lists it.
 * @returns Whether it is.
 */
export function isPlanQuery(
  command: Pick<PiResponseData<"get_commands">["commands"][number], "name" | "source">,
): boolean {
  return command.name === PLAN_COMMAND && command.source === "extension";
}
