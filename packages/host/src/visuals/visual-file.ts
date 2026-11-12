import { CommandError, VISUAL_FILE_MAX } from "@atrium/protocol";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A visual file that passed the checks: where it is, how large and when it last changed. */
export interface VisualFile {
  /** Its absolute path, inside the directory for visuals, with no link on the way. */
  readonly file: string;
  readonly size: number;
  /** Milliseconds since the Unix epoch, whole. */
  readonly mtime: number;
}

/**
 * What a directory for visuals of a study direction adds to the checks (SPEC-0008, "ML4 定的细节 · 演示").
 *
 * @remarks
 * A direction moves when it is archived or restored while its sessions' records keep the place
 * they ran in; and its `visuals/` lies in the agent's working directory, where the agent could
 * swap it for a link.
 */
export interface VisualDirRules {
  /** The place the session's record names, when the direction is no longer there: absolute paths under it count from `cwd`. */
  readonly movedFrom?: string | undefined;
  /**
   * Whether the folder holding the directory is still a real directory where the host expects it;
   * given, the directory must itself be a real folder right in it, not a link.
   */
  readonly owned?: (() => Promise<boolean>) | undefined;
}

/**
 * The `code` of a file system error, if it has one.
 *
 * @remarks
 * Node's errors carry it; anything else thrown has none.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns The code, or `undefined`.
 */
function codeOf(error: unknown): unknown {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: only Node's errors reach here, all objects.
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}

/**
 * Where a path a reply names lands inside a directory for visuals.
 *
 * @remarks
 * SPEC-0007 ("一个演示 = 一个文件"): relative to the session's working directory, or absolute; it
 * must be a `.html` file inside the directory, not the directory itself.
 *
 * @sideEffects none
 * @param dir - The directory for visuals.
 * @param cwd - The session's working directory.
 * @param path - The path the reply named.
 * @param movedFrom - Where the session's record says it ran, when that moved to `cwd` (ML4).
 * @returns The absolute path and its part below the directory.
 * @throws {CommandError} `visual_outside`.
 */
export function placeVisual(
  dir: string,
  cwd: string,
  path: string,
  movedFrom?: string,
): { readonly file: string; readonly below: string } {
  const file = isAbsolute(path) ? moved(resolve(path), movedFrom, cwd) : resolve(cwd, path);
  const below = relative(resolve(dir), file);
  if (below === "" || below.startsWith(`..${sep}`) || below === ".." || isAbsolute(below)) {
    throw new CommandError("visual_outside");
  }
  if (!/\.html$/iu.test(file)) throw new CommandError("visual_outside");
  return { file, below };
}

/**
 * An absolute path under the place a direction was, as it is under where the direction is now.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 演示": a reply written before the direction was archived names the old
 * place. Only the prefix changes; the result is checked as any other path. A path elsewhere stays.
 *
 * @sideEffects none
 * @param file - The absolute path, resolved.
 * @param from - Where the direction was, if it moved.
 * @param to - Where it is now.
 * @returns The path.
 */
function moved(file: string, from: string | undefined, to: string): string {
  if (from === undefined) return file;
  const below = relative(from, file);
  return below.startsWith("..") || isAbsolute(below) ? file : join(to, below);
}

/**
 * Makes sure a direction's directory for visuals is a real folder right in the direction's.
 *
 * @remarks
 * security.md ("渲染内容", ML4): it is in the agent's working directory, so it must not be a link;
 * its real path's parent is the direction's real path, and the direction itself passes the host's
 * check. A folder not made yet is missing, so its card waits for it. Its real path is returned, for
 * the check again once the file is open.
 *
 * @sideEffects Reads the file system.
 * @param dir - The directory for visuals.
 * @param owned - The direction's check.
 * @returns The directory's real path.
 * @throws {CommandError} `visual_outside` or `visual_missing`.
 */
async function checkOwned(dir: string, owned: () => Promise<boolean>): Promise<string> {
  if (!(await owned())) throw new CommandError("visual_outside");
  const info = await lstat(dir).catch(() => null);
  if (info === null) throw new CommandError("visual_missing");
  if (info.isSymbolicLink() || !info.isDirectory()) throw new CommandError("visual_outside");
  const [real, owner] = await Promise.all([realpath(dir), realpath(dirname(dir))]).catch(() => {
    throw new CommandError("visual_missing");
  });
  // Stryker disable next-line ConditionalExpression: a folder that is no link has its parent's real path; this guards a swap in between.
  if (dirname(real) !== owner) throw new CommandError("visual_outside");
  return real;
}

/**
 * Makes sure an opened file is the one at its place inside the directory, reached without a link.
 *
 * @remarks
 * security.md ("渲染内容", MV1 three-way review): `O_NOFOLLOW` guards only the last part, and the
 * folder's real path was checked before the opening, so a folder swapped for a link in between
 * would have opened a file outside. After the opening, each part below the directory's real path
 * must be a folder that is no link, and the last the same file (device and inode) as the opened
 * one. Whatever was opened, a file that passes is inside now.
 *
 * @sideEffects Reads the file system.
 * @param realDir - The directory's real path.
 * @param below - The file's path below it.
 * @param opened - The opened file's device and inode.
 * @throws {CommandError} `visual_outside`.
 */
