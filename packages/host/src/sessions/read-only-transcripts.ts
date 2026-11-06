import type { LogEntry } from "@atrium/pi";
import {
  CommandError,
  type CommandResult,
  type FetchStepCommand,
  type FetchTranscriptCommand,
  IDLE_CONTROL,
  type SessionModel,
  type SessionSnapshotEvent,
  UNKNOWN_METRICS,
} from "@atrium/protocol";
import type { ResourceTracker } from "../platform/resources";
import type { TurnStarts } from "../store/turn-starts";
import { type SessionTranscript, createSessionTranscript } from "../transcript/session-transcript";

/**
 * The epoch of every read-only snapshot: 0, as a draft's, so the first snapshot of a pi started
 * later (epoch 1) always replaces it, and a page asked of that pi for it is `transcript_changed`.
 */
export const READ_ONLY_EPOCH = 0;

/** How many sessions are kept read at once by default. */
const LIMIT = 32;

/** A session to show read-only: its id, its file, and the model its file last records. */
interface ReadOnlySession {
  readonly sessionId: string;
  readonly file: string;
  readonly model: SessionModel | null;
}

/** Sessions shown read-only, without pi: an archived direction's (SPEC-0008, "ML1 定的细节"). */
export interface ReadOnlyTranscripts {
  /**
   * The session's snapshot, its file read once and kept; `null` when the session was let go
   * while its file was read.
   */
  snapshot(session: ReadOnlySession, fast: boolean): Promise<SessionSnapshotEvent | null>;
  /** Whether a session's transcript is kept. */
  has(sessionId: string): boolean;
  /** Older items, as a controller answers `fetch_transcript`. */
  fetchTranscript(command: FetchTranscriptCommand): CommandResult<"fetch_transcript">;
  /** A step, as a controller answers `fetch_step`. */
  fetchStep(command: FetchStepCommand): CommandResult<"fetch_step">;
  /** The entry that opened a turn, for its images; `null` for none. */
  entryOfTurn(sessionId: string, turnId: string): string | null;
  /** Lets go of sessions, a read under way included, as when pi can run them again. */
  forget(sessionIds: readonly string[]): void;
  /** Lets go of every session `keep` does not keep, as those nobody watches. */
  evict(keep: (sessionId: string) => boolean): void;
}

/** A session read and kept. */
interface Kept {
  readonly transcript: SessionTranscript;
  readonly stream: string;
  readonly release: () => void;
}

/**
 * Creates the read-only transcripts.
 *
 * @remarks
 * domain-model §1, Direction: an archived direction's sessions have no working directory, so pi
 * cannot start for them; their file is read as pi wrote it and rebuilt by the same
 * `SessionTranscript` a controller uses, with the turn starts the host recorded, so they show as
 * they did. The leaf is the file's last entry, as for a stopped edit's recovery. The snapshot is
 * idle and not exited, with no metrics, in `READ_ONLY_EPOCH`; a page or step asked for another
 * epoch is `transcript_changed`, as from a controller. A session not kept is `session_not_found`.
 *
 * Snapshots asked while a read is under way share it. Letting a session go also drops a read
 * under way (each read carries the session's generation), so a read that ends after the session
 * was restored and run never brings an old copy back. At most `limit` sessions are kept, the one
 * used longest ago going first; the caller lets go of those nobody watches (`evict`). Each kept
 * session counts as a `session.read_only` resource (testing.md, "泄漏测试").
 *
 * @sideEffects none until a call; then reads session and turn-start files.
 * @param options - How to read a file's entries, a session's turn starts, ids for turns and
 * streams, the clock's time, the resource tracker, and how many sessions to keep.
 * @returns The read-only transcripts.
 */
