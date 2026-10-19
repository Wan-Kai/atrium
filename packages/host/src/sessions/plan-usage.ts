import { PLAN_PROVIDERS, type PlanReport, PiRequestError } from "@atrium/pi";
import type { PlanProvider, PlanUsage, Plans } from "@atrium/protocol";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";

/** Subscriptions' usage, found through any session's pi and the host's alone (ADR-0010, ADR-0011). */
export interface PlanUsageService {
  /** Each provider's usage as last found, in `PlanProvider`'s order; none for a provider not found. */
  current(): Plans;
  /** Tells `listener` each time any provider's usage changes; returns the unsubscribe function. */
  subscribe(listener: (plans: Plans) => void): () => void;
  /** Asks for the provider's usage through `ask`, unless it was asked within a minute or is being asked. */
  wanted(provider: PlanProvider, ask: () => Promise<PlanReport | null>): void;
  /** Takes the usage a reply brought, unasked (ADR-0012). */
  replied(report: Extract<PlanReport, { windows: unknown }>): void;
}

/** How long after asking a provider it is not asked again (ADR-0010, point 3). */
const ASK_EVERY_MS = 60_000;

/** How long usage is kept through failed asks (SPEC-0001, "M1.13 的上下文细分与套餐用量"). */
const KEEP_MS = 10 * 60_000;

/** Most windows a usage carries, as the protocol allows. */
const MAX_WINDOWS = 8;

/** A window of a subscription's usage. */
type PlanWindow = PlanUsage["windows"][number];

/** A provider's usage and asking. */
interface Entry {
  usage: PlanUsage | null;
  askedAt: number | null;
  asking: boolean;
  /** The failure the provider last reported, until it reports usage; logged once in a row. */
  failure: string | null;
  /** Whether the usage was asked for or a reply brought it; `null` without usage. */
  source: "asked" | "reply" | null;
}

/**
 * Whether a reply's window stands for a known one: as long, and for all models.
 *
 * @remarks
 * See `replied` in `createPlanUsage`.
 *
 * @sideEffects none
 * @param known - The window known.
 * @param brought - The window a reply brought.
 * @returns Whether it does.
 */
function sameAs(known: PlanWindow, brought: PlanWindow): boolean {
  return known.model === null && known.seconds === brought.seconds;
}

/**
 * Creates the service of subscriptions' usage.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量", "M1.14 的套餐总览"): each provider is asked at most
 * once a minute, one ask at a time, whichever session asks; sessions ask for every provider after
 * their pi starts and each run. A report of usage replaces what was known, stamped with the time
 * now; usage a reply brought (ADR-0012) goes into it whenever it comes, as `replied` says. A
 * failure is logged by its provider and code alone, or an ask that failed by pi's command and
 * reason, and only when it is not the one the provider last had: every provider is asked each
 * minute, and one not signed in would log a line each time. `no_login`
 * drops at once what an ask found; what a reply brought it drops, as any other failure does, only
 * once it is ten minutes old, for one who reaches Claude through pi-claude-bridge has no login of
 * pi's to ask with. A query that found no plan query or no report, or failed, is such a failure
 * too. Listeners hear every provider's usage, only on a change.
 *
 * @sideEffects none until used; then calls the asks given and logs.
 * @param options - The clock and the logger.
 * @returns The service.
 */
