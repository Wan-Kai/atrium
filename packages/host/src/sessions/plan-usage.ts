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
}

/** How long after asking a provider it is not asked again (ADR-0010, point 3). */
const ASK_EVERY_MS = 60_000;

/** How long usage is kept through failed asks (SPEC-0001, "M1.13 的上下文细分与套餐用量"). */
const KEEP_MS = 10 * 60_000;

/** A provider's usage and asking. */
interface Entry {
  usage: PlanUsage | null;
  askedAt: number | null;
  asking: boolean;
  /** The failure the provider last reported, until it reports usage; logged once in a row. */
  failure: string | null;
}

/**
 * Creates the service of subscriptions' usage.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量", "M1.14 的套餐总览"): each provider is asked at most
 * once a minute, one ask at a time, whichever session asks; sessions ask for every provider after
 * their pi starts and each run. A report of usage replaces what was known, stamped with the time
 * now. A failure is logged by its provider and code alone, and only when it is not the one the
 * provider last reported: every provider is asked each minute, and one not signed in would log a
 * line each time. `no_login` drops what was known at once. Any other failure, as a query that found
 * no plan query or no report, or failed, drops it only once it is ten minutes old. Listeners hear
 * every provider's usage, only on a change.
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
    const made: Entry = { usage: null, askedAt: null, asking: false, failure: null };
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
      if (report.failure !== entry.failure) {
        options.logger.info({ provider, failure: report.failure }, "plan usage unavailable");
      }
      entry.failure = report.failure;
      if (report.failure === "no_login") set(entry, null);
      else notFound(entry);
      return;
    }
    entry.failure = null;
    set(entry, { provider, plan: report.plan, windows: report.windows, at: options.clock.now() });
  };

  return {
    current: all,
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
            options.logger.info(
              error instanceof PiRequestError
                ? { provider, command: error.command, reason: error.reason }
                : { provider, reason: "unknown" },
              "plan usage not asked",
            );
            notFound(entry);
          },
        )
        .finally(() => {
          entry.asking = false;
        });
    },
  };
}
