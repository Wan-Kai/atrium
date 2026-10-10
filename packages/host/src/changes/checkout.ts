import type { ChangesUpdatedEvent, DiffFile, DiffMode, DiffUpdatedEvent } from "@atrium/protocol";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GitError, type GitRunner } from "../platform/git";
import {
  BINARY_SNIFF_BYTES,
  addedFileHunks,
  countLines,
  isLikelyBinary,
  parseHunks,
  parseNameStatus,
  parseNumstat,
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

/** What a workspace's repository is and what it is compared with. */
interface RepoFacts {
  /** The repository's top, which paths are relative to. */
  readonly top: string;
  /** Whether HEAD has a commit. */
  readonly born: boolean;
  readonly branch: string | null;
  /** The ref compared with, such as `origin/main`. */
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
 * Finds a workspace's repository, branch and what to compare it with.
 *
 * @remarks
 * As Paseo (SPEC-0001, "工作区改动"): off the main branch, `origin/<main>` when it exists, else
 * the local `<main>`, else nothing; on the main branch, or without one, `origin/<branch>` when it
 * exists. The main branch is the project's own setting or where `origin/HEAD` points
 * (domain-model, "已决定 15"). A detached HEAD compares with nothing.
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
  if (!born || branch === null) return { top, born, branch, base: null, mergeBase: null };
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
  let base: string | null = null;
  if (main !== null && main !== branch) {
    if (await exists(`refs/remotes/origin/${main}`)) base = `origin/${main}`;
    else if (await exists(`refs/heads/${main}`)) base = main;
  } else if (await exists(`refs/remotes/origin/${branch}`)) {
    base = `origin/${branch}`;
  }
  const mergeBase =
    base === null ? null : ((await output(git, top, signal, "merge-base", "HEAD", base))?.trim() ?? null);
  return { top, born, branch, base, mergeBase };
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
  const listed = await output(git, top, signal, "ls-files", "--others", "--exclude-standard", "-z");
  return (listed ?? "").split("\0").filter((path) => path !== "");
}

/** What an untracked file holds, as far as the changes go. */
type Untracked =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "binary" | "too_large" | "other" };

/**
 * Reads an untracked file, without following a link or reading a large one.
 *
 * @remarks
 * Only regular files are read, at most `fileBytes`; a link is shown by where it points, never
 * through it (security.md, "子进程与文件"). The start decides whether it is binary.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @param fileBytes - The most to read.
 * @returns What it holds.
 */
async function readUntracked(path: string, fileBytes: number): Promise<Untracked> {
  const info = await lstat(path).catch(() => null);
  if (info === null) return { kind: "other" };
  if (info.isSymbolicLink()) return { kind: "link", target: await readlink(path) };
  if (!info.isFile()) return { kind: "other" };
  if (info.size > fileBytes) return { kind: "too_large" };
  const file = await open(path, "r");
  try {
    const start = Buffer.alloc(Math.min(info.size, BINARY_SNIFF_BYTES));
    await file.read(start, 0, start.length, 0);
    if (isLikelyBinary(start)) return { kind: "binary" };
  } finally {
    await file.close();
  }
  return { kind: "text", text: await readFile(path, "utf8") };
}

