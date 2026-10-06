import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { type ProcessSystem, killProcessTree } from "@atrium/pi";
import type { Clock } from "./clock";

/** The environment for tools such as pi, and where it came from. */
export type ToolEnv =
  | { readonly source: "login-shell"; readonly env: Readonly<Record<string, string>>; readonly shell: string }
  | {
      readonly source: "inherited";
      readonly env: Readonly<Record<string, string>>;
      /** Why the login shell was not used. */
      readonly reason: "no-shell" | "unsupported-shell" | "failed";
      readonly shell?: string;
    };

/** One failed attempt to read the environment, for the log. */
export interface ShellAttemptFailure {
  readonly args: readonly string[];
  readonly reason: "timeout" | "aborted" | "exit" | "no-marker" | "spawn";
  readonly code?: number | null;
}

/** Inputs for `readLoginShellEnv`. */
export interface LoginShellOptions {
  /** The user's shell, normally `$SHELL`. */
  readonly shell: string | undefined;
  /** The host's own environment: the shell starts from a few of its variables, and it is the fallback. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** Deadline per attempt. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called for each failed attempt, so the caller can log it. */
  readonly onFailure?: (failure: ShellAttemptFailure) => void;
  /** Process table and kill for the tree kill; tests make it fail to reach the fallback. */
  readonly processSystem?: ProcessSystem;
}

/** Shells whose `-i -l -c` and `printf` behave like the POSIX shell's. */
const POSIX_SHELLS: ReadonlySet<string> = new Set(["zsh", "bash", "sh", "dash", "ksh"]);
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The only host variables a login shell starts with, like a terminal started by launchd.
 *
 * @remarks
 * Anything else the host holds, notably `ATRIUM_TOKEN` when it runs standalone, would otherwise be
 * printed back by `env` and handed to pi (security.md, "WebSocket 与鉴权").
 */
const SHELL_START_VARIABLES = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "ZDOTDIR",
  "PATH",
  "__CF_USER_TEXT_ENCODING",
];

/** Variables that describe the shell process itself rather than the user's setup. */
const SHELL_OWN_VARIABLES: ReadonlySet<string> = new Set(["SHLVL", "_", "PWD", "OLDPWD"]);

/**
 * Copies an environment without Atrium's and Electron's own variables and without unset values.
 *
 * @remarks
 * Tools must never see the session token or Electron's switches such as `ELECTRON_RUN_AS_NODE`.
 *
 * @sideEffects none
 * @param env - Any environment.
 * @returns The variables tools may see.
 */
export function toolSafe(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("ATRIUM_") && !entry[0].startsWith("ELECTRON_"),
    ),
  );
}

/**
 * Parses `env -0` output: NUL-separated `NAME=value` entries.
 *
 * @remarks
 * NUL separators keep values with line breaks intact, which a line-based parse would split.
 *
 * @sideEffects none
 * @param output - The output between the markers.
 * @returns The variables, without the shell's own ones.
 */
function parseEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of output.split("\0")) {
    const equals = entry.indexOf("=");
    // Stryker disable next-line EqualityOperator: `env` never prints a variable without a name, so `=` is never first.
    if (equals > 0 && !SHELL_OWN_VARIABLES.has(entry.slice(0, equals))) {
      env[entry.slice(0, equals)] = entry.slice(equals + 1);
    }
  }
  return env;
}

/**
 * Runs one shell invocation and returns its stdout.
 *
 * @remarks
 * The shell gets no stdin, so an rc file that waits for input cannot hang it, and it leads its own
 * process group. The attempt is over as soon as the shell has exited and its output holds the
 * closing marker, without waiting for the pipe to close: an rc file that starts a background job
 * (`some-agent &`) leaves that job holding the pipe, and waiting for it would turn a good answer
 * into a timeout. A deadline or abort kills the shell's whole process tree (`killProcessTree`)
 * and stops listening at once, so a descendant that keeps the pipe open cannot keep the attempt,
 * or the host's shutdown, waiting.
 *
 * @sideEffects Spawns a shell; may kill its process tree.
 * @param shell - Absolute path of the shell.
 * @param args - Arguments, ending with the script.
 * @param options - Environment, clock, deadline, abort signal, and the marker that ends the output.
 * @returns Stdout when the shell exits with 0, or why it did not.
 */
