import { findExecutable } from "@atrium/pi";
import { dirname } from "node:path";

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

/**
 * The tool environment with Homebrew's directory at the end of PATH, when it was found elsewhere.
 *
 * @remarks
 * A fresh Homebrew outside PATH installs Node next to itself, where nothing would find it; with its
 * directory on PATH, Node is found once installed and the install of pi that follows runs on it
 * (SPEC-0001, "第 1 步：安装 pi"). At the end, so what the user's PATH finds first still wins.
 *
 * @sideEffects none
 * @param env - The tool environment.
 * @param brew - The `brew` found, or `null`.
 * @returns The environment, changed only when `brew` is outside its PATH.
 */
export function withHomebrewOnPath(
  env: Readonly<Record<string, string>>,
  brew: string | null,
): Readonly<Record<string, string>> {
  if (brew === null) return env;
  const dir = dirname(brew);
  const path = env["PATH"] ?? "";
  if (path.split(":").includes(dir)) return env;
  return { ...env, PATH: path === "" ? dir : `${path}:${dir}` };
}
