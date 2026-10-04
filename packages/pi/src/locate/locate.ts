import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { type Version, parseVersion } from "./version";

const run = promisify(execFile);

/**
 * Finds the `pi` executable on a search path.
 *
 * @remarks
 * The caller passes the PATH read from the user's login shell, because Electron started from the
 * Finder does not inherit it (SPEC-0001, "第 1 步：安装 pi").
 *
 * @sideEffects Checks file permissions on disk.
 * @param searchPath - A PATH-style list of directories.
 * @returns The absolute path of the first executable `pi`, or `null` if none is found.
 */
export async function findPi(searchPath: string): Promise<string | null> {
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, "pi");
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return null;
}

/**
 * Asks a pi executable for its version.
 *
 * @remarks
 * Uses `execFile` with an argument array so no shell is involved (security.md, "子进程与文件"),
 * and a timeout so a hung binary cannot block startup.
 *
 * @sideEffects Runs `pi --version` as a child process.
 * @param piPath - Absolute path of the pi executable.
 * @param options - Environment for the child (its PATH must reach Node) and an abort signal.
 * @returns The reported version, or `null` if the output has none.
 * @throws {Error} When the process cannot start, exits non-zero, times out or is aborted.
 */
export async function readPiVersion(
  piPath: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly signal?: AbortSignal },
): Promise<Version | null> {
  const { stdout } = await run(piPath, ["--version"], {
    env: options.env,
    timeout: 10_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return parseVersion(stdout);
}
