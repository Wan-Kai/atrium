import { open, readFile, stat } from "node:fs/promises";
import { createLineSplitter, type LineSplitter } from "../process/jsonl";

/** What a session produced: tokens of all four kinds and the cost at API prices, in US dollars. */
export interface FileUsage {
  readonly tokens: number;
  readonly cost: number;
}

/** Reads what session files produced, each file from where it was last read. */
export interface UsageReader {
  /**
   * What the file's entries after `after` produced; all of them when `after` is `null`.
   *
   * @remarks
   * A missing or unreadable file is `null`.
   */
  read(path: string, after: string | null, signal?: AbortSignal): Promise<FileUsage | null>;
  /** Forgets a file, as once its session is detached or archived. */
  forget(path: string): void;
}

/** One file as last read. */
interface FileState {
  readonly after: string | null;
  size: number;
  splitter: LineSplitter;
  /** Whether the baseline entry has gone by, so later entries count. */
  counting: boolean;
  tokens: number;
  cost: number;
}

/** How many bytes one read takes at most. */
const CHUNK_BYTES = 256 * 1024;

/**
 * A pi usage object's tokens and cost.
 *
 * @remarks
 * pi-ai's `Usage`: `input`, `output`, `cacheRead`, `cacheWrite` and `cost.total`; what is not a
 * number counts as nothing.
 *
 * @sideEffects none
 * @param usage - The usage.
 * @returns The tokens and the cost.
 */
function usageOf(usage: unknown): FileUsage {
  if (typeof usage !== "object" || usage === null) return { tokens: 0, cost: 0 };
  const tokens = ["input", "output", "cacheRead", "cacheWrite"].reduce(
    (sum, kind) => sum + count(Reflect.get(usage, kind)),
    0,
  );
  const spent: unknown = Reflect.get(usage, "cost");
  const cost = typeof spent === "object" && spent !== null ? count(Reflect.get(spent, "total")) : 0;
  return { tokens, cost };
}

/**
 * A count from pi's usage, or nothing.
 *
 * @remarks
 * What is not a finite number above zero counts as nothing, so a broken entry cannot lower a total.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns The count.
 */
function count(value: unknown): number {
  // NaN is not below Infinity either.
  return typeof value === "number" && value < Infinity ? Math.max(value, 0) : 0;
}

/**
 * A session file line's entry, or `null` for a line that is not a JSON object.
 *
 * @remarks
 * pi writes one JSON object a line; anything else (a line cut short, a value someone else wrote)
 * counts as nothing.
 *
 * @sideEffects none
 * @param line - The line.
 * @returns The entry, or `null`.
 */
function objectOf(line: string): object | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON: nothing.
  }
  return typeof parsed === "object" ? parsed : null;
}

/**
 * What one session file line produced.
 *
 * @remarks
 * pi's own sum (`getSessionStats` in pi 1.0.2 and 1.1.0): assistant messages and tool results with
 * a `usage`, compactions and branch summaries with one, and `usage` entries (SPEC-0002, "用量合计").
 *
 * @sideEffects none
 * @param entry - The parsed line.
 * @returns The tokens and the cost.
 */
function entryUsage(entry: object): FileUsage {
  const type: unknown = Reflect.get(entry, "type");
  if (type === "message") {
    const message: unknown = Reflect.get(entry, "message");
    if (typeof message !== "object" || message === null) return { tokens: 0, cost: 0 };
    const role = Reflect.get(message, "role");
    return role === "assistant" || role === "toolResult"
      ? usageOf(Reflect.get(message, "usage"))
      : { tokens: 0, cost: 0 };
  }
  if (type === "compaction" || type === "branch_summary" || type === "usage")
    return usageOf(Reflect.get(entry, "usage"));
  return { tokens: 0, cost: 0 };
}

/**
 * Creates a reader of what session files produced.
 *
 * @remarks
 * For a parent's "含子对话" figures (SPEC-0002, "用量合计"): read from the child's file, so a child
 * whose pi is not running counts too. pi only appends (pi-internals.md §1), so a file that grew is
 * read from where the last read stopped; one that shrank, or another baseline, is read again from
 * the start; reads of one file run one at a time. A line counts once its LF is written. Entries up to and including `after` are the
 * history copied from the parent and do not count; an `after` the file does not have counts
 * nothing, so a copied history is never counted twice.
 *
 * @sideEffects none until a read; reads read files.
 * @returns The reader.
 */
