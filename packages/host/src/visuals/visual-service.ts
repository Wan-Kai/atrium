import {
  CommandError,
  type CommandResult,
  type SendVisualMessageCommand,
  type SteerCommand,
  type VisualChangedEvent,
  type VisualSource,
} from "@atrium/protocol";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, sep } from "node:path";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { VISUAL_CSP, visualPage } from "./shell";
import { type VisualFile, checkVisual, placeVisual, readVisual } from "./visual-file";

/**
 * Watches one folder, not its subfolders: `onEvent` is told something in it changed, `onError`
 * when watching stops working. Returns how to stop.
 */
export type WatchFolder = (folder: string, onEvent: () => void, onError: () => void) => () => void;

/**
 * Watches a folder with Node's `fs.watch`.
 *
 * @remarks
 * The folder, not the file: an editor that replaces a file whole would end a watch on the file
 * (SPEC-0007, MV1 details). A watch that cannot start reports an error at once.
 *
 * @sideEffects Starts a file system watch.
 * @param folder - The folder.
 * @param onEvent - Told of each change.
 * @param onError - Told when watching fails.
 * @returns Stops watching.
 */
const watchFolder: WatchFolder = (folder, onEvent, onError) => {
  try {
    const watcher = watch(folder, { persistent: false }, onEvent);
    watcher.on("error", onError);
    return () => watcher.close();
  } catch {
    onError();
    return () => undefined;
  }
};

/**
 * Where a session's visuals may be: its working directory, its directory for visuals, and those of
 * the sessions it came from, nearest first (SPEC-0007, MV1 details: a fork or child reads its
 * ancestors' visuals, which its copied history names).
 */
export interface VisualPlace {
  readonly cwd: string;
  readonly dir: string;
  readonly ancestors?: readonly string[];
  /** Where the session's record says it ran, when its study direction moved to `cwd` since (ML4). */
  readonly movedFrom?: string | undefined;
  /** A study direction's check of its own place; `dir` must then be a real folder right in it (ML4). */
  readonly owned?: (() => Promise<boolean>) | undefined;
}

/** Who a visual is resolved for: a session's reply, or a study direction's viewer tab (SPEC-0008, ML4). */
type Owner = { readonly sessionId: string } | { readonly directionId: string };

/** A resolve under way: what it is of (`whoOf`), and whether that was let go meanwhile. */
interface Resolving {
  readonly who: string;
  released: boolean;
}

