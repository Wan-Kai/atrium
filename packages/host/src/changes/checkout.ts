import type { ChangesUpdatedEvent, DiffFile, DiffMode, DiffUpdatedEvent } from "@atrium/protocol";
import { constants } from "node:fs";
import { type FileHandle, open, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GitError, type GitRunner } from "../platform/git";
import {
  BINARY_SNIFF_BYTES,
  type DiffEntry,
  addedFileHunks,
  countLines,
  isLikelyBinary,
  parseDiffOutput,
  parseHunks,
  parseShortstat,
  splitPatch,
} from "./diff-text";

/** A workspace's changes, without the event's type and workspace. */
export type WorkspaceChanges = Omit<ChangesUpdatedEvent, "type" | "workspaceId">;

/** The changes panel's files, without the event's type, workspace and mode. */
export type WorkspaceDiff = Omit<DiffUpdatedEvent, "type" | "workspaceId" | "mode">;

/** How much of a diff is shown (SPEC-0001, "工作区改动"). */
export interface DiffLimits {
  /** A file whose diff is longer shows no lines. */
  readonly fileBytes: number;
  /** Once the files shown add up to this, the rest show no lines. */
  readonly totalBytes: number;
  /** git's whole diff past this is too large to show at all. */
  readonly patchBytes: number;
}

/** Paseo's limits. */
const LIMITS: DiffLimits = { fileBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024, patchBytes: 8 * 1024 * 1024 };

/** How many untracked files the capsule's count reads, as Paseo. */
const UNTRACKED_COUNTED = 500;

/** git's tree with nothing in it, to diff a repository that has no commit yet against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** What every diff runs with: no colour, no external diff tool, renames found. */
const DIFF = ["diff", "--no-color", "--no-ext-diff", "-M"];

/** How much of a file is read at a time when only its lines are counted. */
const COUNT_CHUNK_BYTES = 64 * 1024;

/** What a workspace's repository is and what it is compared with. */
interface RepoFacts {
  /** The repository's top, which paths are relative to. */
  readonly top: string;
  /** Whether HEAD has a commit. */
  readonly born: boolean;
  readonly branch: string | null;
  /** The ref compared with, by its full name, such as `refs/remotes/origin/main`. */
  readonly baseRef: string | null;
  /** Its short name, as the panel shows it, such as `origin/main`. */
  readonly base: string | null;
  /** Where the branch left `base`. */
  readonly mergeBase: string | null;
}

/**
 * Runs git in a directory and gives its output when it succeeds.
 *
 * @remarks
 * A non-zero exit, which is how git says "no such ref", gives `null`; git failing to run throws.
 *
 * @sideEffects Runs git.
 * @param git - The runner.
 * @param cwd - Where to run it.
 * @param signal - Stops it.
 * @param args - git's arguments.
 * @returns What it printed, or `null`.
 * @throws {GitError} When git could not run.
 */
async function output(git: GitRunner, cwd: string, signal: AbortSignal, ...args: string[]): Promise<string | null> {
  const { code, stdout } = await git.run(args, { cwd, signal });
  return code === 0 ? stdout : null;
}

/**
 * Runs git in a directory and gives its output, which it must produce.
 *
 * @remarks
 * For reads whose failure must not pass for "no changes" (SPEC-0001, "工作区改动").
 *
 * @sideEffects Runs git.
 * @param git - The runner.
 * @param cwd - Where to run it.
 * @param signal - Stops it.
 * @param args - git's arguments.
 * @returns What it printed.
 * @throws {GitError} When git could not run, or `exit` when it failed.
 */
async function required(git: GitRunner, cwd: string, signal: AbortSignal, ...args: string[]): Promise<string> {
  const printed = await output(git, cwd, signal, ...args);
  if (printed === null) throw new GitError(args[0] ?? "", "exit");
  return printed;
}

