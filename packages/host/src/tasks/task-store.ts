import { appendFile, mkdir, open, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorCode } from "../platform/errors";
import type { Clock } from "../platform/clock";
import { writeAtomically } from "../store/index-file";
import { ReplayError, replayEvents } from "./replay";
import { step } from "./scheduler";
import { type Action, Task, TaskEvent, type TaskEventInput } from "./types";

/** The snapshot file `task.json`: the task and the `seq` of the last event it includes. */
const Snapshot = z.strictObject({ version: z.literal(1), seq: z.number().int().min(0), task: Task });

/** The state of `task.json` when the store opened. */
type SnapshotState = "ok" | "missing" | "stale" | "damaged";

/** What the store had to repair when it opened. */
interface Recovery {
  /** The last line of `events.jsonl` was cut short and has been dropped. */
  readonly droppedTail: boolean;
  /** `ok` was used as it was; the others were rebuilt from the events and written again. */
  readonly snapshot: SnapshotState;
}

/** What recording an event gives back. */
interface Recorded {
  readonly event: TaskEvent;
  readonly task: Task;
  readonly actions: readonly Action[];
}

/**
 * `events.jsonl` is damaged somewhere other than its last line, which cannot be put right by dropping it.
 *
 * @remarks
 * Only a cut last line is a normal result of a crash; a bad line in the middle means something else wrote
 * to the file, and guessing would lose events.
 *
 * @sideEffects none
 */
export class TaskStoreCorruptError extends Error {
  /**
   * Creates the error.
   *
   * @remarks
   * Names the line so a person can look at it.
   *
   * @sideEffects none
   * @param path - The event file.
   * @param line - The 1-based line number.
   */
  constructor(
    readonly path: string,
    readonly line: number,
  ) {
    super(`${path} is damaged at line ${line}`);
    this.name = "TaskStoreCorruptError";
  }
}

/** One task's files: `events.jsonl` (append only) and `task.json` (a snapshot). */
export interface TaskStore {
  /** The task as of the last event; `null` before `created`. */
  current(): Task | null;
  /** The events so far. */
  events(): readonly TaskEvent[];
  /** What opening repaired. */
  readonly recovery: Recovery;
  /**
   * Gives an event its `seq` and time, runs it through the scheduler, appends it and rewrites the snapshot.
   *
   * @remarks
   * The first event of a task is `created`. The scheduler runs before anything is written, so an event
   * that makes it throw never reaches the log.
   */
  record(input: TaskEventInput): Promise<Recorded>;
}

/**
 * Parses the text of `events.jsonl`, dropping a last line that was cut short.
 *
 * @remarks
 * A crash while appending can leave the last line half written (SPEC-0006, "验证 · TaskStore"). It is
 * dropped, together with its bytes, so the next append starts on a clean line. A bad line anywhere else
 * means the file was damaged some other way, and nothing is guessed.
 *
 * @sideEffects none
 * @param text - The file's text.
 * @param path - The file, for the error.
 * @returns The events, how many bytes of the text are whole lines, and whether a tail was dropped.
 * @throws {TaskStoreCorruptError} When a line other than the last is not a valid event.
 */
export function parseEvents(
  text: string,
  path: string,
): { events: TaskEvent[]; goodBytes: number; droppedTail: boolean } {
  const lines = text.split("\n");
  const events: TaskEvent[] = [];
  let goodBytes = 0;
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    if (line === "") {
      if (!last) goodBytes += 1;
      continue;
    }
    const parsed = TaskEvent.safeParse(safeJson(line));
    if (!parsed.success) {
      if (last || lines.slice(index + 1).every((rest) => rest === "")) {
        return { events, goodBytes, droppedTail: true };
      }
      throw new TaskStoreCorruptError(path, index + 1);
    }
    events.push(parsed.data);
    goodBytes += Buffer.byteLength(line) + (last ? 0 : 1);
  }
  return { events, goodBytes, droppedTail: false };
}

