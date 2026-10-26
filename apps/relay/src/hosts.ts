import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Clock, trackedTimeout } from "./clock";
import { errorCode } from "./errors";
import type { ResourceTracker } from "./resources";

/** `hst_` and 16 hex digits (SPEC-0005, "部署 relay" item 4). */
export const HOST_ID = /^hst_[0-9a-f]{16}$/;

/** One host the relay accepts. The token itself is never stored. */
export interface HostRecord {
  readonly hostId: string;
  readonly name: string;
  /** SHA-256 of the token, lowercase hex. */
  readonly tokenSha256: string;
  /** ISO time of `add-host`. */
  readonly createdAt: string;
}

const hostsSchema = z.strictObject({
  version: z.literal(1),
  hosts: z.array(
    z.strictObject({
      hostId: z.string().regex(HOST_ID),
      name: z.string().min(1).max(64),
      tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
      createdAt: z.iso.datetime(),
    }),
  ),
});

/**
 * Path of the host table in a data directory.
 *
 * @remarks
 * One name shared by the commands that write it and the relay that watches it.
 *
 * @sideEffects none
 * @param dir - The data directory.
 * @returns `<dir>/hosts.json`.
 */
export function hostsPath(dir: string): string {
  return join(dir, "hosts.json");
}

/**
 * SHA-256 of a token, hex.
 *
 * @remarks
 * The relay keeps only this (SPEC-0005, "部署 relay" item 4), and compares the digest of what a
 * host sends with it in constant time.
 *
 * @sideEffects none
 * @param token - The token.
 * @returns The digest.
 */
export function hashToken(token: string): string {
  // Stryker disable next-line StringLiteral: utf8 is the default encoding for a string.
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A new host id and token.
 *
 * @remarks
 * 32 random bytes of token, base64url so the line needs no escaping.
 *
 * @sideEffects Reads the system's random source.
 * @returns The id and the token.
 */
export function newCredentials(): { hostId: string; token: string } {
  return { hostId: `hst_${randomBytes(8).toString("hex")}`, token: randomBytes(32).toString("base64url") };
}

/**
 * Reads the host table; a missing file is an empty table.
 *
 * @remarks
 * A fresh data directory has no hosts until `add-host` runs; the relay starts anyway.
 *
 * @sideEffects Reads the file.
 * @param dir - The data directory.
 * @returns The hosts, or `invalid` when the file is not a host table.
 * @throws When the file exists but cannot be read.
 */
export async function readHosts(dir: string): Promise<{ ok: true; hosts: HostRecord[] } | { ok: false }> {
  let text: string;
  try {
    // Stryker disable next-line StringLiteral: without the encoding the Buffer parses as the same JSON.
    text = await readFile(hostsPath(dir), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, hosts: [] };
    throw error;
  }
  try {
    const parsed = hostsSchema.safeParse(JSON.parse(text));
    return parsed.success ? { ok: true, hosts: parsed.data.hosts } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Replaces the host table atomically, as a 0600 file.
 *
 * @remarks
 * Written to a temporary file in the same directory and renamed, so the watching relay never reads
 * half a table; the rename also gives the file a new inode, which the watcher notices even when
 * the size and time stay the same (security.md, "relay").
 *
 * @sideEffects Creates the directory (0700) if missing; writes and renames a file.
 * @param dir - The data directory.
 * @param hosts - The whole table.
 * @returns Once it is in place.
 */
export async function writeHosts(dir: string, hosts: readonly HostRecord[]): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.hosts.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, hostsPath(dir));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Polls the host table and reports each new version of it.
 *
 * @remarks
 * `add-host` and the other commands run as separate processes (in Docker, `docker exec`), so the
 * serving relay learns of them from the file: every `intervalMs` it compares the file's inode,
 * size and modification time, and reads it when they changed (SPEC-0005, "部署 relay" item 1).
 * Polling a tiny file is simpler than `fs.watch`, which misses renames on some file systems, and
 * runs on the injected clock. A table that does not parse is reported to `onInvalid` and the
 * relay keeps the last good one.
 *
 * @sideEffects Schedules timers; reads the file.
 * @param dir - The data directory.
 * @param clock - Schedules the polls.
 * @param resources - Counts the timer.
 * @param onChange - Gets each new table, after the first read too.
 * @param onInvalid - Told when the file does not parse or cannot be read.
 * @param intervalMs - Time between polls.
 * @returns A function that stops polling; a poll in flight then reports nothing.
 */
export function watchHosts(
  dir: string,
  clock: Clock,
  resources: ResourceTracker,
  onChange: (hosts: HostRecord[]) => void,
  onInvalid: () => void,
  intervalMs: number,
): () => void {
  let stopped = false;
  let seen: string | null = null;
  let cancel: (() => void) | null = null;

  /**
   * One poll: stat, and read when changed.
   *
   * @remarks
   * The version string only moves forward after a successful read, so a failed read is retried.
   *
   * @sideEffects Reads the file; calls the callbacks.
   * @returns Once done; never rejects.
   */
  const poll = async (): Promise<void> => {
    try {
      const info = await stat(hostsPath(dir)).catch((error: unknown) => {
        // Stryker disable next-line ConditionalExpression: any other error fails the read that follows the same way.
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      // Stryker disable next-line StringLiteral: any marker that is not an inode:size:time triple.
      const version = info === null ? "none" : `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (version === seen) return;
      const read = await readHosts(dir);
      if (stopped) return;
      seen = version;
      if (read.ok) onChange(read.hosts);
      else onInvalid();
    } catch {
      if (!stopped) onInvalid();
    }
  };

  /**
   * Polls, then schedules the next poll.
   *
   * @remarks
   * The next poll is scheduled after this one finished, so polls never overlap.
   *
   * @sideEffects Schedules a timer.
   * @returns Once this poll is done.
   */
  const loop = async (): Promise<void> => {
    await poll();
    // Fire and forget: `loop` never rejects, `poll` catches everything.
    if (!stopped) cancel = trackedTimeout(clock, resources, () => void loop(), intervalMs);
  };

  // Fire and forget: `poll` catches everything, and `stop` cancels what `loop` schedules next.
  void loop();
  return () => {
    stopped = true;
    cancel?.();
  };
}
