import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { piEnvironment } from "../env/pi-env";
import { type Version, parseVersion } from "./version";

const run = promisify(execFile);

/**
 * Finds an executable on a search path.
 *
 * @remarks
 * The caller passes the PATH read from the user's login shell, because Electron started from the
 * Finder does not inherit it (SPEC-0001, "第 1 步：安装 pi"). Relative entries, including the empty
 * entry that POSIX reads as the current directory, are skipped: the host must never run a program
 * from whatever directory it happens to be in. Like a shell, it skips a directory with the name,
 * which passes the execute check too.
 *
 * @sideEffects Checks file permissions on disk.
 * @param searchPath - A PATH-style list of directories.
 * @param name - The executable's name, such as `node`.
 * @returns The absolute path of the first executable found, or `null` if none is found.
 */
export async function findExecutable(searchPath: string, name: string): Promise<string | null> {
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not here, or not executable; try the next directory.
    }
  }
  return null;
}

/**
 * Finds the `pi` executable on a search path.
 *
 * @remarks
 * See {@link findExecutable}.
 *
 * @sideEffects Checks file permissions on disk.
 * @param searchPath - A PATH-style list of directories.
 * @returns The absolute path of the first executable `pi`, or `null` if none is found.
 */
export async function findPi(searchPath: string): Promise<string | null> {
  return findExecutable(searchPath, "pi");
}

/**
 * Asks a pi executable for its version.
 *
 * @remarks
 * Uses `execFile` with an argument array so no shell is involved (security.md, "子进程与文件").
 * The environment goes through `piEnvironment`, so a relative PATH entry cannot pick the `node`
 * pi's launcher runs. Aborting kills with SIGKILL and the promise settles only once pi has exited,
 * so a pi that ignores SIGTERM can neither keep the caller waiting nor outlive the check; the
 * caller sets the deadline through the signal.
 *
 * @sideEffects Runs `pi --version` as a child process; kills it if the signal aborts.
 * @param piPath - Absolute path of the pi executable.
 * @param options - Environment for the child (its PATH must reach Node) and an abort signal.
 * @returns The reported version, or `null` if the output has none.
 * @throws {Error} When the process cannot start, exits non-zero or is aborted.
 */
export async function readPiVersion(
  piPath: string,
  options: { readonly env: Readonly<Record<string, string | undefined>>; readonly signal?: AbortSignal },
): Promise<Version | null> {
  // Not `execFile`'s own `signal` option: on abort it sends SIGTERM whatever `killSignal` says.
  const running = run(piPath, ["--version"], { env: piEnvironment(options.env) });
  /**
   * Kills `pi --version` outright.
   *
   * @remarks
   * SIGKILL, because a hung pi may ignore SIGTERM.
   *
   * @sideEffects Sends SIGKILL to the child.
   */
  function kill(): void {
    running.child.kill("SIGKILL");
  }
  // Stryker disable next-line ObjectLiteral,BooleanLiteral: the listener is removed below either way, and a signal aborts once.
  options.signal?.addEventListener("abort", kill, { once: true });
  if (options.signal?.aborted === true) kill();
  try {
    return parseVersion((await running).stdout);
  } finally {
    options.signal?.removeEventListener("abort", kill);
  }
}
