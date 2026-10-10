import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createTempDir } from "./temp-dir";

const run = promisify(execFile);

/**
 * The environment test repositories are built with, for temporary folders under `root`.
 *
 * @remarks
 * The user's and the system's git configuration are left out, so hooks, signing or a different
 * default branch on the developer's machine cannot change a scene; authors and dates are fixed.
 *
 * git never looks for a repository at or above `root` (`GIT_CEILING_DIRECTORIES`). Mutation testing
 * keeps temporary folders inside Atrium's own checkout; a test that timed out has its scene
 * removed by its cleanup while its body still runs git there, and git would then work on the
 * checkout itself: it once switched its branch and created branches and worktrees in it, and the
 * scene's next step pushes (testing.md, "临时文件"). Both the path and its real path are given,
 * since macOS reaches the temporary folder through a link.
 *
 * @sideEffects none
 * @param root - The folder temporary folders are made in.
 * @returns The environment.
 */
export function gitSceneEnv(root: string): Readonly<Record<string, string>> {
  return {
    GIT_CEILING_DIRECTORIES: [...new Set([root, realpathSync(root)])].join(":"),
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
}

/** The environment test repositories are built with; see `gitSceneEnv`. */
export const GIT_SCENE_ENV = gitSceneEnv(tmpdir());

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
async function commit(cwd: string, file: string, content: string, message = `change ${file}`): Promise<string> {
  await mkdir(dirname(join(cwd, file)), { recursive: true });
  await writeFile(join(cwd, file), content);
  await git(cwd, "add", file);
  await git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** The first scene of this process, which every scene is copied from; see `sceneTemplate`. */
let template: Promise<string> | undefined;

/**
 * The directory holding a scene's `origin.git` and `repo`, built once a process.
 *
 * @remarks
 * Building a scene runs six git commands, about a second; copying one takes tens of milliseconds
 * (testing.md, "临时文件"). It lives in the temporary folder, which each test run removes; it is
 * also removed when the process exits, for processes outside a test run.
 *
 * @sideEffects Builds the template once; registers its removal at exit.
 * @returns The template's directory.
 */
function sceneTemplate(): Promise<string> {
  template ??= (async () => {
    const dir = await createTempDir("git-template");
    process.once("exit", () => rmSync(dir.path, { recursive: true, force: true }));
    const origin = join(dir.path, "origin.git");
    const repo = join(dir.path, "repo");
    // No template: git's sample hooks would only be more files to copy for every scene.
    await git(dir.path, "init", "--quiet", "--bare", "--template=", "--initial-branch=main", origin);
    await git(dir.path, "clone", "--quiet", "--template=", origin, repo);
    await git(repo, "checkout", "--quiet", "-B", "main");
    await commit(repo, "README.md", "start\n", "start");
    await git(repo, "push", "--quiet", "-u", "origin", "main");
    await git(repo, "remote", "set-head", "origin", "main");
    return dir.path;
  })();
  return template;
}

/**
 * Builds a repository with a remote to test worktrees and merge states against.
 *
 * @remarks
 * Real git, as testing.md asks ("能用真的就用真的"); the scenes cover merging, squashing,
 * rebasing and cherry-picking a worktree's branch into `main` (overview.md, testkit `git.ts`).
 * Each scene is a copy of the process's template (`sceneTemplate`) whose clone points at its own
 * copy of the remote, so scenes never share a repository.
 *
 * @sideEffects Creates a temporary directory with a bare repository and a clone.
 * @param prefix - Readable prefix for the directory.
 * @returns The scene.
 */
export async function createGitScene(prefix: string): Promise<GitScene> {
  const source = await sceneTemplate();
  const dir = await createTempDir(prefix);
  const origin = join(dir.path, "origin.git");
  const repo = join(dir.path, "repo");
  await cp(source, dir.path, { recursive: true });
  await git(repo, "remote", "set-url", "origin", origin);

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
