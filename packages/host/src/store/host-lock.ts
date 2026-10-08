import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorCode } from "../platform/errors";
import { writeAtomically } from "./index-file";

/** What the lock file holds. */
const LockRecord = z.object({
  /** Process id 0 or below names a group, not one process. */
  pid: z.number().int().positive(),
  /** When the holder started, in milliseconds since the epoch. */
  startedAt: z.number(),
  /** Tells this holder's file from a later one's. */
  token: z.string(),
});
type LockRecord = z.infer<typeof LockRecord>;

/** The lock, while this host holds it. */
export interface HostLock {
  /** Removes the lock file if it is still this host's; never rejects. */
  release(): Promise<void>;
}

/**
 * Another live host holds the lock.
 *
 * @remarks
 * See `acquireHostLock`.
 *
 * @sideEffects none
 */
export class HostLockedError extends Error {
  /**
   * Creates the error.
   *
   * @remarks
   * Carries the holder's process id, which the host logs and prints when it refuses to start.
   *
   * @sideEffects none
   * @param pid - The holder's process id, if its file could be read.
   */
  constructor(readonly pid: number | null) {
    super(`another Atrium host (pid ${pid ?? "unknown"}) is using this home directory`);
    this.name = "HostLockedError";
  }
}

/** What the lock needs to know about this process and the system. */
export interface HostLockDeps {
  readonly pid: number;
  readonly now: number;
  /** When the system last started, in milliseconds since the epoch. */
  readonly bootedAt: number;
  /** When the process with this id started, or `null` when there is none. */
  readonly processStartedAt: (pid: number) => Promise<number | null>;
}

/** Slack for start times the system reports to the second. */
const START_SLACK_MS = 1_000;

/**
 * Takes `host.lock` in Atrium's home, so only one host writes the index.
 *
 * @remarks
 * Electron's single-instance lock covers the app, but the host also runs on its own
 * (domain-model §1, "索引的存储"). The file is created only if it does not exist: the record is
 * written whole to a file of its own and linked into place, so a reader never sees it half
 * written. A holder is live when the process with its id started no later than the lock was
 * written: after a crash, the id may already belong to another process, which started later
 * (also across a restart). A dead holder's lock, or a damaged one, is taken over under
 * `host.lock.takeover`, taken the same way, and the holder is checked again once it is held, so
 * of two hosts taking over at once only one wins. A takeover lock left by a host that died while
 * taking over is itself taken over.
 *
 * @sideEffects Writes a file of its own next to `host.lock` and links it into place; reads and may
 * remove `host.lock` and `host.lock.takeover`.
 * @param home - Atrium's home directory.
 * @param deps - This process's id, the time, the boot time and how to tell when a process started.
 * @returns The held lock.
 * @throws {HostLockedError} When a live host holds it, or is taking it over.
 * @throws File system errors other than the lock existing.
 */
export async function acquireHostLock(home: string, deps: HostLockDeps): Promise<HostLock> {
  const path = join(home, "host.lock");
  const takeover = `${path}.takeover`;
  const record: LockRecord = { pid: deps.pid, startedAt: deps.now, token: randomBytes(8).toString("hex") };
  const own = `${path}.${record.token}`;
  await writeAtomically(own, JSON.stringify(record));

  /**
   * Whether a holder is gone, so its lock may be taken over.
   *
   * @remarks
   * See `acquireHostLock`.
   *
   * @sideEffects Asks the system about the holder's process.
   * @param holder - The holder, or `null` for an unreadable file.
   * @returns Whether it is gone.
   */
  async function gone(holder: LockRecord | null): Promise<boolean> {
    if (holder === null || holder.startedAt < deps.bootedAt) return true;
    const started = await deps.processStartedAt(holder.pid);
    return started === null || started > holder.startedAt + START_SLACK_MS;
  }

  /**
   * Links this host's record into place, or reads who is there.
   *
   * @remarks
   * Linking fails when the file exists, which makes taking it atomic.
   *
   * @sideEffects May create the file.
   * @param target - The lock file.
   * @returns `true` when taken, else the holder (`null` for an unreadable file).
   */
  async function claim(target: string): Promise<true | LockRecord | null> {
    try {
      await link(own, target);
      return true;
    } catch (error) {
      // Stryker disable next-line ConditionalExpression,BlockStatement: a link that fails otherwise, with its own file just written, cannot be arranged in a test.
      if (errorCode(error) !== "EEXIST") throw error;
    }
    return readHolder(target);
  }

  try {
    const first = await claim(path);
    if (first === true) return { release: () => releaseLock(path, record.token) };
    if (!(await gone(first))) throw new HostLockedError(first?.pid ?? null);
    let taking = await claim(takeover);
    if (taking !== true) {
      if (!(await gone(taking))) throw new HostLockedError(first?.pid ?? null);
      await rm(takeover, { force: true });
      taking = await claim(takeover);
      if (taking !== true) throw new HostLockedError(first?.pid ?? null);
    }
    try {
      const holder = await readHolder(path);
      if (!(await gone(holder))) throw new HostLockedError(holder?.pid ?? null);
      await rm(path, { force: true });
      // Stryker disable next-line ConditionalExpression,BlockStatement: every host takes over under the takeover lock, so nothing can link in between.
      if ((await claim(path)) !== true) throw new HostLockedError(null);
      return { release: () => releaseLock(path, record.token) };
    } finally {
      await releaseLock(takeover, record.token);
    }
  } finally {
    await rm(own, { force: true });
  }
}

/**
 * Reads who holds a lock.
 *
 * @remarks
 * A file that is gone, damaged or of another shape has no holder and may be taken over.
 *
 * @sideEffects Reads the file.
 * @param path - The lock file.
 * @returns The holder, or `null`.
 */
async function readHolder(path: string): Promise<LockRecord | null> {
  try {
    const parsed = LockRecord.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Removes a lock file when this host still holds it.
 *
 * @remarks
 * Another host may have taken it over (say, after this one was suspended long enough to look
 * dead); its file is left alone.
 *
 * @sideEffects Reads and may remove the file.
 * @param path - The lock file.
 * @param token - This holder's token.
 */
async function releaseLock(path: string, token: string): Promise<void> {
  const holder = await readHolder(path);
  if (holder?.token === token) await rm(path, { force: true });
}

/**
 * When a process started, as the system reports it.
 *
 * @remarks
 * `ps -o lstart=` gives the start to the second, in English with `LC_ALL=C`; nothing printed means
 * there is no such process. Run by its absolute path, never through PATH.
 *
 * @sideEffects Runs `ps`.
 * @param pid - The process id.
 * @returns Milliseconds since the epoch, or `null` when there is no such process.
 */
export function processStartedAt(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C" } }, (_error, stdout) => {
      const started = Date.parse(stdout.trim());
      resolve(Number.isNaN(started) ? null : started);
    });
  });
}
