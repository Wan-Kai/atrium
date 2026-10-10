import { absolutePathEntries } from "@atrium/pi";
import { spawn } from "node:child_process";
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
   * @param reason - `spawn` when git could not start or died by a signal, `timeout`, `aborted`,
   * `too_large` when it printed more than allowed, or `exit` when a caller needed it to succeed
   * and it exited with an error.
   */
  constructor(
    readonly command: string,
    readonly reason: "spawn" | "timeout" | "aborted" | "too_large" | "exit",
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
    options: {
      readonly cwd: string;
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs?: number;
      /** The most output to take; more fails the command as `too_large`. 16 MiB by default. */
      readonly maxOutputBytes?: number;
    },
  ): Promise<GitResult>;
}

/** How many git commands run at once (SPEC-0001, "worktree 合并状态"). */
export const GIT_CONCURRENCY = 4;

/** How long one git command may take by default. */
const GIT_TIMEOUT_MS = 30_000;

/** The most output kept from one command, unless the caller asks for another limit. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Creates the git runner.
 *
 * @remarks
 * At most `GIT_CONCURRENCY` commands run at once and the rest wait in order (SPEC-0001,
 * "worktree 合并状态"). Every command runs with the tool environment, so the git and the
 * credentials are the user's own, but PATH keeps only absolute directories, so a `git` placed in
 * a repository is never run (security.md, "子进程与文件"); and:
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
  const env = {
    ...options.env,
    PATH: absolutePathEntries(options.env["PATH"] ?? ""),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
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
        const ended = await runGit(args, runOptions.cwd, env, signal, runOptions.maxOutputBytes ?? MAX_OUTPUT_BYTES);
        if (signal.aborted) throw new GitError(command, timedOut ? "timeout" : "aborted");
        if (ended.tooLarge) throw new GitError(command, "too_large");
        if (ended.code === null) throw new GitError(command, "spawn");
        return { code: ended.code, stdout: ended.stdout };
      } finally {
        cancel();
        untrack();
        release();
      }
    },
  };
}

/**
 * Runs git in a process group of its own and waits until the whole group has ended.
 *
 * @remarks
 * git starts helpers of its own, such as ssh for a fetch or a credential helper; ending only git
 * would leave them running (security.md, "子进程与文件"). So git leads a new process group,
 * which is killed when the signal aborts and, once git exits, again for anything it left behind;
 * the run ends only when every holder of git's output has gone. Output past the limit kills git
 * and says so; a failure to start and death by a signal give no exit code.
 *
 * @sideEffects Spawns git; may kill its process group.
 * @param args - git's arguments.
 * @param cwd - Where to run it.
 * @param env - Its environment.
 * @param signal - Stops it.
 * @param maxOutputBytes - The most output to take.
 * @returns The exit code, or `null` when there is none, what git printed, and whether it printed
 * too much.
 */
function runGit(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
  maxOutputBytes: number,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly tooLarge: boolean }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      // Stryker disable next-line ObjectLiteral,BooleanLiteral,StringLiteral: the caller sees the signal aborted first.
      resolve({ code: null, stdout: "", tooLarge: false });
      return;
    }
    // stdin stays open and unused, as with `execFile`: no git command Atrium runs reads it.
    const child = spawn("git", [...args], { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    let tooLarge = false;
    /**
     * Kills git's whole process group.
     *
     * @remarks
     * A group already gone is fine.
     *
     * @sideEffects Sends SIGKILL to the group.
     */
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    /**
     * Ends git when the signal aborts.
     *
     * @remarks
     * A named listener, so it can be removed once git has ended.
     *
     * @sideEffects Kills git's process group.
     */
    const onAbort = (): void => killGroup();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) {
        // Stryker disable next-line BooleanLiteral: too large is checked before the exit code.
        failed = true;
        tooLarge = true;
        killGroup();
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("exit", () => killGroup());
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code: failed ? null : code, stdout: Buffer.concat(chunks).toString("utf8"), tooLarge });
    });
  });
}
