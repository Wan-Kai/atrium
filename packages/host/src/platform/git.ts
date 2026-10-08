import { execFile } from "node:child_process";
import type { Clock } from "./clock";
import type { ResourceTracker } from "./resources";

/** What one git command produced. */
interface GitResult {
  /** The exit code; 0 for success. */
  readonly code: number;
  readonly stdout: string;
}

/**
 * A git command that could not run to an exit code.
 *
 * @remarks
 * A non-zero exit is a result; this is git not starting, timing out or being stopped.
 *
 * @sideEffects none
 */
export class GitError extends Error {
  /**
   * Creates the error.
   *
   * @remarks
   * Carries why, for the log; git's own output is not kept, as it may name private paths and
   * remotes.
   *
   * @sideEffects none
   * @param command - The git subcommand.
   * @param reason - `spawn` when git could not start, `timeout`, or `aborted`.
   */
  constructor(
    readonly command: string,
    readonly reason: "spawn" | "timeout" | "aborted",
  ) {
    super(`git ${command} ${reason}`);
    this.name = "GitError";
  }
}

/** Runs git for the host's workspace scans. */
export interface GitRunner {
  /**
   * Runs one git command in a directory.
   *
   * @remarks
   * See `createGitRunner`.
   */
  run(
    args: readonly string[],
    options: { readonly cwd: string; readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number },
  ): Promise<GitResult>;
}

/** How many git commands run at once (SPEC-0001, "worktree 合并状态"). */
export const GIT_CONCURRENCY = 4;

/** How long one git command may take by default. */
const GIT_TIMEOUT_MS = 30_000;

/** The most output kept from one command. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Creates the git runner.
 *
 * @remarks
 * At most `GIT_CONCURRENCY` commands run at once and the rest wait in order (SPEC-0001,
 * "worktree 合并状态"). Every command runs with the tool environment, so the git and the
 * credentials are the user's own, plus:
 * - `GIT_OPTIONAL_LOCKS=0`, so a background `git status` never takes the index lock from under
 *   the user's own git commands;
 * - `GIT_TERMINAL_PROMPT=0`, so a fetch that needs a password fails instead of waiting for input;
 * - `LC_ALL=C`, so output does not depend on the user's language.
 *
 * A non-zero exit is a result, not an error: callers read meaning from codes such as
 * `merge-base --is-ancestor`'s 1. The deadline runs on the injected clock.
 *
 * @sideEffects none until `run`; then spawns git, counted as a `git.process` resource while it runs.
 * @param options - The tool environment, clock and resource tracker.
 * @returns The runner.
 */
export function createGitRunner(options: {
  readonly env: Readonly<Record<string, string>>;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
}): GitRunner {
  const env = { ...options.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const waiting: (() => void)[] = [];
  let running = 0;

  /**
   * Waits for a free slot.
   *
   * @remarks
   * See `GIT_CONCURRENCY`.
   *
   * @sideEffects Takes a slot, possibly after queueing.
   */
  async function acquire(): Promise<void> {
    if (running < GIT_CONCURRENCY) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  /**
   * Frees a slot, handing it to the next waiting command if any.
   *
   * @remarks
   * The slot passes on directly, so the count stays right.
   *
   * @sideEffects Starts the next waiting command or frees the slot.
   */
  function release(): void {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  }

  return {
    async run(args, runOptions) {
      await acquire();
      const untrack = options.resources.acquire("git.process");
      const deadline = new AbortController();
      let timedOut = false;
      const cancel = options.clock.setTimeout(() => {
        timedOut = true;
        deadline.abort();
      }, runOptions.timeoutMs ?? GIT_TIMEOUT_MS);
      const signal =
        runOptions.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, runOptions.signal]);
      const command = args[0] ?? "";
      try {
        return await new Promise<GitResult>((resolve, reject) => {
          execFile(
            "git",
            [...args],
            { cwd: runOptions.cwd, env, signal, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
            (error, stdout) => {
              if (error === null) {
                resolve({ code: 0, stdout });
              } else if (signal.aborted) {
                reject(new GitError(command, timedOut ? "timeout" : "aborted"));
              } else if (typeof error.code === "number") {
                resolve({ code: error.code, stdout });
              } else {
                reject(new GitError(command, "spawn"));
              }
            },
          );
        });
      } finally {
        cancel();
        untrack();
        release();
      }
    },
  };
}
