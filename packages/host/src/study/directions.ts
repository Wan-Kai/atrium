import { type StudyProgress, isDirectionId } from "@atrium/protocol";
import { type Dirent, watch } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { STUDY_VERSION, parseStudyFile, progressOf } from "./progress";

/** The marker file that makes a directory a direction, and holds its progress (SPEC-0008). */
export const MARKER = ".atrium-study.json";

/** The directory under the learning directory that archived directions are moved to. */
export const ARCHIVE = "Archive";

/** The most bytes of a marker file read; a larger one is broken. */
const MARKER_LIMIT = 1024 * 1024;

/** How long changes the watch sees are gathered before one scan. */
const WATCH_DELAY_MS = 200;

/** A direction as the learning directory holds it. */
export interface FoundDirection {
  /** `lrn_<directory name>`. */
  readonly id: string;
  /** Its directory's name, the same archived or not. */
  readonly dirName: string;
  /** Where its directory is now: under `Archive/` while archived. */
  readonly dir: string;
  /**
   * Where its directory is when not archived, its sessions' working directory, so they stay filed
   * under it while it is archived.
   */
  readonly home: string;
  readonly archived: boolean;
  /** The display name in its marker; `null` when the marker cannot be read. */
  readonly name: string | null;
  /** When its marker says it was created; `null` when it says nothing readable. */
  readonly createdAt: number | null;
  /** Its marker cannot be read; it shows as under discussion and is never written over. */
  readonly broken: boolean;
  /** Its marker is of a later version: read as far as Atrium knows it, never written (ML2). */
  readonly newer: boolean;
  /** It has no ladder yet (SPEC-0008, "讨论"). */
  readonly discussing: boolean;
  /** Its ladder, steps and gaps; `null` while under discussion or broken (ML2). */
  readonly progress: StudyProgress | null;
}

/** Watches a directory and what is below it; returns how to stop. */
export type WatchTree = (dir: string, onEvent: (path: string | null) => void, onError: () => void) => () => void;

/** The learning directory's directions, kept up to date. */
export interface Directions {
  /** The learning directory. */
  readonly root: string;
  /** Every direction, archived or not, as the last scan found them and as added since. */
  list(): readonly FoundDirection[];
  /** A direction by id. */
  find(directionId: string): FoundDirection | undefined;
  /** Lists a direction the host has just made, before a scan finds it. */
  added(found: FoundDirection): void;
  /** Reads the learning directory again; scans asked for during one run once after it. */
  scan(): Promise<void>;
  /** Starts watching the learning directory, if it exists and is not watched yet. */
  watch(): void;
  /** Calls `listener` after the list changed; returns a function that stops it. */
  onChange(listener: () => void): () => void;
  /** Stops watching and waits for a scan under way. */
  close(): Promise<void>;
}

/**
 * Watches a directory tree with Node's recursive `fs.watch`.
 *
 * @remarks
 * macOS watches a whole tree with one stream. A watch that cannot start, as on a directory that
 * is not there, reports an error after returning.
 *
 * @sideEffects Starts a file system watch.
 * @param dir - The directory.
 * @param onEvent - Told of each change, with the path relative to `dir` when the system says.
 * @param onError - Told when watching fails.
 * @returns How to stop.
 */
const watchTree: WatchTree = (dir, onEvent, onError) => {
  try {
    const watcher = watch(dir, { recursive: true }, (_event, path) => onEvent(path));
    // Stryker disable next-line StringLiteral,ArrowFunction,CallExpression: no test can make a running watch fail.
    watcher.on("error", () => onError());
    return () => watcher.close();
  } /* Stryker disable next-line BlockStatement: the directory was just seen there; no test can make the watch refuse to start. */ catch {
    queueMicrotask(onError);
    return () => undefined;
  }
};

/**
 * The learning directory with the links on its way resolved, as far as it exists.
 *
 * @remarks
 * pi records a session's working directory as the system gives it, with links resolved; the
 * catalog files sessions by that path, so a direction's directory must be named the same way, as
 * Atrium's home is. The part that does not exist yet is kept as it is. The learning directory's
 * own name is kept even when it is a link, so the link is seen and refused (security.md, "学习方向").
 *
 * @sideEffects Looks at the path's ancestors.
 * @param path - The learning directory.
 * @returns The path.
 */
