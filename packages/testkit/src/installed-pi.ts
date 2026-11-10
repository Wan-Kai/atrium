import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";

/** The folder cmux puts its command shims in, under the user's home. */
const CMUX_SHIM_FOLDER = `${sep}.cmuxterm${sep}cmux-cli-shims${sep}`;

/** What cmux's pi shim hands the command to; the real pi never names it. */
const CMUX_WRAPPER = "cmux-pi-wrapper";

/**
 * Whether a `pi` is cmux's shim rather than pi.
 *
 * @remarks
 * cmux puts its shim folder first on PATH in its terminals. The shim hands pi to cmux's wrapper,
 * which does not run from a test's environment: the host then reports pi as broken (testing.md,
 * "端到端测试找 pi"). It is told by its folder, or, copied elsewhere, by naming the wrapper in its
 * first kilobyte; the real pi's launcher is a short Node script that does not.
 *
 * @sideEffects Reads the start of the file.
 * @param candidate - The path of a runnable `pi`.
 * @returns Whether it is the shim.
 */
async function isCmuxShim(candidate: string): Promise<boolean> {
  if (candidate.includes(CMUX_SHIM_FOLDER)) return true;
  const file = await open(candidate, "r");
  try {
    const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(1024) });
    return buffer.subarray(0, bytesRead).toString("utf8").includes(CMUX_WRAPPER);
  } finally {
    await file.close();
  }
}

/**
 * Finds the pi that is installed, for tests that run the real pi.
 *
 * @remarks
 * The one lookup for tests that run the installed pi (end-to-end, host integration, soak and pi's
 * own contract tests), so they all pass over the same things: relative folders, which a shell
 * would read as the current one; a folder named `pi`; a file it cannot run; and cmux's shim
 * (`isCmuxShim`). The app itself finds pi with `findPi` on the login shell's PATH, which cmux's
 * terminals do not reach.
 *
 * @sideEffects Checks files on disk and reads the start of each runnable `pi`.
 * @param searchPath - A PATH-style list of folders; this process's PATH by default.
 * @returns The path of `pi`.
 * @throws {Error} When no pi is found.
 */
export async function installedPi(searchPath: string = process.env["PATH"] ?? ""): Promise<string> {
  for (const folder of searchPath.split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, "pi");
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile() && !(await isCmuxShim(candidate))) return candidate;
    } catch {
      // Not here, or not runnable; try the next folder.
    }
  }
  throw new Error("pi is not on PATH; tests that run the real pi need it installed");
}
