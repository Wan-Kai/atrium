import {
  type ChangesUpdatedEvent,
  CommandError,
  type DiffMode,
  type DiffTarget,
  type DiffUpdatedEvent,
} from "@atrium/protocol";
import { watch } from "node:fs";
import { type Clock, trackedTimeout } from "../platform/clock";
import { GitError } from "../platform/git";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import type { CheckoutReader, WatchRoots } from "./checkout";

/** How long after a file changes the capsule's count is worked out again (SPEC-0001, "工作区改动"). */
export const CHANGES_DEBOUNCE_MS = 1_000;
/** How long after a file changes an open panel's diff is worked out again. */
export const DIFF_DEBOUNCE_MS = 150;
/** The first wait between looks when the watcher has failed. */
export const POLL_START_MS = 5_000;
/** The longest wait between looks when nothing changes. */
const POLL_MAX_MS = 60_000;
/** The first wait before trying to watch again after the watcher failed. */
export const RECOVER_START_MS = 30_000;
/** The longest wait before trying to watch again. */
const RECOVER_MAX_MS = 300_000;

/** What a connection is told about workspaces' changes. */
type ChangesEvent = ChangesUpdatedEvent | DiffUpdatedEvent;

/**
 * Watches a directory and everything below it.
 *
 * @remarks
 * `onEvent` gets the changed path relative to the directory, or `null` when the system does not
 * say; `onError` is called when watching stops working. Returns how to stop.
 */
export type WatchDirectory = (dir: string, onEvent: (path: string | null) => void, onError: () => void) => () => void;

/**
 * Watches a directory with Node's recursive `fs.watch`.
 *
 * @remarks
 * macOS watches a whole tree with one stream. A watch that cannot start reports an error at once,
 * after returning.
 *
 * @sideEffects Starts a file system watch.
 * @param dir - The directory.
 * @param onEvent - Told of each change.
 * @param onError - Told when watching fails.
 * @returns How to stop.
 */
const watchDirectory: WatchDirectory = (dir, onEvent, onError) => {
  try {
    const watcher = watch(dir, { recursive: true }, (_event, path) => onEvent(path));
    watcher.on("error", () => onError());
    return () => watcher.close();
  } catch {
    queueMicrotask(onError);
    return () => undefined;
  }
};

/** Watches workspaces' git changes for the connections showing them. */
export interface ChangesService {
  /** Sets the workspaces a connection shows; it is sent each one's changes now and as they change. */
  watchChanges(connectionId: string, workspaceIds: readonly string[]): void;
  /** Sets what a connection's changes panel shows, or closes it with `null`. */
  watchDiff(connectionId: string, target: DiffTarget | null): void;
  /** Works out the changes again: one workspace's, or every watched one's. */
  refresh(workspaceId?: string): void;
  /** Forgets a connection that closed. */
  disconnect(connectionId: string): void;
  /** Stops watching; resolves once git has stopped. */
  close(): Promise<void>;
}

/** One workspace someone shows, and what is known of it. */
interface Watched {
  readonly workspaceId: string;
  /** Connections showing its capsule. */
  readonly viewers: Set<string>;
  /** Connections with its panel open, and the mode each shows. */
  readonly panels: Map<string, DiffMode>;
  /** What the viewers were last sent, as JSON. */
  sentChanges: string | null;
  /** What the panels of each mode were last sent, as JSON. */
  readonly sentDiffs: Map<DiffMode, string>;
  /** Connections owed the next result even if unchanged, as they have not had one yet. */
  readonly owedChanges: Set<string>;
  readonly owedDiffs: Set<string>;
  /** What the next look works out. */
  wantChanges: boolean;
  readonly wantDiffs: Set<DiffMode>;
  /** The look under way. */
  running: Promise<void> | null;
  /** Stops git and the timers once nobody shows the workspace. */
  readonly stop: AbortController;
  /** Stops the watchers. */
  unwatch: (() => void)[];
  /** The directories git ignores, relative to the top, each ending in `/`. */
  ignored: readonly string[];
  cancelChanges: (() => void) | null;
  cancelDiff: (() => void) | null;
  /** Stops the looks taken while the watcher has failed, and the tries to watch again. */
  stopPolling: (() => void) | null;
}

