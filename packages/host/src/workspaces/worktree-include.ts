import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import { runSafeGit } from "./safe-git";

/** The name of the file listing what a new worktree takes along (SPEC-0006, "工作区"). */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/** The largest file copied: 10 MiB. */
export const INCLUDE_FILE_LIMIT = 10 * 1024 * 1024;

/** The most bytes copied into one worktree: 64 MiB. */
export const INCLUDE_TOTAL_LIMIT = 64 * 1024 * 1024;

/** The most files copied into one worktree. */
export const INCLUDE_COUNT_LIMIT = 500;

/** The folders whose contents are never copied, wherever they are. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/**
 * Where a copy is staged: beside the new worktree, so that it is on the same file system and can be linked in.
 *
 * @remarks
 * Not inside the worktree: a half-written file there would be untracked content, and a crash would leave it for good.
 *
 * @sideEffects none
 * @param destDir - The new worktree.
 * @returns The staging directory's path.
 */
function stageOf(destDir: string): string {
  return `${destDir}.atrium-include`;
}

/** What copying took along and left out; counts only, as paths stay out of logs. */
export interface IncludeResult {
  readonly copied: number;
  readonly skipped: number;
}

/**
 * Splits git's NUL-separated list of paths.
 *
 * @remarks
 * `-z` keeps paths with newlines or quotes whole.
 *
 * @sideEffects none
 * @param output - What git printed.
 * @returns The paths, sorted so the same files are taken first each time.
 */
function pathsOf(output: string): string[] {
  return output
    .split("\0")
    .filter((path) => path !== "")
    .toSorted();
}

/**
 * The files of a directory that `.worktreeinclude` lists and git ignores.
 *
 * @remarks
 * Untracked files the include file's patterns match (`git ls-files --others --ignored` with only
 * that file as the rule), narrowed to those `git check-ignore` says the repository's own ignore
 * rules cover: a file nobody ignores is not a secret to carry over and would be in the commit.
 * Without an include file, or a link or anything but a file in its place, there is nothing.
 *
 * @sideEffects Reads the file system; runs git.
 * @param git - git.
 * @param sourceDir - The directory holding `.worktreeinclude`.
 * @returns The files, relative to the directory; none when the include file is missing or git fails.
 */
async function listed(git: GitRunner, sourceDir: string): Promise<string[]> {
  const file = join(sourceDir, WORKTREE_INCLUDE_FILE);
  const info = await lstat(file).catch(() => null);
  // A link could lead git to read any file as patterns.
  if (info?.isFile() !== true) return [];
  // Through `runSafeGit`: the repository's configuration is the agent's to write, and `ls-files` consults the index.
  const guard = { rejectIncludes: false };
  const candidates = await runSafeGit(
    git,
    ["ls-files", "--others", "--ignored", "-z", `--exclude-from=${file}`],
    { cwd: sourceDir },
    guard,
  );
  if (candidates.code !== 0) return [];
  const kept = pathsOf(candidates.stdout).filter((path) => !path.split("/").some((part) => SKIPPED_FOLDERS.has(part)));
  if (kept.length === 0) return [];
  const ignored = await runSafeGit(
    git,
    ["check-ignore", "-z", "--stdin"],
    { cwd: sourceDir, input: `${kept.join("\0")}\0` },
    guard,
  );
  // Exit 1 is no path ignored.
  return ignored.code === 0 ? pathsOf(ignored.stdout) : [];
}

/** Test seams: a moment inside a copy where a test can stop the host, as a kill would. */
export interface IncludeHooks {
  /** Called when half of a file is in its staging file and the other half is not. */
  readonly midWrite?: (path: string) => void;
}

