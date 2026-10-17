import { type LogEntry, type PiStats, type TranslatedEvent, contextParts } from "@atrium/pi";
import type { ContextParts, ContextReserve, SessionMetrics } from "@atrium/protocol";
import type { Clock } from "../platform/clock";

/** Works out a session's status bar figures (SPEC-0001, "状态栏（M1.8）"). */
export interface MetricsTracker {
  /** Takes one of pi's events: times requests, and reads pi's statistics after replies and runs. */
  observe(event: TranslatedEvent): void;
  /** Works out again what comes from the entries: the whole file's and the current branch's. */
  entriesChanged(all: readonly LogEntry[], branch: readonly LogEntry[]): void;
  /** Reads pi's statistics and compaction reserve again, as once pi has started or the model changed. */
  refresh(): void;
  /** Publishes the figures again for the session's model now, whose provider may send another prompt. */
  modelChanged(): void;
  /** pi exited or another took over: a request it was answering is no longer timed. */
  piChanged(): void;
  /** The figures now. */
  current(): SessionMetrics;
  /**
   * Stops reading and publishing.
   *
   * @remarks
   * A read under way is not waited for: pi's stopping ends it, and what it brings is dropped.
   */
  close(): void;
  /** Reads and publishes again after `close`, as once the session is started anew. */
  reopen(): void;
}

/** A request being timed: when it started, and the compaction time within it. */
interface Timed {
  readonly start: number;
  paused: number;
  pausedAt: number | null;
  firstOutput: number | null;
}

/**
 * Adds up a list of numbers.
 *
 * @remarks
 * See `createMetricsTracker`.
 *
 * @sideEffects none
 * @param values - The numbers.
 * @returns Their sum.
 */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * The context's parts with each memory file under the home directory written from `~`.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): pi names memory files by their full paths.
 *
 * @sideEffects none
 * @param parts - The parts.
 * @param home - The home directory, or `undefined` to keep the paths.
 * @returns The parts.
 */
function fromHome(parts: ContextParts, home: string | undefined): ContextParts {
  if (home === undefined || home === "") return parts;
  const files = parts.memory.files.map((file) =>
    file.path.startsWith(`${home}/`) ? { ...file, path: `~${file.path.slice(home.length)}` } : file,
  );
  return { ...parts, memory: { ...parts.memory, files } };
}

/**
 * Knows no compaction reserve.
 *
 * @remarks
 * For a tracker not given how to read it.
 *
 * @sideEffects none
 * @returns `null`.
 */
async function noReserve(): Promise<ContextReserve> {
  return null;
}

/**
 * Creates the tracker of a session's status bar figures.
 *
 * @remarks
 * SPEC-0001 ("状态栏（M1.8）"). pi's `get_session_stats` is read after each assistant message,
 * compaction and run, and when asked; one read at a time, and asks during a read make one more
 * read after it. A read that fails keeps the figures known before. Each read also reads pi's
 * compaction reserve, unknown when that fails (SPEC-0001, "M1.13 的上下文细分与套餐用量"). The
 * whole file's reasoning tokens, the branch's tokens and what fills the context come from the
 * entries, the context split for the provider of the session's model and again when it changes;
 * the plan's usage is given.
 * A request is timed from pi's `turn_start`, leaving out a compaction within it: the time to its
 * first output is averaged over requests that had output; the model's time adds up every request
 * that ended in an assistant message; the speed is the last reply's output tokens over the time
 * from its first output to its end, kept when a reply had no output or no time to stream. A change
 * goes to `onChange` only when the figures differ from those last given.
 *
 * @sideEffects none until used; then reads pi's statistics through `readStats`, calls `onChange`
 * and `onReadFailed`.
 * @param options - The clock, how to read pi's statistics and compaction reserve, the provider of
 * the session's model, and where changes and failed reads go.
 * @returns The tracker.
 */