/**
 * Finds a workspace's repository, branch and what to compare it with.
 *
 * @remarks
 * As Paseo (SPEC-0001, "工作区改动"): off the main branch, `origin/<main>` when it exists, else
 * the local `<main>`, else nothing; on the main branch, or without one, `origin/<branch>` when it
 * exists. The main branch is the project's own setting or where `origin/HEAD` points
 * (domain-model, "已决定 15"). A detached HEAD compares with nothing. Refs go to git by their full
 * names, so a tag or local branch named like one cannot stand in for it.
 *
 * @sideEffects Runs git.
 * @param git - The runner.
 * @param dir - The workspace's directory.
 * @param mainBranch - The project's own main branch, if set.
 * @param signal - Stops git.
 * @returns The facts, or `null` for a directory outside any repository.
 * @throws {GitError} When git could not run.
 */
async function repoFacts(
  git: GitRunner,
  dir: string,
  mainBranch: string | null,
  signal: AbortSignal,
): Promise<RepoFacts | null> {
  const top = (await output(git, dir, signal, "rev-parse", "--show-toplevel"))?.trim();
  if (top === undefined) return null;
  const born = (await output(git, top, signal, "rev-parse", "--verify", "--quiet", "HEAD")) !== null;
  const branch = (await output(git, top, signal, "symbolic-ref", "--quiet", "--short", "HEAD"))?.trim() ?? null;
  if (!born || branch === null) return { top, born, branch, baseRef: null, base: null, mergeBase: null };
  /**
   * Whether a ref exists.
   *
   * @remarks
   * See `repoFacts`.
   *
   * @sideEffects Runs git.
   * @param ref - The full ref.
   * @returns Whether it exists.
   */
  const exists = async (ref: string): Promise<boolean> =>
    (await output(git, top, signal, "show-ref", "--verify", "--quiet", ref)) !== null;
  const originHead = (await output(git, top, signal, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"))?.trim();
  const main = mainBranch ?? originHead?.replace(/^refs\/remotes\/origin\//, "") ?? null;
  let baseRef: string | null = null;
  if (main !== null && main !== branch) {
    if (await exists(`refs/remotes/origin/${main}`)) baseRef = `refs/remotes/origin/${main}`;
    else if (await exists(`refs/heads/${main}`)) baseRef = `refs/heads/${main}`;
  } else if (await exists(`refs/remotes/origin/${branch}`)) {
    baseRef = `refs/remotes/origin/${branch}`;
  }
  const mergeBase =
    baseRef === null ? null : ((await output(git, top, signal, "merge-base", "HEAD", baseRef))?.trim() ?? null);
  const base = baseRef?.replace(/^refs\/(?:heads|remotes)\//, "") ?? null;
  return { top, born, branch, baseRef, base, mergeBase };
}

/**
 * The untracked files of a repository, as git lists them.
 *
 * @remarks
 * Ignored files are left out, as git leaves them out of `status`.
 *
 * @sideEffects Runs git.
 * @param git - The runner.
 * @param top - The repository's top.
 * @param signal - Stops git.
 * @returns Their paths, relative to the top.
 */
async function untrackedFiles(git: GitRunner, top: string, signal: AbortSignal): Promise<string[]> {
  const listed = await required(git, top, signal, "ls-files", "--others", "--exclude-standard", "-z");
  return listed.split("\0").filter((path) => path !== "");
}

/** What an untracked file holds, as far as the changes go. */
type Untracked =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "too_large"; readonly lines: number }
  | { readonly kind: "binary" | "other" };

/**
 * Reads an untracked file without following a link, from one opening.
 *
 * @remarks
 * Opened refusing links and without waiting on a pipe; its type, size and content all come from
 * that one opening, so a file swapped for a link or grown meanwhile cannot be read through
 * (security.md, "子进程与文件"). A link is shown by where it points; a file over `fileBytes` has
 * only its lines counted, unless `count` is off; anything unreadable counts as not there. The
 * start decides whether it is binary.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @param fileBytes - The most to read whole.
 * @param signal - Stops counting a large file.
 * @param count - Whether to count a large file's lines.
 * @returns What it holds.
 */
async function readUntracked(path: string, fileBytes: number, signal: AbortSignal, count: boolean): Promise<Untracked> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ELOOP")) return { kind: "other" };
    return readlink(path).then(
      (target): Untracked => ({ kind: "link", target }),
      (): Untracked => ({ kind: "other" }),
    );
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return { kind: "other" };
    if (info.size > fileBytes)
      return count ? { kind: "too_large", lines: await countFileLines(file, signal) } : { kind: "other" };
    const content = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < content.length) {
      const { bytesRead } = await file.read(content, filled, content.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const read = content.subarray(0, filled);
    if (isLikelyBinary(read.subarray(0, BINARY_SNIFF_BYTES))) return { kind: "binary" };
    return { kind: "text", text: read.toString("utf8") };
  } catch {
    return { kind: "other" };
  } finally {
    await file.close();
  }
}

/**
 * Counts a large file's lines without holding it.
 *
 * @remarks
 * A chunk at a time; a last line without a line break counts too.
 *
 * @sideEffects Reads the file.
 * @param file - The open file.
 * @param signal - Stops counting.
 * @returns The count.
 * @throws {Error} When the signal aborts.
 */
async function countFileLines(file: FileHandle, signal: AbortSignal): Promise<number> {
  const chunk = Buffer.alloc(COUNT_CHUNK_BYTES);
  let lines = 0;
  let last = 0x0a;
  let position = 0;
  for (;;) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    for (let at = 0; at < bytesRead; at++) if (chunk[at] === 0x0a) lines += 1;
    last = chunk[bytesRead - 1] ?? last;
    position += bytesRead;
  }
  return last === 0x0a ? lines : lines + 1;
}

/**
 * A workspace's changes for the capsule above the input box.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"), as Paseo: the working tree against the merge base with what it is
 * compared with (`repoFacts`), plus the lines of the first 500 untracked files that are text, not
 * links, readable and at most 1 MB. No changes, or nothing to compare with, shows nothing. `dirty`
 * comes from `git status`, untracked files included. git failing to read the changes throws, so
 * it never passes for "no changes".
 *
 * @sideEffects Runs git; reads untracked files.
 * @param git - The runner.
 * @param dir - The workspace's directory.
 * @param mainBranch - The project's own main branch, if set.
 * @param signal - Stops git.
 * @returns The changes.
 * @throws {GitError} When git could not run or read the changes.
 */
export async function workspaceChanges(
  git: GitRunner,
  dir: string,
  mainBranch: string | null,
  signal: AbortSignal,
): Promise<WorkspaceChanges> {
  const facts = await repoFacts(git, dir, mainBranch, signal);
  if (facts === null) return { stat: null, dirty: false, ahead: 0, branch: null, base: null };
  const { top, branch, mergeBase } = facts;
  const dirty = (await required(git, top, signal, "status", "--porcelain")) !== "";
  if (mergeBase === null) return { stat: null, dirty, ahead: 0, branch, base: null };
  const tracked = parseShortstat(await required(git, top, signal, "diff", "--shortstat", mergeBase));
  let untracked = 0;
  for (const path of (await untrackedFiles(git, top, signal)).slice(0, UNTRACKED_COUNTED)) {
    signal.throwIfAborted();
    const read = await readUntracked(join(top, path), LIMITS.fileBytes, signal, false);
    if (read.kind === "text") untracked += countLines(read.text);
  }
  const ahead = Number((await required(git, top, signal, "rev-list", "--count", `${mergeBase}..HEAD`)).trim());
  const added = tracked.added + untracked;
  const stat = added === 0 && tracked.removed === 0 ? null : { added, removed: tracked.removed };
  return { stat, dirty, ahead, branch, base: facts.base };
}

/** A file the panel may show, before its lines are weighed against the allowance. */
type Candidate =
  | { readonly kind: "tracked"; readonly entry: DiffEntry; readonly sections: readonly string[] | null }
  | { readonly kind: "untracked"; readonly path: string };

/**
 * Where a candidate file is, which orders the panel.
 *
 * @remarks
 * See `workspaceDiff`.
 *
 * @sideEffects none
 * @param candidate - The file.
 * @returns Its path.
 */
function pathOf(candidate: Candidate): string {
  return candidate.kind === "tracked" ? candidate.entry.path : candidate.path;
}

/**
 * The changes panel's files for a workspace.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"), as Paseo: "uncommitted" is HEAD against the working tree plus the
 * untracked files; "base" is the merge base against HEAD. One `git diff --raw --numstat -p` gives
 * every file and its patch from one look at the tree; sections go to files in order, two for a
 * file turned into a link or back. A rename keeps both of its paths (Paseo diffs a renamed file by
 * its new path only). The files are weighed in the panel's order, by path: a file's patch over
 * `fileBytes`, or every file once the ones shown pass `totalBytes`, keeps its counts but no lines;
 * untracked files past the limit keep their place too (Paseo drops them), and one too large to read
 * has its lines counted. An untracked file that cannot be read is left out. git printing past
 * `patchBytes` makes the whole diff too large; git failing to read says so rather than "no
 * changes".
 *
 * @sideEffects Runs git; reads untracked files.
 * @param git - The runner.
 * @param dir - The workspace's directory.
 * @param mainBranch - The project's own main branch, if set.
 * @param mode - What to compare.
 * @param signal - Stops it.
 * @param limits - How much to show.
 * @returns The files, by path.
 * @throws {Error} When the signal aborts.
 */
export async function workspaceDiff(
  git: GitRunner,
  dir: string,
  mainBranch: string | null,
  mode: DiffMode,
  signal: AbortSignal,
  limits: DiffLimits = LIMITS,
): Promise<WorkspaceDiff> {
  try {
    const facts = await repoFacts(git, dir, mainBranch, signal);
    if (facts === null) return { files: [], tooLarge: false, error: "not_git" };
    const { top } = facts;
    let refs: string[];
    if (mode === "uncommitted") refs = [facts.born ? "HEAD" : EMPTY_TREE];
    else if (facts.mergeBase === null) return { files: [], tooLarge: false, error: null };
    else refs = [facts.mergeBase, "HEAD"];
    let printed: string;
    try {
      const run = await git.run([...DIFF, "--raw", "--numstat", "-p", "-z", ...refs], {
        cwd: top,
        signal,
        maxOutputBytes: limits.patchBytes,
      });
      if (run.code !== 0) throw new GitError("diff", "exit");
      printed = run.stdout;
    } catch (error) {
      if (error instanceof GitError && error.reason === "too_large") return { files: [], tooLarge: true, error: null };
      throw error;
    }
    const { entries, patch } = parseDiffOutput(printed);
    const sections = splitPatch(patch);
    const wanted = entries.reduce((sum, entry) => sum + (entry.typeChanged ? 2 : 1), 0);
    // One run agrees with itself; should it not, no file shows lines until the next look.
    let next = 0;
    const candidates: Candidate[] = entries.map((entry) => {
      const count = entry.typeChanged ? 2 : 1;
      const own = wanted === sections.length ? sections.slice(next, next + count) : null;
      next += count;
      return { kind: "tracked", entry, sections: own };
    });
    if (mode === "uncommitted") {
      for (const path of await untrackedFiles(git, top, signal)) candidates.push({ kind: "untracked", path });
    }
    let shown = 0;
    const files: DiffFile[] = [];
    for (const candidate of candidates.toSorted((a, b) => (pathOf(a) < pathOf(b) ? -1 : 1))) {
      signal.throwIfAborted();
      if (candidate.kind === "tracked") {
        const { entry } = candidate;
        const size = (candidate.sections ?? []).reduce((sum, section) => sum + Buffer.byteLength(section), 0);
        const fits =
          candidate.sections !== null && !entry.binary && size <= limits.fileBytes && shown + size <= limits.totalBytes;
        if (fits) shown += size;
        files.push({
          path: entry.path,
          oldPath: entry.oldPath,
          status: entry.status,
          added: entry.added,
          removed: entry.removed,
          content: entry.binary ? "binary" : fits ? "text" : "too_large",
          hunks: fits ? (candidate.sections ?? []).flatMap(parseHunks) : [],
        });
        continue;
      }
      const read = await readUntracked(join(top, candidate.path), limits.fileBytes, signal, true);
      if (read.kind === "other") continue;
      const text = read.kind === "text" ? read.text : read.kind === "link" ? read.target : "";
      const size = Buffer.byteLength(text);
      const fits = (read.kind === "text" || read.kind === "link") && shown + size <= limits.totalBytes;
      if (fits) shown += size;
      files.push({
        path: candidate.path,
        oldPath: null,
        status: "added",
        added: read.kind === "too_large" ? read.lines : countLines(text),
        removed: 0,
        content: read.kind === "binary" ? "binary" : fits ? "text" : "too_large",
        hunks: fits ? addedFileHunks(text) : [],
      });
    }
    return { files, tooLarge: false, error: null };
  } catch (error) {
    if (signal.aborted) throw error;
    return { files: [], tooLarge: false, error: "failed" };
  }
}

/** Where to watch a workspace's repository for changes. */
export interface WatchRoots {
  /** The repository's top, watched whole. */
  readonly top: string;
  /** git's own directories outside the top, as a linked worktree has; watched for HEAD, the index and refs. */
  readonly gitDirs: readonly string[];
}

/**
 * Where to watch a workspace for changes.
 *
 * @remarks
 * The working tree from its top; a linked worktree's git directory and the repository's shared
 * one live elsewhere, and commits and resets change them (SPEC-0001, "工作区改动").
 *
 * @sideEffects Runs git.
 * @param git - The runner.
 * @param dir - The workspace's directory.
 * @param signal - Stops git.
 * @returns The roots, or `null` outside a repository.
 * @throws {GitError} When git could not run.
 */
export async function watchRoots(git: GitRunner, dir: string, signal: AbortSignal): Promise<WatchRoots | null> {
  const top = (await output(git, dir, signal, "rev-parse", "--show-toplevel"))?.trim();
  if (top === undefined) return null;
  const dirs = (await output(git, top, signal, "rev-parse", "--absolute-git-dir", "--git-common-dir")) ?? "";
  const gitDirs = [
    ...new Set(
      dirs
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => resolve(top, line)),
    ),
  ];
  return { top, gitDirs: gitDirs.filter((gitDir) => !gitDir.startsWith(`${top}/`)) };
}

