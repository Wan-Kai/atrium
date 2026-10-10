import type { PiDeps } from "../deps";
import { PiRequestError } from "../process/pi-process";
import type { ModelList } from "./query";

/** The models pi can use, per directory. */
export interface ModelCatalog {
  /** Lists a directory's models: the kept answer, or pi's; `refresh` asks pi again. */
  list(dir: string, refresh: boolean): Promise<ModelList>;
  /**
   * Drops every directory's kept answer, so the next list asks pi; a query under way still
   * answers those waiting for it, but its answer is not kept.
   */
  forget(): void;
  /** Aborts the queries under way and waits for them; later lists fail. */
  close(): Promise<void>;
}

/** How long one query may take, pi's own background refresh included (Paseo's deadline). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** One directory's answer, and the query under way for it. */
interface Entry {
  list: ModelList | null;
  load: Promise<ModelList> | null;
}

/**
 * Creates the model catalog over a query that asks pi.
 *
 * @remarks
 * As Paseo does (SPEC-0001, "模型与输入框"): answers are kept per directory, since a project's own
 * settings may change which models pi can use; they are kept in memory, with no expiry, until a
 * refresh. A directory has one query at a time, which every caller in between shares, a refresh
 * included. A failed query forgets the directory's answer, so the next list asks again. Each
 * query has a deadline, after which it is aborted.
 *
 * @sideEffects none until `list`; then runs queries and timers.
 * @param options - The query, the clock for deadlines, and the deadline.
 * @returns The catalog.
 */
export function createModelCatalog(options: {
  readonly query: (dir: string, signal: AbortSignal) => Promise<ModelList>;
  readonly clock: PiDeps["clock"];
  readonly timeoutMs?: number;
}): ModelCatalog {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const entries = new Map<string, Entry>();
  const aborts = new Set<AbortController>();
  let closed = false;

  /**
   * Asks pi for a directory's models within the deadline.
   *
   * @remarks
   * See `createModelCatalog`.
   *
   * @sideEffects Runs the query and its deadline timer; updates the directory's entry.
   * @param dir - The directory.
   * @param entry - Its entry.
   * @returns The answer.
   */
  async function load(dir: string, entry: Entry): Promise<ModelList> {
    const abort = new AbortController();
    aborts.add(abort);
    const cancel = options.clock.setTimeout(() => abort.abort(), timeoutMs);
    try {
      const list = await options.query(dir, abort.signal);
      entry.list = list;
      return list;
    } catch (error) {
      entry.list = null;
      throw error;
    } finally {
      cancel();
      // Stryker disable next-line CallExpression: only frees memory; aborting a finished query does nothing.
      aborts.delete(abort);
      entry.load = null;
    }
  }

  return {
    list(dir, refresh) {
      if (closed) return Promise.reject(new PiRequestError("get_available_models", "aborted"));
      let entry = entries.get(dir);
      if (entry === undefined) {
        entry = { list: null, load: null };
        entries.set(dir, entry);
      }
      if (entry.load !== null) return entry.load;
      if (!refresh && entry.list !== null) return Promise.resolve(entry.list);
      entry.load = load(dir, entry);
      return entry.load;
    },
    forget() {
      // A load under way writes to its own entry, no longer here.
      entries.clear();
    },
    async close() {
      closed = true;
      const loads = [...entries.values()].flatMap((entry) => (entry.load === null ? [] : [entry.load]));
      for (const abort of aborts) abort.abort();
      await Promise.all(loads.map((loading) => loading.catch(() => undefined)));
    },
  };
}