export function createMetricsTracker(options: {
  readonly clock: Clock;
  /** The entries known at the start, taken in without telling `onChange`. */
  readonly entries?: { readonly all: readonly LogEntry[]; readonly branch: readonly LogEntry[] };
  readonly readStats: () => Promise<PiStats>;
  /** pi's compaction reserve for the session's model now; none reads it as unknown. */
  readonly readReserve?: () => Promise<ContextReserve>;
  /** The home directory, written as `~` in memory files' paths; none keeps the paths. */
  readonly home?: string | undefined;
  /** The provider of the session's model now, which decides what the system prompt is; none for unknown. */
  readonly provider?: () => string | null;
  readonly onChange: (metrics: SessionMetrics) => void;
  readonly onReadFailed: (error: unknown) => void;
}): MetricsTracker {
  const { clock } = options;
  let stats: PiStats | null = null;
  let reasoning: number | null = null;
  let branchTokens = 0;
  let parts: ContextParts | null = null;
  /** The current branch's entries, split again when the model changes. */
  // Stryker disable next-line ArrayDeclaration: any other start holds no system message either, so no split.
  let lastBranch: readonly LogEntry[] = [];
  /** The provider the parts were split for: the figures split again once the session's model is another's. */
  let splitFor: string | null = null;
  let reserve: ContextReserve = null;
  let timed: Timed | null = null;
  let modelMs: number | null = null;
  let firstOutputs: number[] = [];
  let tps: number | null = null;
  let reading: Promise<void> | null = null;
  // Stryker disable next-line BooleanLiteral: every read clears it before it starts.
  let readAgain = false;
  let closed = false;
  if (options.entries !== undefined) takeEntries(options.entries.all, options.entries.branch);
  let published = JSON.stringify(current());

  /**
   * Works out what comes from the entries.
   *
   * @remarks
   * See `createMetricsTracker`.
   *
   * @sideEffects Updates the figures.
   * @param all - Every entry of the file.
   * @param branch - The current branch's entries.
   */
  function takeEntries(all: readonly LogEntry[], branch: readonly LogEntry[]): void {
    const reported = all.flatMap((entry) =>
      entry.kind === "assistant" && entry.usage.reasoning !== null ? [entry.usage.reasoning] : [],
    );
    reasoning = reported.length === 0 ? null : sum(reported);
    branchTokens = sum(
      branch.map((entry) =>
        entry.kind === "assistant"
          ? entry.usage.input + entry.usage.output + entry.usage.cacheRead + entry.usage.cacheWrite
          : 0,
      ),
    );
    lastBranch = branch;
    split();
  }

  /**
   * Splits the context by the current branch's system prompt, for the session's model now.
   *
   * @remarks
   * Through Claude Code, the system prompt is not pi's (SPEC-0001, "M1.13 的上下文细分与套餐用量").
   *
   * @sideEffects Updates the parts and the provider they are for.
   */
  function split(): void {
    splitFor = providerNow();
    const found = contextParts(lastBranch, splitFor);
    parts = found === null ? null : fromHome(found, options.home);
  }

  /**
   * The provider of the session's model now.
   *
   * @remarks
   * One reading for both the split and the check whether to split again.
   *
   * @sideEffects none
   * @returns The provider, or `null` when unknown.
   */
  function providerNow(): string | null {
    return options.provider?.() ?? null;
  }

  /**
   * The figures as they stand.
   *
   * @remarks
   * See `createMetricsTracker`. The parts follow the session's model as it is now, whoever asks:
   * a snapshot published as a new pi starts sees the provider it brought.
   *
   * @sideEffects Splits the context again when the session's model is another provider's.
   * @returns The figures.
   */
  function current(): SessionMetrics {
    // Stryker disable next-line ConditionalExpression: splitting again for the same provider gives the same parts.
    if (providerNow() !== splitFor) split();
    const context = stats?.context ?? null;
    return {
      turns: stats?.turns ?? null,
      steps: stats?.steps ?? null,
      tokens: stats?.tokens ?? null,
      cost: stats?.cost ?? null,
      reasoning,
      branchTokens,
      context:
        context === null
          ? null
          : {
              tokens: context.tokens,
              window: context.window,
              parts,
              reserve,
            },
      timing:
        modelMs === null
          ? null
          : {
              modelMs,
              ttftMs: firstOutputs.length === 0 ? null : Math.round(sum(firstOutputs) / firstOutputs.length),
              tps,
            },
    };
  }

  /**
   * Gives the figures to `onChange` if they changed.
   *
   * @remarks
   * See `createMetricsTracker`.
   *
   * @sideEffects May call `onChange`.
   */
  function changed(): void {
    if (closed) return;
    const metrics = current();
    const json = JSON.stringify(metrics);
    if (json === published) return;
    published = json;
    options.onChange(metrics);
  }

  /**
   * Reads pi's statistics, or asks for one more read after the one under way.
   *
   * @remarks
   * See `createMetricsTracker`.
   *
   * @sideEffects Reads pi's statistics; may call `onChange` or `onReadFailed`.
   */
  function read(): void {
    if (closed) return;
    if (reading !== null) {
      readAgain = true;
      return;
    }
    reading = (async () => {
      for (;;) {
        readAgain = false;
        const reserveRead = (options.readReserve ?? noReserve)().catch(() => null);
        try {
          stats = await options.readStats();
          reserve = await reserveRead;
          changed();
        } catch (error) {
          options.onReadFailed(error);
        }
        // `close` may have come meanwhile, as may another ask.
        if (closed || !readAgain) break;
      }
      reading = null;
    })();
  }

  /**
   * Ends the request being timed with its assistant message.
   *
   * @remarks
   * See `createMetricsTracker`.
   *
   * @sideEffects Updates the timing.
   * @param output - The message's output tokens.
   */
  function replied(output: number): void {
    if (timed === null) return;
    const now = clock.now();
    modelMs = (modelMs ?? 0) + now - timed.start - timed.paused;
    const streamed = timed.firstOutput === null ? 0 : now - timed.firstOutput;
    if (output > 0 && streamed > 0) tps = output / (streamed / 1000);
    timed = null;
  }

  return {
    observe(event) {
      if (event.kind === "request_started") {
        timed = { start: clock.now(), paused: 0, pausedAt: null, firstOutput: null };
      } else if (event.kind === "compaction_started") {
        if (timed !== null) timed.pausedAt = clock.now();
      } else if (event.kind === "compaction_finished") {
        if (timed !== null && timed.pausedAt !== null) {
          timed.paused += clock.now() - timed.pausedAt;
          timed.pausedAt = null;
        }
        read();
      } else if (event.kind === "output_started") {
        if (timed === null || timed.firstOutput !== null) return;
        timed.firstOutput = clock.now();
        firstOutputs = [...firstOutputs, timed.firstOutput - timed.start - timed.paused];
      } else if (event.kind === "message_finished") {
        if (event.message.kind !== "assistant") return;
        replied(event.message.usage.output);
        changed();
        read();
      } else if (event.kind === "agent_settled") {
        read();
      }
    },
    entriesChanged(all, branch) {
      takeEntries(all, branch);
      changed();
    },
    refresh: read,
    modelChanged: changed,
    piChanged() {
      timed = null;
    },
    current,
    close() {
      closed = true;
    },
    reopen() {
      closed = false;
    },
  };
}
