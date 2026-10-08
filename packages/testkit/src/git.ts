import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createTempDir } from "./temp-dir";

const run = promisify(execFile);

/**
 * The environment test repositories are built with.
 *
 * @remarks
 * The user's and the system's git configuration are left out, so hooks, signing or a different
 * default branch on the developer's machine cannot change a scene; authors and dates are fixed.
 */
export const GIT_SCENE_ENV: Readonly<Record<string, string>> = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Atrium Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Atrium Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: "2026-10-08T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-08T00:00:00Z",
};

/**
 * Runs git with the scenes' environment.
 *
 * @remarks
 * See `GIT_SCENE_ENV`.
 *
 * @sideEffects Runs git in `cwd`.
 * @param cwd - The directory.
 * @param args - git's arguments.
 * @returns Its output, trimmed.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env: GIT_SCENE_ENV })).stdout.trim();
}

/** A repository cloned from a bare `origin`, with helpers to change both. */
export interface GitScene {
  /** The directory holding everything; removed by `cleanup`. */
  readonly root: string;
  /** The clone, on `main`, with `origin/HEAD` pointing at `origin/main`. */
  readonly repo: string;
  /** The bare remote. */
  readonly origin: string;
  /** Runs git in a directory and returns what it printed, trimmed. */
  git(cwd: string, ...args: string[]): Promise<string>;
  /** Writes a file in a working tree and commits it; returns the new commit. */
  commit(cwd: string, file: string, content: string, message?: string): Promise<string>;
  /** Adds a worktree on a new branch started at `from` (default `main`); returns its directory. */
  worktree(branch: string, from?: string): Promise<string>;
  readonly cleanup: () => Promise<void>;
}

/**
 * Builds a repository with a remote to test worktrees and merge states against.
 *
 * @remarks
 * Real git, as testing.md asks ("能用真的就用真的"); the scenes cover merging, squashing,
 * rebasing and cherry-picking a worktree's branch into `main` (overview.md, testkit `git.ts`).
 *
 * @sideEffects Creates a temporary directory with a bare repository and a clone.
 * @param prefix - Readable prefix for the directory.
 * @returns The scene.
 */
export async function createGitScene(prefix: string): Promise<GitScene> {
  const dir = await createTempDir(prefix);
  const origin = join(dir.path, "origin.git");
  const repo = join(dir.path, "repo");

  /**
   * Writes and commits a file.
   *
   * @remarks
   * See `GitScene.commit`.
   *
   * @sideEffects Writes the file; commits.
   * @param cwd - The working tree.
   * @param file - The file, relative to it.
   * @param content - Its content.
   * @param message - The commit message.
   * @returns The new commit.
   */
  const commit = async (cwd: string, file: string, content: string, message = `change ${file}`): Promise<string> => {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), content);
    await git(cwd, "add", file);
    await git(cwd, "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };

  await git(dir.path, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  await git(dir.path, "clone", "--quiet", origin, repo);
  await git(repo, "checkout", "--quiet", "-B", "main");
  await commit(repo, "README.md", "start\n", "start");
  await git(repo, "push", "--quiet", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "main");

  return {
    root: dir.path,
    repo,
    origin,
    git,
    commit,
    async worktree(branch, from = "main") {
      const path = join(dir.path, `wt-${branch.replaceAll("/", "-")}`);
      await git(repo, "worktree", "add", "--quiet", "-b", branch, path, from);
      return path;
    },
    cleanup: dir.cleanup,
  };
}
