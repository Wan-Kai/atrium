import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type WatchDirectory, watchDirectory } from "../changes/changes-service";
import { type Clock, trackedTimeout } from "../platform/clock";
import { errorCode } from "../platform/errors";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { type EventFileStamp, readTaskDirectory, stampOf } from "./task-reader";
import type { Task, TaskEvent } from "./types";

/** A task's directory name: what `pnpm task:try` and the host make ids of. */
const TASK_DIRECTORY = /^tsk_[0-9A-Za-z_-]{1,64}$/u;

/** How long after the first change the directory is read again, so a burst of appends is read once. */
const FOLLOW_DEBOUNCE_MS = 100;
/** How long between looks while the directory cannot be watched. */
const FOLLOW_POLL_MS = 1_000;
/** How long between looks while the watch runs, in case it missed a change (FSEvents may start late or drop one). */
const FOLLOW_SAFETY_MS = 3_000;
/** How long between tries while the directory is missing or unreadable. */
const FOLLOW_RETRY_MS = 5_000;

/** A task another process writes, as the host reads it. */
export interface TaskFollower {
  /** The tasks read so far, in the order they were first seen. */
  tasks(): Task[];
  /** One task, or `undefined`. */
  task(taskId: string): Task | undefined;
  /**
   * Calls `listener` when a task is new, has new events, or is gone.
   *
   * @remarks
   * Once per task per look, not once per event, with the last event the task has; a task that went away is
   * given with the last state it had. Not called for what the first look found.
   */
  onChange(listener: (task: Task, event: TaskEvent) => void): () => void;
  /** Resolves once the look under way, and the one after it that its changes asked for, are done. */
  idle(): Promise<void>;
  /** Stops watching and the timers; resolves once nothing is left running. */
  close(): Promise<void>;
}

/** What the follower needs. */
export interface TaskFollowerOptions {
  /** `task:try`'s `<home>/tasks`. */
  readonly directory: string;
  /** The host's own tasks directory, which must not be the same one. */
  readonly ownRoot: string;
  /** Whether the host's own tasks have this id (held, or a directory on disk); an own task wins. */
  readonly isOwned: (taskId: string) => Promise<boolean>;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  /** How to watch; defaults to the recursive `fs.watch` the changes panel uses. Tests pass one that fails. */
  readonly watch?: WatchDirectory;
  readonly debounceMs?: number;
  readonly pollMs?: number;
  readonly retryMs?: number;
  /** The look made now and then while the watch runs, in case it missed a change. */
  readonly safetyMs?: number;
}

/** What is known of one followed task. */
interface Known {
  task: Task;
  last: TaskEvent;
  count: number;
  stamp: EventFileStamp;
}

/**
 * Whether two stamps of an event file are the same file state.
 *
 * @remarks
 * Appends change the size and the time, so equal stamps mean nothing new to read.
 *
 * @sideEffects none
 * @param a - One stamp.
 * @param b - The other.
 * @returns Whether they are equal.
 */
function sameStamp(a: EventFileStamp, b: EventFileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * The real path of a path that may not exist yet.
 *
 * @remarks
 * The host's own tasks directory is made when the first task is, so it is resolved through its nearest existing
 * parent; otherwise a link in the way (macOS's `/var` is one) would make the same directory look like two.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns The path with every link that exists resolved.
 */
async function resolveLoose(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await resolveLoose(parent), basename(path));
  }
}

/**
 * Starts following a task directory that `pnpm task:try` writes, read-only.
 *
 * @remarks
 * SPEC-0006, "T7.1 定下的细节". Looks at the directory once before returning, then again whenever the
 * recursive `fs.watch` says something changed (after a short debounce), or every second when watching has
 * failed. Only `events.jsonl` is read, through `readTaskDirectory`, so nothing in the directory is ever written.
 * A directory that is missing or unreadable is logged once and tried again every few seconds; it is refused
 * outright when it is the host's own tasks directory (two hosts must not manage one home). A task whose id an
 * own task has is skipped, the own task winning. Every timer goes through the injected clock and the resource
 * tracker; the watch is counted as `task.follow.watch`.
 *
 * @sideEffects Reads the directory and, once it is there, watches it; sets timers; logs warnings.
 * @param options - The directories, the clock, the tracker, the logger and the owned-task check.
 * @returns The follower.
 */