async function confirmInside(
  realDir: string,
  below: string,
  opened: { readonly dev: number; readonly ino: number },
): Promise<void> {
  const parts = below.split(sep);
  let at = realDir;
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    const seen = await lstat(at);
    const last = index === parts.length - 1;
    if (seen.isSymbolicLink() || !(last ? seen.isFile() : seen.isDirectory())) throw new CommandError("visual_outside");
    if (last && (seen.dev !== opened.dev || seen.ino !== opened.ino)) throw new CommandError("visual_outside");
  }
}

/**
 * Opens a visual file, making sure no link lies between the directory and it.
 *
 * @remarks
 * security.md ("渲染内容"): the real path of the file's folder must be the directory's real path
 * with the same parts below it, so a link to a folder fails; the file itself is opened without
 * following a link, and checked again after the opening (`confirmInside`). The directory may
 * itself be reached through a link (a home that is one). A failure that is no refusal, as a file
 * it may not read, is told as missing: the file system's error carries the path, which must stay
 * out of errors and logs. A direction's `visuals/` (`owned`) is checked again once the file is open
 * and must still have the real path the opening went by: the direction or `visuals/` swapped for a
 * link before the opening, kept or swapped back after it, is refused (ML4 three-way review).
 *
 * @sideEffects Opens the file; the caller closes it.
 * @param dir - The directory for visuals.
 * @param file - The absolute file, inside it.
 * @param below - The file's path below the directory.
 * @param beforeOpen - Runs between the checks and the opening; for tests of that race.
 * @param owned - A direction's check, for its `visuals/` (`VisualDirRules`).
 * @returns The open file, its size and when it changed.
 * @throws {CommandError} `visual_missing`, `visual_outside` or `visual_too_large`.
 */
async function openChecked(
  dir: string,
  file: string,
  below: string,
  beforeOpen?: () => Promise<void>,
  owned?: () => Promise<boolean>,
): Promise<{ readonly handle: FileHandle; readonly size: number; readonly mtime: number }> {
  if (owned !== undefined) await checkOwned(dir, owned);
  let realDir: string;
  let realFolder: string;
  try {
    realDir = await realpath(dir);
    realFolder = await realpath(dirname(file));
  } catch {
    throw new CommandError("visual_missing");
  }
  if (realFolder !== join(realDir, dirname(below))) throw new CommandError("visual_outside");
  await beforeOpen?.();
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === "ELOOP") throw new CommandError("visual_outside");
    throw new CommandError("visual_missing");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new CommandError("visual_outside");
    if (stats.size > VISUAL_FILE_MAX) throw new CommandError("visual_too_large");
    await confirmInside(realDir, below, stats);
    if (owned !== undefined && (await checkOwned(dir, owned)) !== realDir) throw new CommandError("visual_outside");
    return { handle, size: stats.size, mtime: Math.floor(stats.mtimeMs) };
  } catch (error) {
    await handle.close();
    throw error instanceof CommandError ? error : new CommandError("visual_missing");
  }
}

/**
 * Checks a visual a reply names, without reading it.
 *
 * @remarks
 * SPEC-0007 ("一个演示 = 一个文件", "接口与数据"): only `.html` files in the session's directory for
 * visuals, reached without a link, of at most 1 MB. Opening a folder named `.html` fails as not a
 * plain file. Refusals are codes only; the path stays out of errors and logs.
 *
 * @sideEffects Opens and closes the file.
 * @param dir - The session's directory for visuals.
 * @param cwd - The session's working directory, for a relative path.
 * @param path - The path the reply named.
 * @param beforeOpen - Runs between the checks and the opening; for tests of that race.
 * @param rules - A study direction's rules (ML4).
 * @returns Where it is, its size and when it changed.
 * @throws {CommandError} `visual_outside`, `visual_missing` or `visual_too_large`.
 */
export async function checkVisual(
  dir: string,
  cwd: string,
  path: string,
  beforeOpen?: () => Promise<void>,
  rules: VisualDirRules = {},
): Promise<VisualFile> {
  const { file, below } = placeVisual(dir, cwd, path, rules.movedFrom);
  const { handle, size, mtime } = await openChecked(dir, file, below, beforeOpen, rules.owned);
  await handle.close();
  return { file, size, mtime };
}

/**
 * Reads a visual file as it is now, checking it again.
 *
 * @remarks
 * The file may have changed, become a link or grown since it was resolved; it is read from the
 * same opening that was checked, at most 1 MB.
 *
 * @sideEffects Reads the file.
 * @param dir - The session's directory for visuals.
 * @param file - The absolute file `checkVisual` found.
 * @param beforeOpen - Runs between the checks and the opening; for tests of that race.
 * @param owned - A direction's check, for its `visuals/` (`VisualDirRules`).
 * @returns Its text.
 * @throws {CommandError} As `checkVisual`.
 */
export async function readVisual(
  dir: string,
  file: string,
  beforeOpen?: () => Promise<void>,
  owned?: () => Promise<boolean>,
): Promise<string> {
  const { below } = placeVisual(dir, dir, file);
  const { handle } = await openChecked(dir, file, below, beforeOpen, owned);
  try {
    // Stryker disable next-line ArithmeticOperator: the size was checked on this opening; only a file growing while read needs the extra byte.
    const buffer = Buffer.alloc(VISUAL_FILE_MAX + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: as above, a file growing between the check and the read.
      if (length > VISUAL_FILE_MAX) throw new CommandError("visual_too_large");
    }
    return buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    // Stryker disable next-line ConditionalExpression: only a read failing midway throws another error, as above.
    throw error instanceof CommandError ? error : new CommandError("visual_missing");
  } finally {
    // Stryker disable next-line all: an open descriptor is not observable from the result.
    await handle.close();
  }
}