/**
 * Copies one file into the new worktree, unless it is too large or anything about it is off.
 *
 * @remarks
 * The source is opened without following a link and must be a regular file; the destination's
 * folders must really be inside the new worktree (a tracked link there could lead out). The copy is written whole to
 * a staging file beside the worktree and then linked to its place, which fails if the place is taken, so a user's
 * file is never overwritten and a host that dies in the middle leaves no half-written file where a whole one is
 * expected (SPEC-0006, "T9 / T10 审查后用户定").
 *
 * @sideEffects Reads and writes files.
 * @param sourceDir - Where the file is from.
 * @param destDir - The new worktree.
 * @param realDest - The new worktree's real path.
 * @param path - The file, relative to both.
 * @param room - How many bytes the total limit still leaves.
 * @param hooks - Test seams.
 * @param signal - Stops the copy where it is.
 * @returns The bytes copied, or `null` when the file was left out.
 */
async function copyOne(
  sourceDir: string,
  destDir: string,
  realDest: string,
  path: string,
  room: number,
  hooks: IncludeHooks | undefined,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const source = await open(join(sourceDir, path), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (source === null) return null;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size > INCLUDE_FILE_LIMIT || info.size > room) return null;
    const target = join(destDir, path);
    await mkdir(dirname(target), { recursive: true });
    const real = await realpath(dirname(target));
    if (real !== realDest && !real.startsWith(`${realDest}${sep}`)) return null;
    const stage = stageOf(destDir);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const staged = join(stage, randomUUID());
    const written = await open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      info.mode & 0o777,
    );
    try {
      const content = await source.readFile();
      const half = Math.floor(content.length / 2);
      await written.write(content, 0, half);
      hooks?.midWrite?.(path);
      signal?.throwIfAborted();
      await written.write(content, half, content.length - half);
    } finally {
      await written.close();
    }
    // `link` fails when the place is taken (a file the user has, or one an earlier copy made): nothing is replaced.
    const linked = await link(staged, target).then(
      () => true,
      () => false,
    );
    await unlink(staged).catch(() => undefined);
    return linked ? info.size : null;
  } finally {
    await source.close();
  }
}

/**
 * Copies the files `.worktreeinclude` lists, and git ignores, from a directory to a new worktree.
 *
 * @remarks
 * SPEC-0006 ("工作区"), security.md ("任务"): the files an ignored `.env` or local settings need
 * are not in the commit, so a new worktree would lack them. Only regular files are copied, as
 * copies and not links; `.git` and `node_modules` are skipped; a file over 10 MiB is left out; the
 * copying stops at 64 MiB or 500 files. Anything left out is counted in one log line without
 * paths. It never fails the worktree's creation: what cannot be copied is left out.
 *
 * Each file is published whole or not at all, and a file already in its place stays as it is, so running it again
 * after a host died in the middle finishes the job (the adoption of a half-made worktree does). The staging area
 * beside the worktree is cleared before and after. The `signal` stops it between files and inside one, and the
 * stop is not swallowed.
 *
 * @sideEffects Runs git (through `runSafeGit`); reads files in `sourceDir`; writes files in `destDir` and beside it; logs.
 * @param options - git, the directory with the include file, the new worktree, the logger, a signal and test seams.
 * @returns How many files were copied and how many left out.
 * @throws {unknown} The signal's reason when it aborts.
 */
export async function copyWorktreeInclude(options: {
  readonly git: GitRunner;
  readonly sourceDir: string;
  readonly destDir: string;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly hooks?: IncludeHooks;
}): Promise<IncludeResult> {
  const stage = stageOf(options.destDir);
  // What a host that died in the middle left in the staging area is no copy of anything.
  await rm(stage, { recursive: true, force: true });
  const paths = await listed(options.git, options.sourceDir).catch(() => []);
  const realDest = await realpath(options.destDir);
  let copied = 0;
  let total = 0;
  try {
    for (const path of paths) {
      options.signal?.throwIfAborted();
      if (copied >= INCLUDE_COUNT_LIMIT) break;
      const size = await copyOne(
        options.sourceDir,
        options.destDir,
        realDest,
        path,
        INCLUDE_TOTAL_LIMIT - total,
        options.hooks,
        options.signal,
      ).catch((error: unknown) => {
        if (options.signal?.aborted === true) throw error;
        return null;
      });
      if (size === null) continue;
      copied += 1;
      total += size;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const skipped = paths.length - copied;
  if (skipped > 0) options.logger.warn({ copied, skipped }, "worktree include left files out");
  return { copied, skipped };
}
