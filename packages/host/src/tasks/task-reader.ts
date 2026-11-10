import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorCode } from "../platform/errors";
import { replayEvents } from "./replay";
import { parseEvents } from "./task-store";
import type { Task, TaskEvent } from "./types";

/** What a task directory held when it was read. */
export interface TaskRead {
  /** The task after the last whole event. */
  readonly task: Task;
  /** The last whole event. */
  readonly last: TaskEvent;
  /** How many events there are, the same as `last.seq`. */
  readonly count: number;
  /** The log ended in a line not written out yet, which was ignored. */
  readonly partialTail: boolean;
}

/** The size and time of change of a task's event file, to tell whether it needs reading again. */
export interface EventFileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * The size and modification time of a task directory's `events.jsonl`.
 *
 * @remarks
 * Lets a follower skip the tasks that did not change since the last scan without reading them.
 *
 * @sideEffects Reads file metadata.
 * @param directory - The task's directory.
 * @returns The stamp, or `null` when the file is not there.
 */
export async function stampOf(directory: string): Promise<EventFileStamp | null> {
  try {
    const { size, mtimeMs } = await stat(join(directory, "events.jsonl"));
    return { size, mtimeMs };
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * Reads a task directory that another process writes, without ever writing to it.
 *
 * @remarks
 * `openTaskStore` truncates a cut last line, appends a missing newline and rewrites `task.json`, which for a
 * directory someone else is appending to is a write that can lose their event. This reads `events.jsonl` only
 * (the events are the truth, `task.json` is a snapshot that may be a step behind) and uses the same
 * `parseEvents` and `replayEvents` the store does, so the reducer is not copied. A last line that is not whole
 * yet is ignored, and the next read finds it complete (SPEC-0006, "T7.1 定下的细节").
 *
 * @sideEffects Reads `events.jsonl`; writes nothing.
 * @param directory - The task's directory.
 * @returns What it held, or `null` when there is no event yet (no file, an empty file, or only a half line).
 * @throws {TaskStoreCorruptError} When a line other than the last is not a valid event.
 * @throws {ReplayError} When the events cannot be replayed.
 */
export async function readTaskDirectory(directory: string): Promise<TaskRead | null> {
  const path = join(directory, "events.jsonl");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
  const parsed = parseEvents(text, path);
  const steps = replayEvents(parsed.events);
  const final = steps.at(-1);
  if (final === undefined) return null;
  return { task: final.task, last: final.event, count: steps.length, partialTail: parsed.droppedTail };
}
