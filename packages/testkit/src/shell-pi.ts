import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { sharedExecutable, warmExecutable } from "./shared-executable";

/** Environment variable carrying the shell script body the stand-in runs. */
const BODY_ENV = "SHELL_PI_BODY";

/** The shared shell script every `writeShellPi` links to. */
const SHELL_PI = `#!/bin/sh\neval "$${BODY_ENV}"\n`;

/**
 * Writes and runs the shared shell pi once, before tests start.
 *
 * @remarks
 * See `sharedExecutable`: the first run of a new executable is the slow one.
 *
 * @sideEffects Writes the shared script if missing; runs it.
 */
export async function warmShellPi(): Promise<void> {
  await warmExecutable(await sharedExecutable("shell-pi", SHELL_PI), [], { [BODY_ENV]: "true" });
}

/**
 * Puts a `pi` in `dir` that runs `body` as a shell script.
 *
 * @remarks
 * For tests about finding and checking pi, where pi only needs to print a version, fail or exit.
 * Every test links to one shared `/bin/sh` script that evaluates the body from the environment, so
 * no test waits for macOS to check a new executable (see `sharedExecutable`). The caller must
 * pass `env` on to the process that runs pi.
 *
 * @sideEffects Creates a symlink in `dir`; writes the shared script on first use.
 * @param dir - A temporary directory owned by the test.
 * @param body - Shell commands, such as `echo 1.0.2`.
 * @returns The path of `pi` and the environment that carries the body.
 */
export async function writeShellPi(
  dir: string,
  body: string,
): Promise<{ readonly piPath: string; readonly env: Readonly<Record<string, string>> }> {
  const piPath = join(dir, "pi");
  await symlink(await sharedExecutable("shell-pi", SHELL_PI), piPath);
  return { piPath, env: { [BODY_ENV]: body } };
}
