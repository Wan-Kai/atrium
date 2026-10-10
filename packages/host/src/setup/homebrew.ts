import { findExecutable } from "@atrium/pi";

/** Where Homebrew installs itself: Apple silicon, then Intel. */
const HOMEBREW_PLACES = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Finds Homebrew, which installs Node on first launch.
 *
 * @remarks
 * PATH first, then the places Homebrew's installer uses: a fresh install only adds itself to PATH
 * when the user runs the commands it prints, and `brew` works from its place all the same
 * (SPEC-0001, "第 1 步：安装 pi").
 *
 * @sideEffects Checks files on disk.
 * @param searchPath - PATH-style directory list, normally from the login shell.
 * @param places - Directories to try after PATH; tests replace them.
 * @returns The absolute path of `brew`, or `null`.
 */
export async function findHomebrew(
  searchPath: string,
  places: readonly string[] = HOMEBREW_PLACES,
): Promise<string | null> {
  return findExecutable([searchPath, ...places].join(":"), "brew");
}