/**
 * Whether a change in one of git's own directories can change what git shows.
 *
 * @remarks
 * HEAD, the index and refs, never lock files; a shared directory's `worktrees/` belongs to other
 * worktrees, whose own HEAD and index are not these (SPEC-0001, "工作区改动").
 *
 * @sideEffects none
 * @param path - The path within the git directory.
 * @returns Whether it matters.
 */
function gitChangeMatters(path: string): boolean {
  if (path.endsWith(".lock")) return false;
  return path === "HEAD" || path === "index" || path === "packed-refs" || path.startsWith("refs/");
}

/**
 * Creates the changes service.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"), copied from Paseo: only workspaces some connection shows are worked
 * out and watched. A workspace's tree is watched from its repository's top, leaving out `.git`
 * but for HEAD, the index and refs, and the directories git ignores (read again when a
 * `.gitignore` changes); a linked worktree's git directories are watched too, so commits and
 * resets count. A change works the capsule's count out again a second later and an open panel's
 * diff 150 ms later, each debounced; a result sent before is not sent again, but a connection that
 * has not had one yet gets it. When watching fails the service looks every 5 seconds, doubling the
 * wait to a minute while nothing changes, and tries to watch again after 30 seconds, doubling to 5
 * minutes. One workspace has at most one look under way; asks meanwhile run once it ends. git
 * failing is logged by its command and reason only.
 *
 * @sideEffects none until a connection watches; then runs git through `reader`, watches files,
 * schedules timers, sends events and logs.
 * @param options - How to read changes, find a workspace, watch and send, and the clock, resource
 * tracker and logger.
 * @returns The service.
 */
