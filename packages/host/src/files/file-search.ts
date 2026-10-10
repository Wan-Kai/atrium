import { CommandError, type FileCandidate } from "@atrium/protocol";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { Readable } from "node:stream";
import type { Clock } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";
import { type FdEntry, fdArguments, parseFdOutput, rankEntries, scopeOf } from "./fd-query";

/** Finds files for `@` in a working directory. */
export interface FileSearch {
  /** The best candidates for a query, at most 20; none when called off or out of time. */
  search(cwd: string, query: string, signal: AbortSignal): Promise<FileCandidate[]>;
}

/** How long one search may take (SPEC-0001, "模型与输入框"). */
const SEARCH_TIMEOUT_MS = 5_000;
/** The most output kept from one `fd` run; 100 paths fit easily. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Creates the file search behind `@`.
 *
 * @remarks
 * As pi's terminal searches (SPEC-0001, "模型与输入框"): `fd` lists the directory's own entries,
 * then everything below it, each at most 100; the two lists merge without repeats and are ranked
 * by `rankEntries`. A query naming a directory searches inside it, never outside the working
 * directory. `fd` keeps to `.gitignore` in a git repository and to `.ignore` and `.fdignore`
 * anywhere, so repositories and plain folders take the same path. The query goes to `fd` as an
 * argument, never through a shell (security.md, "子进程与文件"). A search called off or past five
 * seconds stops `fd` and finds nothing.
 *
 * @sideEffects none until `search`; then runs `fd`, counted as an `fd.process` resource while it runs.
 * @param options - How to find `fd`, the clock for the deadline, and the resource tracker.
 * @returns The search.
 */
export function createFileSearch(options: {
  readonly findFd: () => Promise<string | null>;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
}): FileSearch {
  return {
    async search(cwd, query, signal) {
      const fd = await options.findFd();
      if (fd === null) throw new CommandError("fd_missing");
      const scope = scopeOf(cwd, query, isDirectory);
      if (scope === "outside") return [];
      const baseDir = scope?.baseDir ?? cwd;
      const wanted = scope?.query ?? query;
      const deadline = new AbortController();
      const cancel = options.clock.setTimeout(() => deadline.abort(), SEARCH_TIMEOUT_MS);
      const stop = AbortSignal.any([signal, deadline.signal]);
      try {
        const own = parseFdOutput(await runFd(fd, fdArguments(baseDir, wanted, 1), stop, options.resources));
        const below = parseFdOutput(await runFd(fd, fdArguments(baseDir, wanted, null), stop, options.resources));
        if (stop.aborted) return [];
        const seen = new Set(own.map((entry) => entry.path));
        const merged: FdEntry[] = [...own, ...below.filter((entry) => !seen.has(entry.path) && seen.add(entry.path))];
        const shownBase = scope?.shownBase ?? "";
        return rankEntries(merged, wanted).map((entry) => ({
          path: `${shownBase}${entry.path}`,
          directory: entry.isDirectory,
        }));
      } finally {
        cancel();
      }
    },
  };
}

/**
 * Whether a path is a directory.
 *
 * @remarks
 * For a query naming a directory; one that does not exist is searched for as text instead.
 *
 * @sideEffects Checks the path on disk.
 * @param path - The path.
 * @returns Whether it is a directory.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
    // Stryker disable next-line BlockStatement: without it the function gives undefined, which counts as false too.
  } catch {
    return false;
  }
}

/**
 * Runs `fd` and collects what it prints.
 *
 * @remarks
 * Killed at once when the signal aborts. A failed or killed run, one printing past
 * `MAX_OUTPUT_BYTES`, or one Node will not start (an argument holding a NUL), gives nothing, as in
 * pi's terminal.
 *
 * @sideEffects Spawns `fd`, counted as an `fd.process` resource; may kill it.
 * @param fd - The executable.
 * @param args - Its arguments.
 * @param signal - Stops it.
 * @param resources - Counts the process.
 * @returns What it printed, or `""`.
 */
function runFd(fd: string, args: readonly string[], signal: AbortSignal, resources: ResourceTracker): Promise<string> {
  // Stryker disable next-line StringLiteral: a search called off finds nothing whatever fd gave.
  if (signal.aborted) return Promise.resolve("");
  return new Promise((resolve) => {
    const release = resources.acquire("fd.process");
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn(fd, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Node refuses some arguments outright, such as one holding a NUL; fd never starts.
      release();
      // Stryker disable next-line StringLiteral: such a query, NUL and all, matches no path anyway.
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    /**
     * Kills `fd` when the search is called off.
     *
     * @remarks
     * `fd` starts nothing of its own, so the process is enough; killed, it exits without a code.
     *
     * @sideEffects Sends SIGKILL.
     */
    const kill = (): void => {
      child.kill("SIGKILL");
    };
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: the listener comes off once fd ends anyway.
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Stryker disable next-line EqualityOperator: one byte past a mebibyte of paths decides nothing.
      if (size > MAX_OUTPUT_BYTES) kill();
      else chunks.push(chunk);
    });
    // A failure to start ends in `close` with a non-zero code too; without a listener the error
    // event would crash the host.
    // Stryker disable next-line BlockStatement,StringLiteral: see above; `close` decides.
    child.on("error", () => undefined);
    child.on("close", (code) => {
      // Stryker disable next-line StringLiteral,CallExpression: only frees the listener; fd has ended.
      signal.removeEventListener("abort", kill);
      release();
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : "");
    });
  });
}
