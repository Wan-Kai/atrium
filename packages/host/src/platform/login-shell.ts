import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { Clock } from "./clock";

/** Where the PATH for tools came from. */
export type ToolPath =
  | { readonly source: "login-shell"; readonly path: string; readonly shell: string }
  | {
      readonly source: "inherited";
      readonly path: string;
      /** Why the login shell was not used. */
      readonly reason: "no-shell" | "unsupported-shell" | "failed";
      readonly shell?: string;
    };

/** One failed attempt to read PATH, for the log. */
export interface ShellAttemptFailure {
  readonly args: readonly string[];
  readonly reason: "timeout" | "aborted" | "exit" | "no-marker" | "spawn";
  readonly code?: number | null;
}

/** Inputs for `readLoginShellPath`. */
export interface LoginShellOptions {
  /** The user's shell, normally `$SHELL`. */
  readonly shell: string | undefined;
  /** Environment the shell starts with; its PATH is the fallback. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** Deadline per attempt. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called for each failed attempt, so the caller can log it. */
  readonly onFailure?: (failure: ShellAttemptFailure) => void;
}

/** Shells whose `-i -l -c` and `printf` behave like the POSIX shell's. */
const POSIX_SHELLS: ReadonlySet<string> = new Set(["zsh", "bash", "sh", "dash", "ksh"]);
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Runs one shell invocation and returns its stdout.
 *
 * @remarks
 * The shell gets no stdin, so an rc file that waits for input cannot hang it, and it leads its own
 * process group, so a deadline kills whatever the rc file started too (a shell that `exec`s tmux,
 * an agent that daemonizes).
 *
 * @sideEffects Spawns a shell; may kill its process group.
 * @param shell - Absolute path of the shell.
 * @param args - Arguments, ending with the script.
 * @param options - Environment, clock, deadline and abort signal.
 * @returns Stdout when the shell exits with 0, or why it did not.
 */
function runShell(
  shell: string,
  args: readonly string[],
  options: Pick<LoginShellOptions, "env" | "clock" | "signal"> & { readonly timeoutMs: number },
): Promise<{ readonly stdout: string } | Omit<ShellAttemptFailure, "args">> {
  return new Promise((resolve) => {
    const child = spawn(shell, args, { env: options.env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let stdout = "";
    let killedFor: "timeout" | "aborted" | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));

    /**
     * Kills the shell and everything in its process group.
     *
     * @remarks
     * Interactive rc files may leave children behind; they share the shell's group.
     *
     * @sideEffects Sends SIGKILL to a process group.
     * @param reason - Why the shell is being killed.
     */
    function killGroup(reason: "timeout" | "aborted"): void {
      killedFor ??= reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    const cancelTimer = options.clock.setTimeout(() => killGroup("timeout"), options.timeoutMs);
    const settled = new AbortController();
    options.signal?.addEventListener("abort", () => killGroup("aborted"), { signal: settled.signal });
    child.once("error", () => {
      cancelTimer();
      settled.abort();
      resolve({ reason: "spawn" });
    });
    child.once("close", (code) => {
      cancelTimer();
      settled.abort();
      if (killedFor !== undefined) resolve({ reason: killedFor });
      else if (code !== 0) resolve({ reason: "exit", code });
      else resolve({ stdout });
    });
  });
}

/**
 * Reads PATH from the user's login shell, falling back to the inherited one.
 *
 * @remarks
 * Electron started from the Finder gets launchd's minimal PATH, without Homebrew, nvm or
 * `~/.local/bin`, so pi and the node it needs would not be found (SPEC-0001, "第 1 步：安装 pi").
 * Only PATH is taken, as the docs specify. The shell runs interactive and login first, because many
 * people set PATH in `.zshrc`; if that fails or hangs, a login-only shell is tried. The value is
 * printed by the shell's own `printf` between random markers, so banners, prompts and echoed
 * commands from rc files are ignored; Node is not involved, because inside Electron `process.execPath` is Electron.
 * Shells outside the POSIX family (fish, nu) keep the inherited PATH.
 *
 * @sideEffects Spawns up to two shells; may kill their process groups on a deadline.
 * @param options - Shell, environment, clock, deadline, abort signal and failure callback.
 * @returns The PATH to use for tools and where it came from.
 */
export async function readLoginShellPath(options: LoginShellOptions): Promise<ToolPath> {
  const inherited = options.env["PATH"] ?? "";
  const shell = options.shell;
  if (shell === undefined || shell === "") return { source: "inherited", path: inherited, reason: "no-shell" };
  if (!POSIX_SHELLS.has(basename(shell))) {
    return { source: "inherited", path: inherited, reason: "unsupported-shell", shell };
  }
  // The marker is printed in two halves, so the script's own text never contains it: an rc file
  // that turns on command echoing (`set -x`, zsh's `verbose`) cannot fake a match.
  const head = "__ATRIUM_";
  const tail = `${randomBytes(6).toString("hex")}__`;
  const mark = head + tail;
  const script = `printf '%s%s%s%s%s' '${head}' '${tail}' "$PATH" '${head}' '${tail}'`;
  for (const flags of [
    ["-i", "-l", "-c"],
    ["-l", "-c"],
  ]) {
    if (options.signal?.aborted === true) break;
    const args = [...flags, script];
    const result = await runShell(shell, args, { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (!("stdout" in result)) {
      options.onFailure?.({ args: flags, ...result });
      continue;
    }
    const path = result.stdout.split(mark)[1];
    if (path === undefined || path === "") {
      options.onFailure?.({ args: flags, reason: "no-marker" });
      continue;
    }
    return { source: "login-shell", path, shell };
  }
  return { source: "inherited", path: inherited, reason: "failed", shell };
}