export function createPlanUsage(options: { readonly clock: Clock; readonly logger: Logger }): PlanUsageService {
  const entries = new Map<PlanProvider, Entry>();
  const listeners = new Set<(plans: Plans) => void>();

  /**
   * The provider's entry, made on first use.
   *
   * @remarks
   * See `createPlanUsage`.
   *
   * @sideEffects May add an entry.
   * @param provider - The provider.
   * @returns The entry.
   */
  const entryOf = (provider: PlanProvider): Entry => {
    const known = entries.get(provider);
    if (known !== undefined) return known;
    const made: Entry = { usage: null, askedAt: null, asking: false, failure: null, source: null };
    entries.set(provider, made);
    return made;
  };

  /**
   * Every provider's usage found, in the order they are listed.
   *
   * @remarks
   * See `createPlanUsage`.
   *
   * @sideEffects none
   * @returns The usage.
   */
  const all = (): Plans => PLAN_PROVIDERS.flatMap((provider) => entries.get(provider)?.usage ?? []);

  /**
   * Sets the provider's usage, telling listeners when it changed.
   *
   * @remarks
   * See `createPlanUsage`.
   *
   * @sideEffects Calls listeners.
   * @param entry - The provider's entry.
   * @param usage - The usage, or none.
   */
  const set = (entry: Entry, usage: PlanUsage | null): void => {
    if (JSON.stringify(usage) === JSON.stringify(entry.usage)) return;
    entry.usage = usage;
    const plans = all();
    for (const listener of listeners) listener(plans);
  };

  /**
   * Drops what was known of a provider an ask did not find, once it is ten minutes old.
   *
   * @remarks
   * See `createPlanUsage`.
   *
   * @sideEffects May clear the usage and call listeners.
   * @param entry - The provider's entry.
   */
  const notFound = (entry: Entry): void => {
    if (entry.usage !== null && options.clock.now() - entry.usage.at >= KEEP_MS) set(entry, null);
  };

  /**
   * Takes the usage an ask found, stamped with the time now.
   *
   * @remarks
   * See `createPlanUsage`. It is the provider's whole usage, and ends a run of failures.
   *
   * @sideEffects May change the usage and call listeners.
   * @param report - The usage.
   */
  const found = (report: Extract<PlanReport, { windows: unknown }>): void => {
    const entry = entryOf(report.provider);
    entry.failure = null;
    // Stryker disable next-line StringLiteral: the source is only ever compared with "reply", which neither is.
    entry.source = "asked";
    set(entry, { provider: report.provider, plan: report.plan, windows: report.windows, at: options.clock.now() });
  };

  /**
   * Takes the usage a reply brought into what was known, stamped with the time now.
   *
   * @remarks
   * SPEC-0001 ("M1.14 的套餐总览"), ADR-0012: a reply knows Claude's five hours and week for all
   * models alone, so it replaces those windows of what was known, of the same length and no model,
   * keeps the rest, such as an ask's week of one model, and adds what was not known after them. It
   * leaves the last failure as it was: an ask's `no_login` between replies is logged once.
   *
   * @sideEffects May change the usage and call listeners.
   * @param report - The usage.
   */
  const replied = (report: Extract<PlanReport, { windows: unknown }>): void => {
    const entry = entryOf(report.provider);
    const known = entry.usage?.windows ?? [];
    const windows = [
      ...known.map((window) => report.windows.find((brought) => sameAs(window, brought)) ?? window),
      ...report.windows.filter((brought) => !known.some((window) => sameAs(window, brought))),
    ];
    entry.source = "reply";
    set(entry, {
      provider: report.provider,
      plan: entry.usage?.plan ?? report.plan,
      windows: windows.slice(0, MAX_WINDOWS),
      at: options.clock.now(),
    });
  };

  /**
   * Logs a provider's failure unless it is the one it last had, and keeps it as the last.
   *
   * @remarks
   * See `createPlanUsage`: an extension's failure code, or an ask that failed, by pi's command and reason.
   *
   * @sideEffects May log.
   * @param entry - The provider's entry.
   * @param failure - The failure, as one key.
   * @param fields - What the log line carries.
   * @param message - The log line's message.
   */
  const failed = (entry: Entry, failure: string, fields: Record<string, unknown>, message: string): void => {
    if (failure !== entry.failure) options.logger.info(fields, message);
    entry.failure = failure;
  };

  /**
   * Takes what an ask brought.
   *
   * @remarks
   * See `createPlanUsage`.
   *
   * @sideEffects May change the usage and call listeners; logs a failure not logged last time.
   * @param provider - The provider asked.
   * @param report - The report, or `null` for none.
   */
  const take = (provider: PlanProvider, report: PlanReport | null): void => {
    const entry = entryOf(provider);
    if (report === null) {
      notFound(entry);
      return;
    }
    if ("failure" in report) {
      failed(entry, report.failure, { provider, failure: report.failure }, "plan usage unavailable");
      if (report.failure === "no_login" && entry.source !== "reply") set(entry, null);
      else notFound(entry);
      return;
    }
    found(report);
  };

  return {
    current: all,
    replied,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    wanted(provider, ask) {
      const entry = entryOf(provider);
      const now = options.clock.now();
      if (entry.asking || (entry.askedAt !== null && now - entry.askedAt < ASK_EVERY_MS)) return;
      entry.asking = true;
      entry.askedAt = now;
      // Fire and forget: what it brings is taken, a failure is logged.
      void ask()
        .then(
          (report) => take(provider, report),
          (error: unknown) => {
            // A failed pi request is logged by its command and reason only, as elsewhere (security.md).
            const fields =
              error instanceof PiRequestError
                ? { provider, command: error.command, reason: error.reason }
                : { provider, reason: "unknown" };
            // Kept apart from the extension's codes, which are lowercase words without a colon.
            const failure = error instanceof PiRequestError ? `ask:${error.command}:${error.reason}` : "ask:unknown";
            failed(entry, failure, fields, "plan usage not asked");
            notFound(entry);
          },
        )
        .finally(() => {
          entry.asking = false;
        });
    },
  };
}