/**
 * A workspace's changes for the capsule above the input box.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"), as Paseo: the working tree against the merge base with what it is
 * compared with (`repoFacts`), plus the lines of the first 500 untracked files that are text, not
 * links and at most 1 MB. No changes, or nothing to compare with, shows nothing. `dirty` comes from
 * `git status`, untracked files included.
 *
 * @sideEffects Runs git; reads untracked files.
 * @param git - The runner.
 * @param dir - The workspace's directory.
 * @param mainBranch - The project's own main branch, if set.
 * @param signal - Stops git.
 * @returns The changes.
 * @throws {GitError} When git could not run.
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
  const status = await output(git, top, signal, "status", "--porcelain");
  const dirty = (status ?? "") !== "";
  if (mergeBase === null) return { stat: null, dirty, ahead: 0, branch, base: null };
  const tracked = parseShortstat((await output(git, top, signal, "diff", "--shortstat", mergeBase)) ?? "");
  let untracked = 0;
  for (const path of (await untrackedFiles(git, top, signal)).slice(0, UNTRACKED_COUNTED)) {
    const read = await readUntracked(join(top, path), LIMITS.fileBytes);
    if (read.kind === "text") untracked += countLines(read.text);
  }
  const ahead = Number((await output(git, top, signal, "rev-list", "--count", `${mergeBase}..HEAD`))?.trim() ?? 0);
  const added = tracked.added + untracked;
  const stat = added === 0 && tracked.removed === 0 ? null : { added, removed: tracked.removed };
  return { stat, dirty, ahead, branch, base: facts.base };
}

/**
 * The changes panel's files for a workspace.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"), as Paseo: "uncommitted" is HEAD against the working tree plus the
 * untracked files; "base" is the merge base against HEAD. One `git diff` gives every file's
 * patch, split in the order `--numstat` lists them, so a rename keeps both of its paths (Paseo
 * diffs a renamed file by its new path only). A file's patch over `fileBytes`, or every file once
 * the ones shown pass `totalBytes`, keeps its counts but no lines; untracked files past the limit
 * keep their place too (Paseo drops them). git printing past `patchBytes` makes the whole diff too
 * large.
 *
 * @sideEffects Runs git; reads untracked files.
 * @param git - The runner.
 * @param dir - The workspace's directory.
 * @param mainBranch - The project's own main branch, if set.
 * @param mode - What to compare.
 * @param signal - Stops git.
 * @param limits - How much to show.
 * @returns The files, by path.
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
    const numstat = parseNumstat((await output(git, top, signal, ...DIFF, "--numstat", "-z", ...refs)) ?? "");
    const statuses = parseNameStatus((await output(git, top, signal, ...DIFF, "--name-status", "-z", ...refs)) ?? "");
    let patch: string;
    try {
      const run = await git.run([...DIFF, ...refs], { cwd: top, signal, maxOutputBytes: limits.patchBytes });
      patch = run.code === 0 ? run.stdout : "";
    } catch (error) {
      if (error instanceof GitError && error.reason === "too_large") return { files: [], tooLarge: true, error: null };
      throw error;
    }
    const sections = splitPatch(patch);
    // The two runs agree unless the tree changed between them; then no file shows lines until the next look.
    const lined = sections.length === numstat.length;
    let shown = 0;
    const files: DiffFile[] = numstat.map((entry, at) => {
      const section = lined ? (sections[at] ?? "") : "";
      const size = Buffer.byteLength(section);
      const fits = lined && !entry.binary && size <= limits.fileBytes && shown + size <= limits.totalBytes;
      if (fits) shown += size;
      return {
        path: entry.path,
        oldPath: entry.oldPath,
        status: statuses.get(entry.path) ?? "modified",
        added: entry.added,
        removed: entry.removed,
        content: entry.binary ? "binary" : fits ? "text" : "too_large",
        hunks: fits ? parseHunks(section) : [],
      };
    });
    if (mode === "uncommitted") {
      for (const path of await untrackedFiles(git, top, signal)) {
        const read = await readUntracked(join(top, path), limits.fileBytes);
        if (read.kind === "other") continue;
        const text = read.kind === "text" ? read.text : read.kind === "link" ? read.target : "";
        const size = Buffer.byteLength(text);
        const fits = (read.kind === "text" || read.kind === "link") && shown + size <= limits.totalBytes;
        if (fits) shown += size;
        files.push({
          path,
          oldPath: null,
          status: "added",
          added: countLines(text),
          removed: 0,
          content: read.kind === "binary" ? "binary" : fits ? "text" : "too_large",
          hunks: fits ? addedFileHunks(text) : [],
        });
      }
    }
    return {
      files: files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      tooLarge: false,
      error: null,
    };
  } catch (error) {
    if (error instanceof GitError && error.reason === "aborted") throw error;
    if (error instanceof GitError) return { files: [], tooLarge: false, error: "failed" };
    throw error;
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