/** The inline visuals of every session: their addresses, their files, and messages sent from them. */
export interface VisualService {
  /** Checks a visual a reply names and hands out its address; the connection hears when it changes. */
  resolve(connectionId: string, sessionId: string, path: string): Promise<CommandResult<"resolve_visual">>;
  /**
   * Checks a visual right in a study direction's `visuals/` for its viewer tab and hands out its
   * address; the connection hears when it changes. It belongs to no session, so nothing sends from it.
   */
  resolveForDirection(
    connectionId: string,
    directionId: string,
    path: string,
  ): Promise<CommandResult<"resolve_visual">>;
  /** Sends a visual's message as a steer from it, unless the same visual sent one less than a second before. */
  send(command: Omit<SendVisualMessageCommand, "type">): Promise<CommandResult<"send_visual_message">>;
  /** Answers `GET /visual/<token>/<name>` with the page; any other request with 404. */
  serve(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /**
   * A connection's last card of a visual closed: it hears of it no more, and the visual's address
   * is forgotten once no connection looks at it (SPEC-0007, "接口与数据"; ML4 review). A resolve of
   * it still under way adds no look.
   */
  release(connectionId: string, owner: Owner, path: string): void;
  /** A connection closed; it hears of no more changes. */
  disconnect(connectionId: string): void;
  /** Resolves once the looks at changed files under way are done. */
  settled(): Promise<void>;
  /** Stops every watch and timer. */
  close(): void;
}

/** How long the folder must be quiet before its files are looked at, in milliseconds. */
const QUIET_MS = 100;

/** The least time between two messages of one visual, in milliseconds (SPEC-0007, "回传"). */
const MESSAGE_GAP_MS = 1000;

/** What a token stands for: one file in one session's directory for visuals, or a direction's. */
interface Entry {
  readonly dir: string;
  readonly file: string;
  readonly owned?: (() => Promise<boolean>) | undefined;
}

/** A connection looking at a visual, by the path its reply named. */
interface Look {
  readonly connectionId: string;
  /** Who it was resolved for. */
  readonly owner: Owner;
  readonly path: string;
  readonly file: string;
  /** The directory for visuals it is in, which bounds where its folder may be watched from. */
  readonly dir: string;
  /** The highest folder it may be watched from: the directory, or a direction's own folder (ML4). */
  readonly top: string;
  /** The time last told; 0 while the file is missing. */
  mtime: number;
  /** The folder watched for it: its own, or the nearest one there is while that is missing. */
  folder: string;
}

/** One folder being watched, for the looks at its files. */
interface Folder {
  stop: () => void;
  readonly release: () => void;
  readonly looks: Set<Look>;
  quiet: (() => void) | null;
}

// Stryker disable all: the real randomness; tests give their own tokens, the host test the real one.
/**
 * A fresh token: 16 random bytes in lowercase hex.
 *
 * @remarks
 * The token is the address's host, which a URL lowercases; hex survives that, base64url would
 * not (security.md, "渲染内容").
 *
 * @sideEffects Reads the system's randomness.
 * @returns The token.
 */
function randomToken(): string {
  return randomBytes(16).toString("hex");
}

// Stryker restore all
/**
 * The key of a file for who it is resolved for.
 *
 * @remarks
 * A session's and a direction's look at one file are apart: their tokens differ (SPEC-0008, ML4).
 *
 * @sideEffects none
 * @param owner - Who.
 * @param file - The file.
 * @returns The key.
 */
function keyOf(owner: Owner, file: string): string {
  return "sessionId" in owner ? `s\u0000${owner.sessionId}\u0000${file}` : `d\u0000${owner.directionId}\u0000${file}`;
}

/**
 * The key of a visual as a client holds it: who it is resolved for and the path named.
 *
 * @remarks
 * What `release` lets go of: the client knows the path, not the file it lands on.
 *
 * @sideEffects none
 * @param owner - Who.
 * @param path - The path named.
 * @returns The key.
 */
function whoOf(owner: Owner, path: string): string {
  return keyOf(owner, `\u0000${path}`);
}

/**
 * The nearest folder there is on the way to a file, from its own folder up to its directory for visuals.
 *
 * @remarks
 * A file missing when resolved is watched from here, so it is heard of when it appears, even in
 * a folder made later (SPEC-0007, MV1 details); `null` when not even the directory is there.
 *
 * A direction's `visuals/` is made by the agent only with its first visual, so up to the
 * direction's own folder there (ML4).
 *
 * @sideEffects Reads the file system.
 * @param file - The file.
 * @param top - The highest folder: its directory for visuals, or the direction's folder.
 * @returns The folder, or `null`.
 */
async function nearestFolder(file: string, top: string): Promise<string | null> {
  for (let folder = dirname(file); ; folder = dirname(folder)) {
    const found = await stat(folder).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    if (found) return folder;
    if (folder === top) return null;
  }
}

/**
 * The highest folder a place's missing visual may be watched from.
 *
 * @remarks
 * See `nearestFolder`: a direction's own folder, the parent of its `visuals/`; else the directory.
 *
 * @sideEffects none
 * @param place - The place.
 * @param dir - One of its directories for visuals.
 * @returns The folder.
 */
function topOf(place: VisualPlace, dir: string): string {
  return place.owned === undefined ? dir : dirname(dir);
}

/**
 * Checks a path against the session's directory for visuals, then its ancestors', nearest first.
 *
 * @remarks
 * A path outside one directory is tried in the next; one inside a directory is that directory's
 * to answer, found or not (SPEC-0007, MV1 details). A direction's place checks itself for every
 * directory: its sessions' ancestors are its own sessions, whose visuals are in the same `visuals/`
 * (SPEC-0008, ML4).
 *
 * @sideEffects Opens and closes the file.
 * @param place - The session's place.
 * @param path - The path the reply named.
 * @returns The file and the directory it is in.
 * @throws {CommandError} As `checkVisual`, for the last directory tried.
 */
async function checkIn(place: VisualPlace, path: string): Promise<VisualFile & { readonly dir: string }> {
  const dirs = [place.dir, ...(place.ancestors ?? [])];
  for (const dir of dirs) {
    try {
      placeVisual(dir, place.cwd, path, place.movedFrom);
    } catch {
      continue;
    }
    const rules = { movedFrom: place.movedFrom, owned: place.owned };
    return { ...(await checkVisual(dir, place.cwd, path, undefined, rules)), dir };
  }
  throw new CommandError("visual_outside");
}

/**
 * Checks a path a direction's viewer tab names: only a `.html` right in its `visuals/`.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 协议": relative to where the direction is now; no ancestors, no
 * deeper folder, no absolute path, as the viewer tab names a file by its place in the direction.
 *
 * @sideEffects Opens and closes the file.
 * @param place - The direction's place.
 * @param path - The path the tab named.
 * @returns The file.
 * @throws {CommandError} As `checkVisual`.
 */
async function checkInDirection(place: VisualPlace, path: string): Promise<VisualFile & { readonly dir: string }> {
  if (isAbsolute(path)) throw new CommandError("visual_outside");
  const { below } = placeVisual(place.dir, place.cwd, path);
  if (below.includes(sep)) throw new CommandError("visual_outside");
  return { ...(await checkVisual(place.dir, place.cwd, path, undefined, { owned: place.owned })), dir: place.dir };
}

/** A visual's path below `/visual/`: a token and a name. */
const VISUAL_PATH = /^\/visual\/([0-9a-f]{32})\/[^/]+$/u;

/**
 * Creates the service behind `resolve_visual`, `send_visual_message`, `visual_changed` and the
 * `/visual/` pages.
 *
 * @remarks
 * SPEC-0007 and its MV1 details. A token is random, held only in memory for this run, and stands
 * for one file of one session, so an address a visual reads from its own location opens nothing
 * else; the same file keeps its token. Each request reads the file again, checked again. A
 * connection that resolved a file hears when its time changes, watched by folder and looked at
 * once the folder is quiet for 100 ms; the watches end with the connections. Sending checks the
 * visual is still the session's, drops a second message of one visual within a second, and sends
 * the rest as a steer from it. Logs carry no path or text, only counts.
 *
 * @sideEffects none until called; then reads files, watches folders, starts timers, sends events
 * and steers, logs.
 * @param options - Where each session's visuals are, how to steer, how to reach a connection, the
 * clock, resources, logger, and the watch and token makers (tests replace them).
 * @returns The service.
 */
export function createVisualService(options: {
  readonly locate: (sessionId: string) => VisualPlace | undefined;
  /** Where a study direction's visuals are, for its viewer tabs (ML4); without it, no direction has any. */
  readonly locateDirection: (directionId: string) => VisualPlace | undefined;
  readonly steer: (command: SteerCommand, source: VisualSource) => Promise<CommandResult<"steer">>;
  readonly send: (connectionId: string, event: VisualChangedEvent) => void;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  readonly watch?: WatchFolder;
  readonly newToken?: () => string;
}): VisualService {
  const watchOne = options.watch ?? watchFolder;
  const newToken = options.newToken ?? randomToken;
  const entries = new Map<string, Entry>();
  const tokens = new Map<string, string>();
  const folders = new Map<string, Folder>();
  const looksBy = new Map<string, Set<Look>>();
  const lastSent = new Map<string, number>();
  /** Each session's last claim of a message, which the next waits for. */
  const claims = new Map<string, Promise<void>>();
  const looking = new Set<Promise<void>>();
  /** Resolves under way, by connection, whether the connection closed meanwhile, and each one's visual. */
  const pending = new Map<string, { count: number; gone: boolean; readonly resolves: Set<Resolving> }>();
  let closed = false;
  let dropped = 0;

  /**
   * The session's place, or `session_not_found`.
   *
   * @remarks
   * See `createVisualService`.
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @returns Its place.
   * @throws {CommandError} `session_not_found`.
   */
  function placeOf(sessionId: string): VisualPlace {
    const place = options.locate(sessionId);
    if (place === undefined) throw new CommandError("session_not_found");
    return place;
  }

  /**
   * Looks at the files of a quiet folder and tells who looks at a changed one.
   *
   * @remarks
   * A file gone is told with time 0, so its card finds out; a file that appears is told with its
   * time. A look at a missing file watched from a folder above moves down as folders appear.
   *
   * @sideEffects Reads the files' times; sends events; may move looks between watches.
   * @param folder - The folder.
   */
  async function lookAt(folder: Folder): Promise<void> {
    for (const look of folder.looks) {
      const mtime = await stat(look.file).then(
        (stats) => Math.floor(stats.mtimeMs),
        () => 0,
      );
      if (!folder.looks.has(look)) continue;
      if (mtime === 0 && look.folder !== dirname(look.file)) {
        const nearer = await nearestFolder(look.file, look.top);
        if (nearer !== null && nearer !== look.folder && folder.looks.has(look)) moveLook(look, nearer);
      }
      if (mtime === look.mtime) continue;
      look.mtime = mtime;
      options.send(look.connectionId, { type: "visual_changed", ...look.owner, path: look.path, mtime });
    }
  }

  /**
   * Waits for the folder to be quiet, then looks at it.
   *
   * @remarks
   * Each event starts the wait again, so a burst of writes is looked at once.
   *
   * @sideEffects Starts and cancels a timer.
   * @param folder - The folder.
   */
  function changed(folder: Folder): void {
    folder.quiet?.();
    folder.quiet = trackedTimeout(
      options.clock,
      options.resources,
      () => {
        folder.quiet = null;
        const look = lookAt(folder);
        looking.add(look);
        // Fire and forget: `lookAt` catches what reading can throw; `settled` waits for it.
        void look.finally(() => looking.delete(look));
      },
      QUIET_MS,
    );
  }

  /**
   * Stops watching a folder.
   *
   * @remarks
   * When its last look ends, it fails, or the service closes.
   *
   * @sideEffects Stops the watch and its timer.
   * @param path - The folder.
   */
  function unwatch(path: string): void {
    const folder = folders.get(path);
    if (folder === undefined) return;
    folders.delete(path);
    folder.quiet?.();
    folder.stop();
    folder.release();
  }

  /**
   * Watches a folder for a look, starting a watch if nothing watches it yet.
   *
   * @remarks
   * A watch that fails drops its looks, so resolving the file again watches it again.
   *
   * @sideEffects May start a watch.
   * @param look - The look.
   */
  function watchFor(look: Look): void {
    const path = look.folder;
    const folder = folders.get(path);
    if (folder !== undefined) {
      folder.looks.add(look);
      return;
    }
    const created: Folder = {
      stop: () => undefined,
      release: options.resources.acquire("visual.watch"),
      looks: new Set([look]),
      quiet: null,
    };
    folders.set(path, created);
    created.stop = watchOne(
      path,
      () => changed(created),
      () => {
        options.logger.warn({}, "visual watch failed");
        for (const gone of created.looks) dropLook(gone, false);
        unwatch(path);
      },
    );
    // A watch that failed at once let the folder go before it could be stopped.
    if (folders.get(path) !== created) created.stop();
  }

  /**
   * Stops watching a folder for a look, and the folder once no look needs it.
   *
   * @remarks
   * See `watchFor`.
   *
   * @sideEffects May stop a watch.
   * @param look - The look.
   */
  function unwatchFor(look: Look): void {
    const folder = folders.get(look.folder);
    folder?.looks.delete(look);
    if (folder?.looks.size === 0) unwatch(look.folder);
  }

  /**
   * Moves a look to another folder's watch, as its file's folders appear.
   *
   * @remarks
   * See `lookAt`.
   *
   * @sideEffects May start and stop watches.
   * @param look - The look.
   * @param folder - Its new folder.
   */
  function moveLook(look: Look, folder: string): void {
    unwatchFor(look);
    look.folder = folder;
    watchFor(look);
  }

  /**
   * Ends a look, and forgets its file's address and last message once no look is at that file.
   *
   * @remarks
   * Tokens stay the same while any connection looks at the file; the maps hold only what is in use
   * (MV1 three-way review).
   *
   * @sideEffects May stop a watch; updates the maps.
   * @param look - The look.
   * @param unwatchToo - Whether to take it off its folder's watch (not when that watch is ending).
   */
  function dropLook(look: Look, unwatchToo: boolean): void {
    looksBy.get(look.connectionId)?.delete(look);
    if (unwatchToo) unwatchFor(look);
    const key = keyOf(look.owner, look.file);
    for (const mine of looksBy.values()) {
      for (const other of mine) if (keyOf(other.owner, other.file) === key) return;
    }
    const token = tokens.get(key);
    tokens.delete(key);
    if (token !== undefined) entries.delete(token);
    lastSent.delete(key);
  }

  /**
   * Adds a connection's look at a file, watching its folder if nothing does yet.
   *
   * @remarks
   * The same connection resolving the same path again keeps one look, with the newer time, moved
   * to the file's own folder once it is there.
   *
   * @sideEffects May start and stop watches.
   * @param look - The look.
   */
  function addLook(look: Look): void {
    const mine = looksBy.get(look.connectionId) ?? new Set();
    looksBy.set(look.connectionId, mine);
    for (const known of mine) {
      if (keyOf(known.owner, known.file) === keyOf(look.owner, look.file) && known.path === look.path) {
        known.mtime = look.mtime;
        if (known.folder !== look.folder) moveLook(known, look.folder);
        return;
      }
    }
    mine.add(look);
    watchFor(look);
  }

  /**
   * Whether a look may still be added for a connection whose resolve just ended.
   *
   * @remarks
   * Not once the connection closed or the service did meanwhile, nor once its visual was let go:
   * nothing would end its watch.
   *
   * @sideEffects none
   * @param mark - The connection's resolves under way.
   * @param me - This resolve.
   * @returns Whether it may.
   */
  function stillThere(mark: { readonly gone: boolean }, me: Resolving): boolean {
    return !closed && !mark.gone && !me.released;
  }

  /**
   * Watches for a missing file to appear, from the nearest folder there is on its way.
   *
   * @remarks
   * Its card shows it missing; the look tells the connection when it appears.
   *
   * @sideEffects Reads the file system; may start a watch.
   * @param connectionId - The connection.
   * @param owner - Who it is resolved for.
   * @param path - The path the reply named.
   * @param place - The session's place.
   * @param mark - The connection's resolves under way.
   * @param me - This resolve.
   */
  async function watchMissing(
    connectionId: string,
    owner: Owner,
    path: string,
    place: VisualPlace,
    mark: { readonly gone: boolean },
    me: Resolving,
  ): Promise<void> {
    for (const dir of [place.dir, ...(place.ancestors ?? [])]) {
      let file: string;
      try {
        file = placeVisual(dir, place.cwd, path, place.movedFrom).file;
      } catch {
        continue;
      }
      const top = topOf(place, dir);
      const folder = await nearestFolder(file, top);
      if (folder !== null && stillThere(mark, me))
        addLook({ connectionId, owner, path, file, dir, top, mtime: 0, folder });
      return;
    }
  }

  /**
   * Resolves a visual for someone: checks it, hands out its token, and watches it.
   *
   * @remarks
   * See `createVisualService`; a missing file is watched for, so its card hears when it appears.
   *
   * @sideEffects Reads the file; may start a watch; updates the maps.
   * @param connectionId - The connection.
   * @param owner - Who it is resolved for.
   * @param place - Their place.
   * @param path - The path named.
   * @param check - How the path is checked in the place.
   * @returns The address, size and time.
   * @throws {CommandError} As the check.
   */
  async function resolveIn(
    connectionId: string,
    owner: Owner,
    place: VisualPlace,
    path: string,
    check: (place: VisualPlace, path: string) => Promise<VisualFile & { readonly dir: string }>,
  ): Promise<CommandResult<"resolve_visual">> {
    const mark = pending.get(connectionId) ?? { count: 0, gone: false, resolves: new Set<Resolving>() };
    pending.set(connectionId, mark);
    mark.count += 1;
    const me: Resolving = { who: whoOf(owner, path), released: false };
    mark.resolves.add(me);
    try {
      let visual: VisualFile & { readonly dir: string };
      try {
        visual = await check(place, path);
      } catch (error) {
        if (error instanceof CommandError && error.code === "visual_missing") {
          await watchMissing(connectionId, owner, path, place, mark, me);
        }
        throw error;
      }
      const key = keyOf(owner, visual.file);
      let token = tokens.get(key);
      if (stillThere(mark, me)) {
        if (token === undefined) {
          token = newToken();
          tokens.set(key, token);
          entries.set(token, { dir: visual.dir, file: visual.file, owned: place.owned });
        }
        const top = topOf(place, visual.dir);
        const look = { connectionId, owner, path, file: visual.file, dir: visual.dir, top, mtime: visual.mtime };
        addLook({ ...look, folder: dirname(visual.file) });
      }
      return {
        url: `atrium-visual://${token ?? newToken()}/${encodeURIComponent(basename(visual.file))}`,
        size: visual.size,
        mtime: visual.mtime,
      };
    } finally {
      mark.resolves.delete(me);
      mark.count -= 1;
      if (mark.count === 0) pending.delete(connectionId);
    }
  }

  /**
   * Checks a message's visual and claims its second, unless the same visual claimed one less than
   * a second before.
   *
   * @remarks
   * See `createVisualService`; `send` runs one session's claims one at a time, in order.
   *
   * @sideEffects Reads the file; updates the times; may log a drop.
   * @param sessionId - The session.
   * @param path - The visual's path, as its reply named it.
   * @returns Whether to send it.
   * @throws {CommandError} As `checkIn`, or `session_not_found`.
   */
  async function claim(sessionId: string, path: string): Promise<boolean> {
    const visual = await checkIn(placeOf(sessionId), path);
    const key = keyOf({ sessionId }, visual.file);
    const now = options.clock.now();
    // Only the last second's times matter; the older ones go, so the map holds no more.
    // Stryker disable next-line all: only frees memory; a time a second old is let through below all the same.
    for (const [sentKey, at] of lastSent) if (now - at >= MESSAGE_GAP_MS) lastSent.delete(sentKey);
    const last = lastSent.get(key);
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: without a last time the difference is NaN, which is never less; a time a second old was forgotten above, so `<=` drops nothing more.
    if (last !== undefined && now - last < MESSAGE_GAP_MS) {
      dropped += 1;
      options.logger.info({ dropped }, "visual message dropped");
      return false;
    }
    lastSent.set(key, now);
    return true;
  }

  return {
    async resolve(connectionId, sessionId, path) {
      return resolveIn(connectionId, { sessionId }, placeOf(sessionId), path, checkIn);
    },
    async resolveForDirection(connectionId, directionId, path) {
      const place = options.locateDirection(directionId);
      if (place === undefined) throw new CommandError("direction_not_found");
      return resolveIn(connectionId, { directionId }, place, path, checkInDirection);
    },
    async send({ requestId, traceparent, sessionId, path, text }) {
      // The check and the claim of one session's messages go in the order they came: the check reads
      // the file system, and two messages of one visual must not both pass before either claims.
      const turn = (claims.get(sessionId) ?? Promise.resolve()).then(() => claim(sessionId, path));
      const settled = turn.then(
        () => undefined,
        () => undefined,
      );
      claims.set(sessionId, settled);
      // Fire and forget: only frees memory once the claim settles.
      // Stryker disable next-line all: only frees memory; a settled claim holds up nothing.
      void settled.finally(() => {
        // Stryker disable next-line all: see above.
        if (claims.get(sessionId) === settled) claims.delete(sessionId);
      });
      if (!(await turn)) return { disposition: "dropped" };
      return options.steer({ type: "steer", requestId, traceparent, sessionId, text }, { kind: "visual", path });
    },
    async serve(request, response) {
      // Stryker disable next-line StringLiteral: Node always gives a request's URL.
      const pathname = new URL(request.url ?? "/", "http://host.invalid").pathname;
      const token = VISUAL_PATH.exec(pathname)?.[1];
      // Stryker disable next-line ConditionalExpression: no entry has an undefined token.
      const entry = token === undefined ? undefined : entries.get(token);
      if (request.method !== "GET" || entry === undefined) {
        response.writeHead(404).end();
        return;
      }
      let page: string;
      try {
        page = visualPage(await readVisual(entry.dir, entry.file, undefined, entry.owned));
      } catch {
        // Refusals are codes only: nothing of the file reaches the log.
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": VISUAL_CSP,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        })
        .end(page);
    },
    release(connectionId, owner, path) {
      const who = whoOf(owner, path);
      for (const resolving of pending.get(connectionId)?.resolves ?? []) {
        if (resolving.who === who) resolving.released = true;
      }
      const mine = looksBy.get(connectionId);
      if (mine === undefined) return;
      // A Set iterated while its current entry is deleted goes on with the next.
      for (const look of mine) if (whoOf(look.owner, look.path) === who) dropLook(look, true);
      if (mine.size === 0) looksBy.delete(connectionId);
    },
    disconnect(connectionId) {
      const mark = pending.get(connectionId);
      if (mark !== undefined) mark.gone = true;
      const mine = looksBy.get(connectionId);
      if (mine === undefined) return;
      for (const look of mine) dropLook(look, true);
      looksBy.delete(connectionId);
    },
    async settled() {
      await Promise.all(looking);
    },
    close() {
      closed = true;
      for (const path of folders.keys()) unwatch(path);
      looksBy.clear();
      tokens.clear();
      entries.clear();
      lastSent.clear();
    },
  };
}