/**
 * The directories git ignores in a working tree.
 *
 * @remarks
 * Changes inside them change nothing git shows, so the watcher leaves them out, as Paseo does.
 *
 * @sideEffects Runs git.
 * @param git - The runner.
 * @param top - The repository's top.
 * @param signal - Stops git.
 * @returns Their paths relative to the top, each ending in `/`.
 * @throws {GitError} When git could not run.
 */
export async function ignoredDirs(git: GitRunner, top: string, signal: AbortSignal): Promise<string[]> {
  const listed = await output(
    git,
    top,
    signal,
    "ls-files",
    "--others",
    "--ignored",
    "--directory",
    "--exclude-standard",
    "-z",
  );
  return (listed ?? "").split("\0").filter((path) => path.endsWith("/"));
}

/** Reads a workspace's git changes; what `ChangesService` uses. */
export interface CheckoutReader {
  changes(dir: string, mainBranch: string | null, signal: AbortSignal): Promise<WorkspaceChanges>;
  diff(dir: string, mainBranch: string | null, mode: DiffMode, signal: AbortSignal): Promise<WorkspaceDiff>;
  roots(dir: string, signal: AbortSignal): Promise<WatchRoots | null>;
  ignored(top: string, signal: AbortSignal): Promise<string[]>;
}

/**
 * Creates the reader over a git runner.
 *
 * @remarks
 * See `workspaceChanges`, `workspaceDiff`, `watchRoots` and `ignoredDirs`.
 *
 * @sideEffects none
 * @param git - The runner.
 * @returns The reader.
 */
export function createCheckoutReader(git: GitRunner): CheckoutReader {
  return {
    changes: (dir, mainBranch, signal) => workspaceChanges(git, dir, mainBranch, signal),
    diff: (dir, mainBranch, mode, signal) => workspaceDiff(git, dir, mainBranch, mode, signal),
    roots: (dir, signal) => watchRoots(git, dir, signal),
    ignored: (top, signal) => ignoredDirs(git, top, signal),
  };
}