function runShell(
  shell: string,
  args: readonly string[],
  options: Pick<LoginShellOptions, "env" | "clock" | "signal" | "processSystem"> & {
    readonly timeoutMs: number;
    readonly mark: string;
  },
): Promise<{ readonly stdout: string } | Omit<ShellAttemptFailure, "args">> {
  return new Promise((resolve) => {
    const child = spawn(shell, args, { env: options.env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    // Stryker disable next-line StringLiteral: anything before the first marker is discarded.
    let stdout = "";
    let exitCode: number | null | undefined;
    let closed = false;
    let settled = false;
    const listening = new AbortController();

    /**
     * Ends the attempt, once.
     *
     * @remarks
     * Destroying stdout lets go of a pipe that a background job may keep open.
     *
     * @sideEffects Cancels the deadline and abort listener; destroys stdout; resolves.
     * @param result - The outcome.
     */
    function settle(result: { readonly stdout: string } | Omit<ShellAttemptFailure, "args">): void {
      // Stryker disable next-line ConditionalExpression,BooleanLiteral: every step below is idempotent, and a promise settles once; the flag only saves work.
      if (settled) return;
      // Stryker disable next-line BooleanLiteral: see above.
      settled = true;
      cancelTimer();
      listening.abort();
      child.stdout.destroy();
      resolve(result);
    }

    /**
     * Settles once the shell has exited and its answer is complete.
     *
     * @remarks
     * A failed exit needs no output; a successful one needs the closing marker, or the pipe to close.
     *
     * @sideEffects May settle.
     */
    function check(): void {
      if (exitCode === undefined) return;
      if (exitCode !== 0) settle({ reason: "exit", code: exitCode });
      else if (closed || stdout.split(options.mark).length >= 3) settle({ stdout });
    }

    /**
     * Kills the shell and everything it started.
     *
     * @remarks
     * The whole tree, not only the group: an rc file may start jobs in other process groups.
     * Killing the group is the fallback if the process table cannot be read. The attempt ends once
     * the kill is done, so its end means the shell is gone.
     *
     * @sideEffects Sends SIGKILL to processes; then settles.
     * @param reason - Why the shell is being killed.
     */
    function killTree(reason: "timeout" | "aborted"): void {
      // Stryker disable next-line ConditionalExpression: settling cancels the deadline and the abort listener, the only callers.
      if (settled) return;
      const pid = child.pid;
      // Stryker disable next-line ConditionalExpression: a shell that never started has already settled through `error`.
      if (pid === undefined) return;
      // Fire and forget: the chain settles the attempt itself and cannot reject.
      void killProcessTree(pid, options.processSystem)
        .catch(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        })
        .finally(() => settle({ reason }));
    }

    const cancelTimer = options.clock.setTimeout(() => killTree("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", () => killTree("aborted"), { signal: listening.signal });
    // Stryker disable next-line StringLiteral: Node reads an empty encoding as UTF-8.
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      check();
    });
    child.once("error", () => settle({ reason: "spawn" }));
    child.once("exit", (code) => {
      exitCode = code;
      check();
    });
    child.once("close", () => {
      closed = true;
      check();
    });
  });
}

/**
 * Reads the environment of the user's login shell, falling back to the host's own.
 *
 * @remarks
 * Electron started from the Finder gets launchd's minimal environment, without Homebrew, nvm or
 * `~/.local/bin` on PATH, and without the API keys, proxies and `NODE_OPTIONS` people export in
 * their rc files, so pi would behave differently from the pi in their terminal (SPEC-0001,
 * "第 1 步：安装 pi"). The whole environment is taken, which costs no more than PATH alone: the time
 * is all in starting the shell. The shell runs interactive and login first, because many people set
 * things in `.zshrc`; if that fails or hangs, a login-only shell is tried. It starts from a short
 * list of the host's variables, never the token. `/usr/bin/env -0` prints the result between
 * random markers, so banners, prompts and echoed commands from rc files are ignored and values with
 * line breaks survive; Node is not involved, because inside Electron `process.execPath` is
 * Electron. Shells outside the POSIX family (fish, nu) keep the host's environment.
 *
 * @sideEffects Spawns up to two shells; may kill their process groups on a deadline.
 * @param options - Shell, host environment, clock, deadline, abort signal, failure callback and,
 * for tests, the process system.
 * @returns The environment for tools and where it came from.
 */
export async function readLoginShellEnv(options: LoginShellOptions): Promise<ToolEnv> {
  const inherited = toolSafe(options.env);
  const shell = options.shell;
  if (shell === undefined || shell === "") return { source: "inherited", env: inherited, reason: "no-shell" };
  if (!POSIX_SHELLS.has(basename(shell))) {
    return { source: "inherited", env: inherited, reason: "unsupported-shell", shell };
  }
  const startEnv = toolSafe(Object.fromEntries(SHELL_START_VARIABLES.map((name) => [name, options.env[name]])));
  // The marker is printed in two halves, so the script's own text never contains it: an rc file
  // that turns on command echoing (`set -x`, zsh's `verbose`) cannot fake a match.
  const head = "__ATRIUM_";
  const tail = `${randomBytes(6).toString("hex")}__`;
  const mark = head + tail;
  const script = `printf '%s%s' '${head}' '${tail}'; /usr/bin/env -0; printf '%s%s' '${head}' '${tail}'`;
  for (const flags of [
    ["-i", "-l", "-c"],
    ["-l", "-c"],
  ]) {
    if (options.signal?.aborted === true) break;
    const args = [...flags, script];
    const result = await runShell(shell, args, {
      ...options,
      env: startEnv,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      mark,
    });
    if (!("stdout" in result)) {
      options.onFailure?.({ args: flags, ...result });
      continue;
    }
    const printed = result.stdout.split(mark);
    if (printed.length < 3) {
      options.onFailure?.({ args: flags, reason: "no-marker" });
      continue;
    }
    // Stryker disable next-line StringLiteral: with three or more parts, `printed[1]` always exists.
    return { source: "login-shell", env: toolSafe(parseEnv(printed[1] ?? "")), shell };
  }
  return { source: "inherited", env: inherited, reason: "failed", shell };
}