export function createUsageReader(): UsageReader {
  const files = new Map<string, FileState>();
  /** The last read of each file, settled however it ended, which the next waits for. */
  const reading = new Map<string, Promise<unknown>>();

  /**
   * A file's state from the start.
   *
   * @remarks
   * See `createUsageReader`.
   *
   * @sideEffects none
   * @param after - The baseline.
   * @returns The state.
   */
  function fresh(after: string | null): FileState {
    const state: FileState = {
      after,
      size: 0,
      counting: after === null,
      tokens: 0,
      cost: 0,
      splitter: createLineSplitter((line) => {
        const entry = objectOf(line);
        if (entry === null) return;
        if (!state.counting) {
          if (Reflect.get(entry, "id") === state.after) state.counting = true;
          return;
        }
        const { tokens, cost } = entryUsage(entry);
        state.tokens += tokens;
        state.cost += cost;
      }),
    };
    return state;
  }

  /**
   * Reads what a file produced since the last read of it.
   *
   * @remarks
   * See `createUsageReader`; `read` runs these one at a time per file.
   *
   * @sideEffects Reads the file; updates its state.
   * @param path - The file.
   * @param after - The baseline.
   * @param signal - Stops the read between chunks.
   * @returns The totals, or `null` for a file that is not there.
   */
  async function readNow(path: string, after: string | null, signal?: AbortSignal): Promise<FileUsage | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      files.delete(path);
      return null;
    }
    let state = files.get(path);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: starting again more often gives the same totals, only reading more.
    if (state === undefined || state.after !== after || info.size < state.size) {
      state = fresh(after);
      // Stryker disable next-line CallExpression: a state not kept is started again on the next read, with the same totals.
      files.set(path, state);
    }
    // Stryker disable next-line ConditionalExpression,EqualityOperator: with nothing new the loop below reads nothing.
    if (info.size > state.size) {
      const file = await open(path, "r");
      try {
        // Stryker disable next-line ArithmeticOperator,MethodExpression: a larger buffer reads the same bytes.
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, info.size - state.size));
        // Stryker disable next-line EqualityOperator: a read at the end gets no bytes and stops the loop.
        while (state.size < info.size) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(
            buffer,
            0,
            // Stryker disable next-line ArithmeticOperator,MethodExpression: what is left never exceeds the buffer but at the first read, where they are equal; a longer read stops at the file's end.
            Math.min(buffer.length, info.size - state.size),
            state.size,
          );
          // Stryker disable next-line ConditionalExpression: only a file cut short between the stat and the read gives no bytes.
          if (bytesRead === 0) break;
          state.splitter.push(buffer.subarray(0, bytesRead));
          state.size += bytesRead;
        }
      } finally {
        // Not seen by a test: Node lists no open file handles. A survivor in mutation testing.
        await file.close();
      }
    }
    return { tokens: state.tokens, cost: state.cost };
  }

  return {
    read(path, after, signal) {
      // Two reads of one file at once, as two ancestors refreshing, would add the same bytes twice.
      const mine = (reading.get(path) ?? Promise.resolve()).then(() => readNow(path, after, signal));
      // The next waits for this one however it ends.
      reading.set(path, Promise.allSettled([mine]));
      return mine;
    },
    forget(path) {
      files.delete(path);
    },
  };
}

/**
 * The id of the last entry of a session file, its usage baseline once copied from a parent.
 *
 * @remarks
 * SPEC-0002 ("用量合计"): a child forked from its parent counts only what comes after the entries
 * it copied, the label pi may add in forking among them. The header has no entry id, and a line
 * pi is still writing, or one that is not JSON, is passed over.
 *
 * @sideEffects Reads the file.
 * @param path - The session file.
 * @returns The id, or `null` for a file without entries.
 * @throws The file system's errors.
 */
export async function lastEntryId(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  // The text after the last LF is a line pi has not finished writing.
  lines.pop();
  for (const line of lines.toReversed()) {
    const entry = objectOf(line);
    if (entry === null) continue;
    const id: unknown = Reflect.get(entry, "id");
    if (Reflect.get(entry, "type") !== "session" && typeof id === "string") return id;
  }
  return null;
}