export function createChangesService(options: {
  readonly reader: Promise<CheckoutReader | null>;
  /** A workspace's directory and its project's own main branch; `undefined` for an unknown one. */
  readonly resolve: (workspaceId: string) => { readonly dir: string; readonly mainBranch: string | null } | undefined;
  readonly send: (connectionId: string, event: ChangesEvent) => void;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  readonly watch?: WatchDirectory;
}): ChangesService {
  const watchDir = options.watch ?? watchDirectory;
  const watched = new Map<string, Watched>();
  /** The workspaces each connection shows. */
  const showing = new Map<string, readonly string[]>();
  /** The workspace each connection's panel shows. */
  const panelOf = new Map<string, string>();
  const looks = new Set<Promise<void>>();
  let closed = false;

  /**
   * Runs a callback later on the clock, counted as a timer until it runs or is cancelled.
   *
   * @remarks
   * So a timer left behind shows in the leak tests.
   *
   * @sideEffects Schedules a timer.
   * @param callback - What to run.
   * @param ms - When.
   * @returns Cancels it.
   */
  function later(callback: () => void, ms: number): () => void {
    return trackedTimeout(options.clock, options.resources, callback, ms);
  }

  /**
   * Starts showing a workspace, watching it if nobody did.
   *
   * @remarks
   * See `createChangesService`.
   *
   * @sideEffects May start watching.
   * @param workspaceId - The workspace.
   * @returns Its record.
   */
  function ensure(workspaceId: string): Watched {
    const known = watched.get(workspaceId);
    if (known !== undefined) return known;
    const fresh: Watched = {
      workspaceId,
      viewers: new Set(),
      panels: new Map(),
      sentChanges: null,
      sentDiffs: new Map(),
      owedChanges: new Set(),
      owedDiffs: new Set(),
      wantChanges: false,
      wantDiffs: new Set(),
      running: null,
      stop: new AbortController(),
      unwatch: [],
      ignored: [],
      cancelChanges: null,
      cancelDiff: null,
      stopPolling: null,
    };
    watched.set(workspaceId, fresh);
    // Fire and forget: `startWatching` reports its own failures.
    void startWatching(fresh);
    return fresh;
  }

  /**
   * Stops watching a workspace nobody shows any more.
   *
   * @remarks
   * Its git is stopped and its timers cancelled.
   *
   * @sideEffects May stop watching.
   * @param entry - The workspace.
   */
  function releaseIfUnseen(entry: Watched): void {
    if (entry.viewers.size > 0 || entry.panels.size > 0) return;
    watched.delete(entry.workspaceId);
    entry.stop.abort();
    unwatch(entry);
    entry.cancelChanges?.();
    entry.cancelDiff?.();
    entry.stopPolling?.();
  }

  /**
   * Stops a workspace's watchers.
   *
   * @remarks
   * See `startWatching`.
   *
   * @sideEffects Stops the watchers.
   * @param entry - The workspace.
   */
  function unwatch(entry: Watched): void {
    for (const stop of entry.unwatch.splice(0)) stop();
  }

  /**
   * Watches a workspace's tree and git directories.
   *
   * @remarks
   * Nothing is watched outside a repository, whose changes are always none. A watcher failing
   * switches to looking now and then (`degrade`).
   *
   * @sideEffects Runs git; watches files.
   * @param entry - The workspace.
   * @returns Whether it is watched.
   */
  async function startWatching(entry: Watched): Promise<boolean> {
    const reader = await options.reader;
    const place = options.resolve(entry.workspaceId);
    if (reader === null || place === undefined) return false;
    let roots: WatchRoots | null;
    try {
      roots = await reader.roots(place.dir, entry.stop.signal);
      if (roots !== null) entry.ignored = await reader.ignored(roots.top, entry.stop.signal);
    } catch (error) {
      failed(entry, error);
      return false;
    }
    if (roots === null || entry.stop.signal.aborted) return false;
    let broken = false;
    /**
     * Gives up on the watchers once one fails.
     *
     * @remarks
     * See `degrade`.
     *
     * @sideEffects May switch to looking now and then.
     */
    const onError = (): void => {
      if (broken) return;
      broken = true;
      degrade(entry);
    };
    const top = roots.top;
    entry.unwatch.push(
      counted(watchDir(top, (path) => treeChanged(entry, top, path), onError)),
      ...roots.gitDirs.map((gitDir) =>
        counted(
          watchDir(gitDir, (path) => (path === null || gitChangeMatters(path) ? changed(entry) : undefined), onError),
        ),
      ),
    );
    return true;
  }

  /**
   * Counts a watcher as a resource while it runs.
   *
   * @remarks
   * So one never stopped shows in the leak tests.
   *
   * @sideEffects Counts the watcher.
   * @param stop - Stops the watcher.
   * @returns Stops it and the count.
   */
  function counted(stop: () => void): () => void {
    const release = options.resources.acquire("changes.watch");
    return () => {
      stop();
      release();
    };
  }

  /**
   * Takes a change in a workspace's tree.
   *
   * @remarks
   * In `.git`, only HEAD, the index and refs matter; nothing in a directory git ignores does. A
   * `.gitignore` changing reads the ignored directories again first.
   *
   * @sideEffects May schedule looks; may run git.
   * @param entry - The workspace.
   * @param top - The repository's top.
   * @param path - The changed path, relative to the top.
   */
  function treeChanged(entry: Watched, top: string, path: string | null): void {
    if (path === null) {
      changed(entry);
      return;
    }
    if (path === ".git" || path.startsWith(".git/")) {
      if (gitChangeMatters(path.slice(".git/".length))) changed(entry);
      return;
    }
    if (entry.ignored.some((dir) => path.startsWith(dir) || `${path}/` === dir)) return;
    if (path === ".gitignore" || path.endsWith("/.gitignore")) {
      // Fire and forget: a failure keeps the old list.
      void (async () => {
        const reader = await options.reader;
        entry.ignored = (await reader?.ignored(top, entry.stop.signal).catch(() => null)) ?? entry.ignored;
        changed(entry);
      })();
      return;
    }
    changed(entry);
  }

  /**
   * Schedules the count, and any open panel's diff, to be worked out again.
   *
   * @remarks
   * Trailing debounces of a second and 150 ms (SPEC-0001, "工作区改动").
   *
   * @sideEffects Schedules timers.
   * @param entry - The workspace.
   */
  function changed(entry: Watched): void {
    if (entry.stop.signal.aborted) return;
    entry.cancelChanges?.();
    entry.cancelChanges = later(() => {
      entry.cancelChanges = null;
      ask(entry, true, []);
    }, CHANGES_DEBOUNCE_MS);
    if (entry.panels.size === 0) return;
    entry.cancelDiff?.();
    entry.cancelDiff = later(() => {
      entry.cancelDiff = null;
      ask(entry, false, [...new Set(entry.panels.values())]);
    }, DIFF_DEBOUNCE_MS);
  }

  /**
   * Looks now and then while the watcher is broken, and tries to watch again.
   *
   * @remarks
   * See `createChangesService`.
   *
   * @sideEffects Stops the watchers; schedules looks and tries.
   * @param entry - The workspace.
   */
  function degrade(entry: Watched): void {
    unwatch(entry);
    options.logger.warn({ workspaceId: entry.workspaceId }, "changes watch failed, looking now and then");
    let wait = POLL_START_MS;
    let tries = 0;
    let cancelLook: (() => void) | null = null;
    let cancelTry: (() => void) | null = null;
    /**
     * Schedules the next look.
     *
     * @remarks
     * The wait doubles while the count stays the same.
     *
     * @sideEffects Schedules a timer.
     */
    const nextLook = (): void => {
      cancelLook = later(() => {
        const before = entry.sentChanges;
        ask(entry, true, [...new Set(entry.panels.values())]);
        // Fire and forget: the look reports its own failures.
        void (async () => {
          await entry.running;
          if (entry.stopPolling === null || entry.stop.signal.aborted) return;
          wait = entry.sentChanges === before ? Math.min(POLL_MAX_MS, wait * 2) : POLL_START_MS;
          nextLook();
        })();
      }, wait);
    };
    /**
     * Schedules the next try to watch again.
     *
     * @remarks
     * The wait doubles each time, up to five minutes.
     *
     * @sideEffects Schedules a timer.
     */
    const nextTry = (): void => {
      cancelTry = later(
        () => {
          tries += 1;
          // Fire and forget: a failed try schedules the next.
          void (async () => {
            const working = await startWatching(entry);
            if (entry.stop.signal.aborted || entry.stopPolling === null) return;
            if (working) {
              entry.stopPolling();
              entry.stopPolling = null;
              changed(entry);
            } else {
              nextTry();
            }
          })();
        },
        Math.min(RECOVER_MAX_MS, RECOVER_START_MS * 2 ** tries),
      );
    };
    entry.stopPolling?.();
    entry.stopPolling = () => {
      cancelLook?.();
      cancelTry?.();
    };
    nextLook();
    nextTry();
  }

  /**
   * Asks for a look at a workspace's count, or panels' diffs.
   *
   * @remarks
   * Joins the look under way, or starts one.
   *
   * @sideEffects May run git.
   * @param entry - The workspace.
   * @param changes - Whether to work out the count.
   * @param modes - The panels' modes to work out.
   */
  function ask(entry: Watched, changes: boolean, modes: readonly DiffMode[]): void {
    if (entry.stop.signal.aborted) return;
    entry.wantChanges ||= changes;
    for (const mode of modes) entry.wantDiffs.add(mode);
    if (entry.running !== null) return;
    const look = lookLoop(entry).finally(() => {
      entry.running = null;
      looks.delete(look);
    });
    entry.running = look;
    looks.add(look);
  }

  /**
   * Works out what was asked for, again while more is asked meanwhile.
   *
   * @remarks
   * See `createChangesService`.
   *
   * @sideEffects Runs git; sends events; logs failures.
   * @param entry - The workspace.
   */
  async function lookLoop(entry: Watched): Promise<void> {
    const reader = await options.reader;
    while (!entry.stop.signal.aborted && (entry.wantChanges || entry.wantDiffs.size > 0)) {
      const changes = entry.wantChanges;
      const modes = [...entry.wantDiffs];
      entry.wantChanges = false;
      entry.wantDiffs.clear();
      const place = options.resolve(entry.workspaceId);
      if (reader === null || place === undefined) return;
      try {
        if (changes) {
          const now = await reader.changes(place.dir, place.mainBranch, entry.stop.signal);
          const json = JSON.stringify(now);
          const fresh = json !== entry.sentChanges;
          entry.sentChanges = json;
          const to = fresh ? [...entry.viewers] : [...entry.owedChanges].filter((id) => entry.viewers.has(id));
          entry.owedChanges.clear();
          for (const connectionId of to) {
            options.send(connectionId, { type: "changes_updated", workspaceId: entry.workspaceId, ...now });
          }
        }
        for (const mode of modes) {
          const now = await reader.diff(place.dir, place.mainBranch, mode, entry.stop.signal);
          const json = JSON.stringify(now);
          const fresh = json !== entry.sentDiffs.get(mode);
          entry.sentDiffs.set(mode, json);
          const showingMode = [...entry.panels].filter(([, shown]) => shown === mode).map(([id]) => id);
          const to = fresh ? showingMode : showingMode.filter((id) => entry.owedDiffs.has(id));
          for (const connectionId of to) {
            entry.owedDiffs.delete(connectionId);
            options.send(connectionId, { type: "diff_updated", workspaceId: entry.workspaceId, mode, ...now });
          }
        }
      } catch (error) {
        if (!entry.stop.signal.aborted) failed(entry, error);
      }
    }
  }

  /**
   * Logs git failing on a workspace.
   *
   * @remarks
   * By the command and reason only: git's output and the paths may be private (security.md).
   *
   * @sideEffects Logs.
   * @param entry - The workspace.
   * @param error - What failed.
   */
  function failed(entry: Watched, error: unknown): void {
    if (error instanceof GitError) {
      if (error.reason === "aborted") return;
      options.logger.warn(
        { workspaceId: entry.workspaceId, command: error.command, reason: error.reason },
        "changes not read",
      );
    } else {
      options.logger.warn(
        { workspaceId: entry.workspaceId, error: error instanceof Error ? error.name : "unknown" },
        "changes not read",
      );
    }
  }

  /**
   * Checks a workspace is known.
   *
   * @remarks
   * See `watchChanges`.
   *
   * @sideEffects none
   * @param workspaceId - The workspace.
   * @throws {CommandError} `workspace_not_found`.
   */
  function checkKnown(workspaceId: string): void {
    if (options.resolve(workspaceId) === undefined) throw new CommandError("workspace_not_found", { workspaceId });
  }

  return {
    watchChanges(connectionId, workspaceIds) {
      if (closed) return;
      for (const workspaceId of workspaceIds) checkKnown(workspaceId);
      const before = showing.get(connectionId) ?? [];
      showing.set(connectionId, [...new Set(workspaceIds)]);
      for (const workspaceId of workspaceIds) {
        if (before.includes(workspaceId)) continue;
        const entry = ensure(workspaceId);
        entry.viewers.add(connectionId);
        entry.owedChanges.add(connectionId);
        ask(entry, true, []);
      }
      for (const workspaceId of before) {
        if (workspaceIds.includes(workspaceId)) continue;
        const entry = watched.get(workspaceId);
        if (entry === undefined) continue;
        entry.viewers.delete(connectionId);
        releaseIfUnseen(entry);
      }
    },
    watchDiff(connectionId, target) {
      if (closed) return;
      if (target !== null) checkKnown(target.workspaceId);
      const before = panelOf.get(connectionId);
      if (before !== undefined) {
        const entry = watched.get(before);
        entry?.panels.delete(connectionId);
        entry?.owedDiffs.delete(connectionId);
        panelOf.delete(connectionId);
        if (entry !== undefined && before !== target?.workspaceId) releaseIfUnseen(entry);
      }
      if (target === null) return;
      const entry = ensure(target.workspaceId);
      entry.panels.set(connectionId, target.mode);
      entry.owedDiffs.add(connectionId);
      panelOf.set(connectionId, target.workspaceId);
      ask(entry, false, [target.mode]);
    },
    refresh(workspaceId) {
      const entries = workspaceId === undefined ? [...watched.values()] : [watched.get(workspaceId)];
      for (const entry of entries) {
        if (entry !== undefined) ask(entry, true, [...new Set(entry.panels.values())]);
      }
    },
    disconnect(connectionId) {
      for (const workspaceId of showing.get(connectionId) ?? []) {
        const entry = watched.get(workspaceId);
        entry?.viewers.delete(connectionId);
        if (entry !== undefined) releaseIfUnseen(entry);
      }
      showing.delete(connectionId);
      const panel = panelOf.get(connectionId);
      if (panel !== undefined) {
        const entry = watched.get(panel);
        entry?.panels.delete(connectionId);
        if (entry !== undefined) releaseIfUnseen(entry);
        panelOf.delete(connectionId);
      }
    },
    async close() {
      closed = true;
      for (const entry of watched.values()) {
        entry.viewers.clear();
        entry.panels.clear();
        releaseIfUnseen(entry);
      }
      showing.clear();
      panelOf.clear();
      await Promise.allSettled(looks);
    },
  };
}
