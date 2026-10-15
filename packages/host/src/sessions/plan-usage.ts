import { type PlanReport, PiRequestError } from "@atrium/pi";
import type { PlanProvider, PlanUsage } from "@atrium/protocol";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";

/** Subscriptions' usage, found through sessions' pi and shared by every session of a provider (ADR-0010). */
export interface PlanUsageService {
  /** The provider's usage as last found, or none. */
  current(provider: PlanProvider): PlanUsage | null;
  /** Tells `listener` each time the provider's usage changes; returns the unsubscribe function. */
  subscribe(provider: PlanProvider, listener: (usage: PlanUsage | null) => void): () => void;
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
  readonly listeners: Set<(usage: PlanUsage | null) => void>;
}

/**
 * Creates the service of subscriptions' usage.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): each provider is asked at most once a minute, one ask
 * at a time; sessions ask after their pi starts, each run and a model change. A report of usage
 * replaces what was known, stamped with the time now. A failure is logged by its provider and code
 * alone; `no_login` drops what was known at once, any other failure only once it is ten minutes
 * old. A query that found no plan query or no report, or failed, changes nothing. Listeners hear
 * only changes.
 *
 * @sideEffects none until used; then calls the asks given and logs.
 * @param options - The clock and the logger.
 * @returns The service.
 */
export function createPlanUsage(options: { readonly clock: Clock; readonly logger: Logger }): PlanUsageService {
  const entries = new Map<PlanProvider, Entry>();

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
    const made: Entry = { usage: null, askedAt: null, asking: false, listeners: new Set() };
    entries.set(provider, made);
    return made;
  };

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
    for (const listener of entry.listeners) listener(usage);
  };

  /**
   * Takes what an ask brought.
   *
   * @remarks
   * See `createPlanUsage`.
   *
   * @sideEffects May change the usage and call listeners; logs a failure.
   * @param provider - The provider asked.
   * @param report - The report, or `null` for none.
   */
  const take = (provider: PlanProvider, report: PlanReport | null): void => {
    const entry = entryOf(provider);
    if (report === null) return;
    const now = options.clock.now();
    if ("failure" in report) {
      options.logger.info({ provider, failure: report.failure }, "plan usage unavailable");
      const stale = entry.usage !== null && now - entry.usage.at >= KEEP_MS;
      if (report.failure === "no_login" || stale) set(entry, null);
      return;
    }
    set(entry, { provider, plan: report.plan, windows: report.windows, at: now });
  };

  return {
    current: (provider) => entries.get(provider)?.usage ?? null,
    subscribe(provider, listener) {
      const { listeners } = entryOf(provider);
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
          (error: unknown) =>
            // A failed pi request is logged by its command and reason only, as elsewhere (security.md).
            options.logger.info(
              error instanceof PiRequestError
                ? { provider, command: error.command, reason: error.reason }
                : { provider, reason: "unknown" },
              "plan usage not asked",
            ),
        )
        .finally(() => {
          entry.asking = false;
        });
    },
  };
}