/**
 * Parses JSON, returning `undefined` for text that is not JSON.
 *
 * @remarks
 * Lets the caller validate and treat both failures alike.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The value, or `undefined`.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Opens one task's directory, repairing what a crash left.
 *
 * @remarks
 * SPEC-0006, "接口与数据 · 数据" and "宿主重启" 1: the events are the truth and `task.json` a
 * snapshot. A snapshot that is missing, damaged, or whose `seq` is not the last event's is rebuilt by
 * replaying the events and written again. The directory is the caller's (in the app it is
 * `~/.atrium/tasks/<id>/`). Files are `0600` and the directory `0700` (security.md).
 *
 * @sideEffects Reads the directory; may truncate `events.jsonl` to drop a cut line and rewrite `task.json`; creates the directory on the first write.
 * @param directory - The task's directory; it need not exist yet.
 * @param clock - Where event times come from.
 * @param write - How `task.json` reaches the disk; tests pass one that fails on purpose.
 * @returns The store.
 * @throws {TaskStoreCorruptError} When a line of `events.jsonl` other than the last is invalid.
 * @throws {ReplayError} When the events cannot be replayed (they do not begin with `created`, or `seq` skips).
 */
export async function openTaskStore(
  directory: string,
  clock: Clock,
  write: (path: string, content: string) => Promise<void> = writeAtomically,
): Promise<TaskStore> {
  const eventsPath = join(directory, "events.jsonl");
  const snapshotPath = join(directory, "task.json");
  const text = await readOptional(eventsPath);
  const parsed = parseEvents(text ?? "", eventsPath);
  if (parsed.droppedTail) await truncate(eventsPath, parsed.goodBytes);
  // A last line that is whole but lacks its newline would otherwise run into the next append.
  else if (text !== null && text !== "" && !text.endsWith("\n")) await appendFile(eventsPath, "\n");
  const events = parsed.events;
  const steps = replayEvents(events);
  const replayed = steps.at(-1)?.task ?? null;
  const lastSeq = events.length;

  let state: SnapshotState = "ok";
  let task = replayed;
  const stored = await readOptional(snapshotPath);
  if (stored === null) state = "missing";
  else {
    const snapshot = Snapshot.safeParse(safeJson(stored));
    if (!snapshot.success) state = "damaged";
    else if (snapshot.data.seq !== lastSeq) state = "stale";
    else task = snapshot.data.task;
  }
  if (lastSeq === 0) task = null;
  if (task !== null && state !== "ok") await write(snapshotPath, snapshotText(lastSeq, task));

  let current = task;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Records one event, after the ones before it.
   *
   * @remarks
   * Appends are serialised so two callers cannot give the same `seq` to two events.
   *
   * @sideEffects Appends a line to `events.jsonl` and rewrites `task.json`.
   * @param input - The event without `seq` and `at`.
   * @returns The event, the task after it and the actions.
   */
  const recordOne = async (input: TaskEventInput): Promise<Recorded> => {
    const event = TaskEvent.parse({ ...input, seq: lastEventSeq() + 1, at: clock.now() });
    let result: { task: Task; actions: readonly Action[] };
    if (event.type === "created") {
      if (current !== null) throw new ReplayError("`created` after the first event", event.seq);
      result = { task: structuredClone(event.task), actions: [] };
    } else {
      if (current === null) throw new ReplayError("the first event is not `created`", event.seq);
      result = step(current, event);
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(eventsPath, "a", 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    events.push(event);
    current = result.task;
    await write(snapshotPath, snapshotText(event.seq, result.task));
    return { event, task: result.task, actions: result.actions };
  };

  /**
   * The `seq` of the last event so far.
   *
   * @remarks
   * Read inside the serialised append, so it is never stale.
   *
   * @sideEffects none
   * @returns The `seq`, 0 before any event.
   */
  const lastEventSeq = (): number => events.length;

  return {
    current: () => current,
    events: () => events,
    recovery: { droppedTail: parsed.droppedTail, snapshot: state },
    record(input) {
      const run = queue.then(() => recordOne(input));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * The text of `task.json`.
 *
 * @remarks
 * The snapshot carries the `seq` it is up to, so a restart can tell whether it is current
 * (SPEC-0006, "宿主重启" 1).
 *
 * @sideEffects none
 * @param seq - The last event the task includes.
 * @param task - The task.
 * @returns The JSON text.
 */
function snapshotText(seq: number, task: Task): string {
  return `${JSON.stringify({ version: 1, seq, task }, null, 2)}\n`;
}

/**
 * Reads a file, or `null` if it does not exist.
 *
 * @remarks
 * A new task has neither file.
 *
 * @sideEffects Reads a file.
 * @param path - The file.
 * @returns Its text, or `null`.
 */
async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
