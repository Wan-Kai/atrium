import { randomBytes } from "node:crypto";
import { link, readFile, rm } from "node:fs/promises";
import { writeAtomically } from "./index-file";
import { join } from "node:path";
import { z } from "zod";
import { errorCode } from "../platform/errors";

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
  /** Whether a process with this id exists. */
  readonly isAlive: (pid: number) => boolean;
}

/**
 * Takes `host.lock` in Atrium's home, so only one host writes the index.
 *
 * @remarks
 * Electron's single-instance lock covers the app, but the host also runs on its own
 * (domain-model §1, "索引的存储"). The file is created only if it does not exist. When it does, its holder is
 * live only if its process exists and it was written since the system started: a process id
 * from before a restart may now belong to anything. A dead holder's file, or a damaged one, is
 * taken over. Two hosts taking over the same dead lock at the same moment could both win; with
 * Electron's lock in front, that needs two standalone hosts started together after a crash, which
 * is not guarded against.
 *
 * @sideEffects Writes a file of its own next to `host.lock` and links it into place; reads and may
 * remove `host.lock`.
 * @param home - Atrium's home directory.
 * @param deps - This process's id, the time, the boot time and a liveness check.
 * @returns The held lock.
 * @throws {HostLockedError} When a live host holds it.
 * @throws File system errors other than the lock existing.
 */
export async function acquireHostLock(home: string, deps: HostLockDeps): Promise<HostLock> {
  const path = join(home, "host.lock");
  const record: LockRecord = { pid: deps.pid, startedAt: deps.now, token: randomBytes(8).toString("hex") };
  // The record is written whole to a file of its own and then linked into place, which fails if
  // the lock exists; a reader never sees a lock file half written. A dead holder's file is removed
  // and linking tried once more; failing again means another host just took it.
  const own = `${path}.${record.token}`;
  await writeAtomically(own, JSON.stringify(record));
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await link(own, path);
        return { release: () => releaseLock(path, record.token) };
      } catch (error) {
        // Stryker disable next-line ConditionalExpression,BlockStatement: a link that fails otherwise, with its own file just written, cannot be arranged in a test.
        if (errorCode(error) !== "EEXIST") throw error;
      }
      const holder = await readHolder(path);
      if (holder !== null && holder.startedAt >= deps.bootedAt && deps.isAlive(holder.pid)) {
        throw new HostLockedError(holder.pid);
      }
      // Stryker disable next-line ConditionalExpression,EqualityOperator: losing the race to another host taking over the same dead lock cannot be timed in a test.
      if (attempt > 0) throw new HostLockedError(holder?.pid ?? null);
      await rm(path, { force: true });
    }
  } finally {
    await rm(own, { force: true });
  }
}

/**
 * Reads who holds the lock.
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
 * Removes the lock file when this host still holds it.
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
 * Whether a process exists.
 *
 * @remarks
 * Signal 0 checks without sending anything; `EPERM` means it exists but belongs to someone else.
 *
 * @sideEffects none
 * @param pid - The process id.
 * @returns Whether it exists.
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