export async function startTaskFollower(options: TaskFollowerOptions): Promise<TaskFollower> {
  const debounceMs = options.debounceMs ?? FOLLOW_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? FOLLOW_POLL_MS;
  const retryMs = options.retryMs ?? FOLLOW_RETRY_MS;
  const safetyMs = options.safetyMs ?? FOLLOW_SAFETY_MS;
  const watch = options.watch ?? watchDirectory;
  const known = new Map<string, Known>();
  const listeners = new Set<(task: Task, event: TaskEvent) => void>();
  /** Problems already logged, so a poll does not repeat one every second. */
  const logged = new Set<string>();
  let closed = false;
  let first = true;
  /** `retry` while the directory cannot be read, `watch` while the watch runs, `poll` after it failed. */
  let mode: "retry" | "watch" | "poll" = "retry";
  let unwatch: (() => void) | null = null;
  let releaseWatch: (() => void) | null = null;
  let cancelTimer: (() => void) | null = null;
  /** The look that backs up the watch; separate from `cancelTimer`, which the debounce needs to find free. */
  let cancelSafety: (() => void) | null = null;
  let scanning: Promise<void> | null = null;
  let again = false;

  /**
   * Logs a warning once for a problem.
   *
   * @remarks
   * The key says what it is about; the log carries a code and never the path.
   *
   * @sideEffects Logs a warning the first time a key is seen.
   * @param key - Identifies the problem.
   * @param fields - What to log beside the message.
   * @param message - The message.
   */
  const warnOnce = (key: string, fields: Record<string, unknown>, message: string): void => {
    if (logged.has(key)) return;
    logged.add(key);
    options.logger.warn(fields, message);
  };

  /**
   * Tells the listeners about a task.
   *
   * @remarks
   * A listener that throws must not stop the others or the look.
   *
   * @sideEffects Calls the listeners.
   * @param task - The task.
   * @param event - Its last event.
   */
  const emit = (task: Task, event: TaskEvent): void => {
    for (const listener of listeners) {
      try {
        listener(task, event);
      } catch (error) {
        options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task follow listener failed");
      }
    }
  };

  /**
   * Stops the watch and the timer that is pending.
   *
   * @remarks
   * Used when the directory goes away and when the follower closes.
   *
   * @sideEffects Closes the watcher; cancels the timer.
   */
  const stopWatching = (): void => {
    cancelSafety?.();
    cancelSafety = null;
    unwatch?.();
    unwatch = null;
    releaseWatch?.();
    releaseWatch = null;
  };

  /**
   * Sets the next timer, replacing the one pending.
   *
   * @remarks
   * Only one timer is ever pending: the debounce after a change, the poll, or the retry.
   *
   * @sideEffects Cancels and sets a timer.
   * @param ms - When.
   * @param action - What to do then.
   */
  const arm = (ms: number, action: () => void): void => {
    cancelTimer?.();
    cancelTimer = closed
      ? null
      : trackedTimeout(
          options.clock,
          options.resources,
          () => {
            cancelTimer = null;
            action();
          },
          ms,
        );
  };

  /**
   * Sets the look that backs up the watch, replacing the one pending.
   *
   * @remarks
   * A recursive watch can start late or drop a change, and a look now and then costs a `stat` per task, so no
   * change waits longer than this for want of an event.
   *
   * @sideEffects Cancels and sets a timer.
   */
  const armSafety = (): void => {
    cancelSafety?.();
    cancelSafety = closed
      ? null
      : trackedTimeout(
          options.clock,
          options.resources,
          () => {
            cancelSafety = null;
            void look();
          },
          safetyMs,
        );
  };

  /**
   * Starts the recursive watch.
   *
   * @remarks
   * A change asks for a look after the debounce; a watch that fails is dropped and the follower polls.
   *
   * @sideEffects Starts a watch and counts it.
   */
  const startWatching = (): void => {
    releaseWatch = options.resources.acquire("task.follow.watch");
    unwatch = watch(
      options.directory,
      () => {
        if (!closed && mode === "watch" && cancelTimer === null) arm(debounceMs, () => void look());
      },
      () => {
        stopWatching();
        if (closed) return;
        mode = "poll";
        arm(pollMs, () => void look());
      },
    );
  };

  /**
   * Reads the directory once and tells the listeners what changed.
   *
   * @remarks
   * Own tasks win on an id; a directory with no events yet waits; a task that cannot be replayed is logged once
   * and keeps its last good state. A directory that cannot be listed drops everything and goes back to retrying.
   *
   * @sideEffects Reads the directory; calls the listeners; logs.
   * @returns Whether the directory could be read.
   */
  const scan = async (): Promise<boolean> => {
    let names: string[];
    try {
      names = (await readdir(options.directory)).filter((name) => TASK_DIRECTORY.test(name));
    } catch (error) {
      warnOnce(
        `dir:${errorCode(error) ?? "unknown"}`,
        { err: errorCode(error) ?? "unknown" },
        "task follow unavailable",
      );
      for (const [id, one] of known) {
        known.delete(id);
        if (!first) emit(one.task, one.last);
      }
      return false;
    }
    logged.delete("dir:ENOENT");
    const changed: Known[] = [];
    for (const name of names) {
      if (closed) return true;
      if (await options.isOwned(name)) {
        warnOnce(`owned:${name}`, { taskId: name }, "followed task id is an own task's; skipped");
        continue;
      }
      const directory = join(options.directory, name);
      const stamp = await stampOf(directory).catch(() => null);
      if (stamp === null) continue;
      const before = known.get(name);
      if (before !== undefined && sameStamp(before.stamp, stamp)) continue;
      let read;
      try {
        read = await readTaskDirectory(directory);
      } catch (error) {
        warnOnce(
          `task:${name}:${error instanceof Error ? error.message : "unknown"}`,
          { taskId: name, err: error instanceof Error ? error.name : "unknown" },
          "a followed task could not be read",
        );
        if (before !== undefined) before.stamp = stamp;
        continue;
      }
      if (read === null) continue;
      if (before !== undefined && before.count === read.count) {
        before.stamp = stamp;
        continue;
      }
      const one: Known = { task: read.task, last: read.last, count: read.count, stamp };
      known.set(name, one);
      changed.push(one);
    }
    for (const [id, one] of known) {
      if (!names.includes(id)) {
        known.delete(id);
        changed.push(one);
      }
    }
    if (!first) for (const one of changed) emit(one.task, one.last);
    return true;
  };

  /**
   * One look, and the next one it arranges.
   *
   * @remarks
   * Looks go one at a time; a change that comes during one asks for another straight after. When the directory
   * can be read and is not watched yet, it is watched now; when it cannot, the retry timer is set.
   *
   * @sideEffects As `scan`; starts the watch or sets the next timer.
   */
  const look = async (): Promise<void> => {
    if (scanning !== null) {
      again = true;
      return scanning;
    }
    scanning = (async () => {
      for (;;) {
        again = false;
        const readable = await scan();
        if (closed) return;
        if (!readable) {
          stopWatching();
          mode = "retry";
          arm(retryMs, () => void look());
        } else if (mode === "retry") {
          mode = "watch";
          startWatching();
          // Whatever changed between the look and the watch starting.
          again = true;
        } else if (mode === "poll") {
          arm(pollMs, () => void look());
        } else if (mode === "watch") {
          armSafety();
        }
        if (!again) return;
      }
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  };

  // The host's own tasks directory is the one thing that must never be followed.
  const [own, target] = await Promise.all([resolveLoose(options.ownRoot), resolveLoose(options.directory)]);
  if (own === target) {
    options.logger.warn({}, "task follow refused: it is the host's own tasks directory");
    closed = true;
  } else {
    await look();
    first = false;
  }

  return {
    tasks: () => [...known.values()].map((one) => one.task),
    task: (taskId) => known.get(taskId)?.task,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async idle() {
      for (;;) {
        const current = scanning;
        if (current === null) return;
        await current;
      }
    },
    async close() {
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      cancelSafety?.();
      cancelSafety = null;
      stopWatching();
      listeners.clear();
      await scanning?.catch(() => undefined);
    },
  };
}