export async function resolveRoot(path: string): Promise<string> {
  return join(await resolved(dirname(path)), basename(path));
}

/**
 * A path with every link on it resolved, as far as it exists.
 *
 * @remarks
 * See `resolveRoot`.
 *
 * @sideEffects Looks at the path and its ancestors.
 * @param path - The path.
 * @returns The path.
 */
async function resolved(path: string): Promise<string> {
  const real = await realpath(path).catch(() => null);
  if (real !== null) return real;
  const parent = dirname(path);
  return parent === path ? path : join(await resolved(parent), basename(path));
}

/**
 * A path as the UI shows it: under the home folder, the home folder written `~`.
 *
 * @remarks
 * The learning directory's place in the list (`learningDir`); the UI does not know the home folder.
 *
 * @sideEffects none
 * @param path - The absolute path.
 * @param home - The home folder.
 * @returns The path shown.
 */
export function shownPath(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Whether a path is a directory itself, not a link to one.
 *
 * @remarks
 * The learning directory and its `Archive/` are used only so: through a link, directions would be
 * read, made and moved outside the learning directory (security.md, "学习方向").
 *
 * @sideEffects Looks at the path.
 * @param path - The path.
 * @returns Whether it is a real directory.
 */
export async function realDir(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return info?.isDirectory() === true;
}

/**
 * Whether a change the watch saw can change the list of directions.
 *
 * @remarks
 * Only the first two levels matter: a directory coming or going, `Archive/` and what is in it,
 * and a marker file; changes deeper down, as in `lab/`, do not. A change the system does not name
 * might be any.
 *
 * @sideEffects none
 * @param path - The changed path, relative to the learning directory, or `null`.
 * @returns Whether to scan again.
 */
export function mattersToDirections(path: string | null): boolean {
  if (path === null) return true;
  const parts = path.split("/");
  if (parts.length === 1) return true;
  if (parts[0] === ARCHIVE) return parts.length === 2 || (parts.length === 3 && parts[2] === MARKER);
  return parts.length === 2 && parts[1] === MARKER;
}

/**
 * The id of the direction in a directory, if that directory could be one.
 *
 * @remarks
 * `Archive` in any case is reserved: macOS's file system does not tell cases apart. A name no id
 * could have is passed over, as for chats.
 *
 * @sideEffects none
 * @param name - The directory's name.
 * @returns The id, or `null`.
 */
export function directionIdOf(name: string): string | null {
  if (name.toLowerCase() === ARCHIVE.toLowerCase()) return null;
  const id = `lrn_${name}`;
  return isDirectionId(id) ? id : null;
}

/** What a marker that cannot be read says. */
const BROKEN = { name: null, createdAt: null, broken: true, newer: false, discussing: true, progress: null } as const;

/**
 * Reads a direction's marker file.
 *
 * @remarks
 * `null` when there is none, or it is not a regular file, a link included (opened with
 * `O_NOFOLLOW`): the directory is no direction. A file too large, not JSON or of the wrong shape
 * is a broken marker: still a direction, under discussion, its name its directory's. The shape is
 * the host's whole reading of it (`StudyFile`, SPEC-0008 "ML2 定的细节").
 *
 * @sideEffects Reads the file.
 * @param dir - The directory.
 * @returns What it says, or `null` for no marker.
 */
async function readMarker(
  dir: string,
): Promise<Pick<FoundDirection, "name" | "createdAt" | "broken" | "newer" | "discussing" | "progress"> | null> {
  const file = await open(join(dir, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (file === null) return null;
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile()) return null;
    if (info.size > MARKER_LIMIT) return BROKEN;
    // Stryker disable next-line StringLiteral: without an encoding the buffer parses the same.
    text = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  const marker = parseStudyFile(text);
  if (marker === null) return BROKEN;
  const created = Date.parse(marker.createdAt ?? "");
  const progress = progressOf(marker);
  return {
    name: marker.name,
    createdAt: Number.isFinite(created) && created >= 0 ? created : null,
    broken: false,
    newer: marker.version > STUDY_VERSION,
    discussing: progress === null,
    progress,
  };
}

/**
 * The directions in one directory: its subdirectories with a marker file.
 *
 * @remarks
 * Only real directories: a link to one is passed over, so nothing outside the learning directory
 * becomes a direction; a `parent` that is itself a link holds none.
 *
 * @sideEffects Reads the directory and the markers.
 * @param parent - The learning directory, or its `Archive/`.
 * @param root - The learning directory.
 * @param archived - Whether `parent` is `Archive/`.
 * @returns The directions.
 */
async function directionsIn(parent: string, root: string, archived: boolean): Promise<FoundDirection[]> {
  if (!(await realDir(parent))) return [];
  const entries: Dirent[] = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const found: FoundDirection[] = [];
  // Stryker disable next-line all: APFS lists names in order already; the sort keeps other file systems' listings the same.
  for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const id = entry.isDirectory() ? directionIdOf(entry.name) : null;
    if (id === null) continue;
    const dir = join(parent, entry.name);
    const marker = await readMarker(dir);
    if (marker === null) continue;
    found.push({ id, dirName: entry.name, dir, home: join(root, entry.name), archived, ...marker });
  }
  return found;
}

/**
 * Creates the learning directory's directions.
 *
 * @remarks
 * domain-model §1, Direction: a direction is a directory one level under the learning directory
 * with a `.atrium-study.json`; those under `Archive/` are archived. A name in both places is the
 * one not archived; the archived one is not listed, as both have the same id, and that is logged
 * by id. A learning directory or `Archive/` that is a link holds no directions, and a marker
 * that is a link makes none (security.md, "学习方向"). A direction the host added stays listed
 * through a scan that began before it was added, which may have read the directory too early;
 * the next scan judges by the disk. The directory is watched once it exists (`watch`), with a scan
 * as the watch starts for what came before it, the first two levels only
 * (`mattersToDirections`), changes gathered for `WATCH_DELAY_MS` into one scan; a watch that fails
 * stops, and the next scan asked for, as on window focus, sees the changes and starts it again. The
 * watch and its timer are counted as resources (testing.md, "泄漏测试").
 *
 * @sideEffects none until a call; then reads the learning directory, watches it and schedules
 * timers.
 * @param options - The learning directory, how to watch, the clock, the resource tracker and the logger.
 * @returns The directions.
 */
export function createDirections(options: {
  readonly root: string;
  readonly watch?: WatchTree;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
}): Directions {
  const listeners = new Set<() => void>();
  const watchTreeWith = options.watch ?? watchTree;
  let found: readonly FoundDirection[] = [];
  let scanning: Promise<void> | null = null;
  // Stryker disable next-line BooleanLiteral: true only scans once more at first.
  let again = false;
  /** Aborted by `close`: no more scans, watches or timers. */
  const closing = new AbortController();
  /** Stops the watch; `null` while not watching. */
  let unwatch: (() => void) | null = null;
  /** Cancels the gathered scan; `null` while none waits. */
  let pending: (() => void) | null = null;
  /** The start of a watch under way, which a second start waits for rather than starting another. */
  let arming: Promise<void> | null = null;
  /** How many scans have begun. */
  let scans = 0;
  /**
   * Directions the host added, with how many scans had begun then: a scan begun before one was
   * added keeps it, as it may have read the directory before it was made; a later scan judges.
   */
  const addedAt = new Map<string, { readonly direction: FoundDirection; readonly scans: number }>();

  /**
   * Reads the learning directory and its `Archive/` once.
   *
   * @remarks
   * See `createDirections`.
   *
   * @sideEffects Reads directories and markers; logs a shadowed archive; calls listeners on a change.
   */
  async function scanOnce(): Promise<void> {
    scans += 1;
    const mine = scans;
    const before = JSON.stringify(found);
    const live = await directionsIn(options.root, options.root, false);
    const archived = await directionsIn(join(options.root, ARCHIVE), options.root, true);
    const ids = new Set(live.map((direction) => direction.id));
    for (const direction of archived) {
      if (ids.has(direction.id)) options.logger.warn({ directionId: direction.id }, "archived direction shadowed");
    }
    const read = [...live, ...archived.filter((direction) => !ids.has(direction.id))];
    const kept: FoundDirection[] = [];
    for (const [id, added] of addedAt) {
      if (added.scans < mine) addedAt.delete(id);
      else if (!read.some((direction) => direction.id === id)) kept.push(added.direction);
    }
    found = [...read, ...kept];
    if (JSON.stringify(found) !== before) changed();
  }

  /**
   * Tells the listeners the list changed.
   *
   * @remarks
   * They build what they need again.
   *
   * @sideEffects Calls the listeners.
   */
  function changed(): void {
    for (const listener of listeners) listener();
  }

  /**
   * Scans, once for all the scans asked for while one runs.
   *
   * @remarks
   * As the session catalog's scan; a closed list scans no more.
   *
   * @sideEffects See `scanOnce`.
   * @returns When the scans end.
   */
  function scan(): Promise<void> {
    if (scanning !== null) {
      again = true;
      return scanning;
    }
    scanning = (async () => {
      try {
        do {
          again = false;
          await scanOnce();
        } while (again && !closing.signal.aborted);
      } finally {
        scanning = null;
      }
    })();
    return scanning;
  }

  /**
   * Scans in the background, logging a failure.
   *
   * @remarks
   * For the watch and its retry, which have no caller to report to.
   *
   * @sideEffects See `scan`; may log.
   */
  function scanInBackground(): void {
    // Fire and forget: a failure is logged; the next change or focus scans again.
    // Stryker disable next-line all: a scan reads with every failure caught, so none reaches here in a test.
    void scan().catch((error: unknown) => options.logger.warn({ err: error }, "learning directory not scanned"));
  }

  /**
   * Gathers a change the watch saw into one scan a little later.
   *
   * @remarks
   * See `createDirections`.
   *
   * @sideEffects Schedules a tracked timer.
   * @param path - The changed path, or `null`.
   */
  function seen(path: string | null): void {
    if (closing.signal.aborted || pending !== null || !mattersToDirections(path)) return;
    pending = trackedTimeout(
      options.clock,
      options.resources,
      () => {
        pending = null;
        scanInBackground();
      },
      WATCH_DELAY_MS,
    );
  }

  /**
   * Stops watching after the watch failed.
   *
   * @remarks
   * The directory may have gone; the next scan asked for starts the watch again if it is back.
   *
   * @sideEffects Stops the watch.
   */
  function failed(): void {
    // Stryker disable all: no test can make a running watch fail.
    unwatch?.();
    unwatch = null;
    // Stryker restore all
  }

  /**
   * Starts the watch if the learning directory is there and nothing watches it.
   *
   * @remarks
   * See `createDirections`.
   *
   * @sideEffects Looks at the directory; starts a watch, counted as `study.watch`.
   * @returns When it has started, or found nothing to watch.
   */
  function arm(): Promise<void> {
    if (closing.signal.aborted || unwatch !== null) return Promise.resolve();
    arming ??= (async () => {
      try {
        if (!(await realDir(options.root)) || closing.signal.aborted) return;
        const release = options.resources.acquire("study.watch");
        const stop = watchTreeWith(options.root, seen, failed);
        unwatch = () => {
          stop();
          release();
        };
        // What changed before the watch started is not reported by it.
        scanInBackground();
      } finally {
        arming = null;
      }
    })();
    return arming;
  }

  return {
    root: options.root,
    list: () => found,
    find: (directionId) => found.find((direction) => direction.id === directionId),
    added(direction) {
      if (found.some((known) => known.id === direction.id)) return;
      addedAt.set(direction.id, { direction, scans });
      found = [...found, direction];
      changed();
    },
    async scan() {
      await scan();
      await arm();
    },
    watch() {
      // Fire and forget: `arm` only looks at the directory and cannot reject.
      void arm();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closing.abort();
      await arming;
      pending?.();
      pending = null;
      unwatch?.();
      unwatch = null;
      await scanning?.catch(() => undefined);
    },
  };
}