export function createReadOnlyTranscripts(options: {
  readonly readEntries: (file: string) => Promise<LogEntry[]>;
  readonly turnStarts?: ((sessionId: string) => Promise<TurnStarts>) | undefined;
  readonly newId: () => string;
  readonly newStream: () => string;
  readonly now: () => number;
  readonly resources: ResourceTracker;
  readonly limit?: number;
}): ReadOnlyTranscripts {
  const limit = options.limit ?? LIMIT;
  /** Kept sessions, the one used longest ago first. */
  const kept = new Map<string, Kept>();
  /** Reads under way, with the generation each began in. */
  const reading = new Map<string, { readonly generation: number; readonly read: Promise<Kept | null> }>();
  /** How often each session was let go. */
  const generations = new Map<string, number>();

  /**
   * Marks a kept session as just used.
   *
   * @remarks
   * A `Map` keeps the order things went in.
   *
   * @sideEffects Moves the session to the end of the order.
   * @param sessionId - The session.
   * @param found - What is kept of it.
   */
  function used(sessionId: string, found: Kept): void {
    kept.delete(sessionId);
    kept.set(sessionId, found);
  }

  /**
   * A kept session's transcript, marked as just used.
   *
   * @remarks
   * See `createReadOnlyTranscripts`.
   *
   * @sideEffects Moves the session to the end of the order.
   * @param sessionId - The session.
   * @returns The transcript.
   * @throws {CommandError} `session_not_found` when it is not kept.
   */
  function transcriptOf(sessionId: string): SessionTranscript {
    const found = kept.get(sessionId);
    if (found === undefined) throw new CommandError("session_not_found", { sessionId });
    used(sessionId, found);
    return found.transcript;
  }

  /**
   * Lets go of a kept session.
   *
   * @remarks
   * See `createReadOnlyTranscripts`.
   *
   * @sideEffects Drops it; releases its resource.
   * @param sessionId - The session.
   */
  function drop(sessionId: string): void {
    kept.get(sessionId)?.release();
    kept.delete(sessionId);
  }

  /**
   * Reads a session's file and rebuilds it, keeping it unless it was let go meanwhile.
   *
   * @remarks
   * See `createReadOnlyTranscripts`.
   *
   * @sideEffects Reads files; keeps the session, letting the one used longest ago go past the limit.
   * @param session - The session.
   * @param generation - Its generation when the read began.
   * @returns What is kept, or `null`.
   */
  async function read(session: ReadOnlySession, generation: number): Promise<Kept | null> {
    const starts = await options.turnStarts?.(session.sessionId);
    const transcript = createSessionTranscript({
      sessionId: session.sessionId,
      newId: options.newId,
      now: options.now,
      ...(starts === undefined ? {} : { opened: starts.opened, auto: starts.auto, compactions: starts.compactions }),
    });
    const entries = await options.readEntries(session.file);
    transcript.rebuild({ entries, leafId: entries.at(-1)?.id ?? null }, true);
    if ((generations.get(session.sessionId) ?? 0) !== generation) return null;
    const made = { transcript, stream: options.newStream(), release: options.resources.acquire("session.read_only") };
    kept.set(session.sessionId, made);
    for (const [sessionId] of kept) {
      if (kept.size <= limit) break;
      drop(sessionId);
    }
    return made;
  }

  /**
   * The read of a session under way in its generation, or a new one.
   *
   * @remarks
   * See `createReadOnlyTranscripts`.
   *
   * @sideEffects May start a read.
   * @param session - The session.
   * @returns The read.
   */
  function readOnce(session: ReadOnlySession): Promise<Kept | null> {
    const { sessionId } = session;
    const generation = generations.get(sessionId) ?? 0;
    const under = reading.get(sessionId);
    if (under?.generation === generation) return under.read;
    const started = read(session, generation).finally(() => {
      if (reading.get(sessionId)?.read === started) reading.delete(sessionId);
    });
    reading.set(sessionId, { generation, read: started });
    return started;
  }

  return {
    async snapshot(session, fast) {
      const { sessionId } = session;
      let found = kept.get(sessionId) ?? null;
      if (found === null) {
        found = await readOnce(session);
        // Let go, or past the limit, since the read ended.
        if (found === null || kept.get(sessionId) !== found) return null;
      } else {
        used(sessionId, found);
      }
      return {
        type: "session_snapshot",
        sessionId,
        epoch: READ_ONLY_EPOCH,
        seq: 0,
        traceId: null,
        stream: found.stream,
        ...found.transcript.latest(),
        run: null,
        exited: false,
        control: IDLE_CONTROL,
        model: session.model,
        fast,
        metrics: UNKNOWN_METRICS,
      };
    },
    has: (sessionId) => kept.has(sessionId),
    fetchTranscript(command) {
      const transcript = transcriptOf(command.sessionId);
      const page =
        command.epoch === READ_ONLY_EPOCH ? transcript.before(command.before, command.limit, command.maxBytes) : null;
      if (page === null) throw new CommandError("transcript_changed");
      return page;
    },
    fetchStep(command) {
      const transcript = transcriptOf(command.sessionId);
      const step = command.epoch === READ_ONLY_EPOCH ? transcript.step(command.turnId, command.stepId) : null;
      if (step === null) throw new CommandError("transcript_changed");
      return { step };
    },
    entryOfTurn: (sessionId, turnId) => transcriptOf(sessionId).entryOfTurn(turnId),
    forget(sessionIds) {
      for (const sessionId of sessionIds) {
        generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
        reading.delete(sessionId);
        drop(sessionId);
      }
    },
    evict(keep) {
      for (const [sessionId] of kept) if (!keep(sessionId)) drop(sessionId);
    },
  };
}
