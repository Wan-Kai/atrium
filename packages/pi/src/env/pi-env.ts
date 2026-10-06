import { delimiter, isAbsolute } from "node:path";

/**
 * Removes relative entries, including empty ones, from a PATH-style list.
 *
 * @remarks
 * pi's launcher starts with `#!/usr/bin/env node`, so the system looks `node` up on PATH. A
 * relative entry such as `.` or an empty one (which POSIX reads as the current directory) would
 * let a `node` placed in the workspace run instead, with the user's credentials (security.md,
 * "子进程与文件"). The cost is that pi's bash tool no longer finds commands in the current
 * directory by bare name, which a terminal with `.` on PATH would; putting `.` on PATH is unsafe
 * to begin with.
 *
 * @sideEffects none
 * @param path - A PATH value.
 * @returns The same list with only absolute directories.
 */
export function absolutePathEntries(path: string): string {
  return path
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
}

/**
 * Builds the environment pi runs with from the tool environment and any extra variables.
 *
 * @remarks
 * Every way of running pi (the version check and the RPC process) goes through this, so none can
 * pass Atrium's or Electron's own variables (the session token, `ELECTRON_RUN_AS_NODE`) or a
 * relative PATH entry, whatever a caller hands in (security.md, "子进程与文件").
 *
 * @sideEffects none
 * @param env - The tool environment and extras, later ones winning.
 * @returns The environment for pi.
 */
export function piEnvironment(...env: readonly Readonly<Record<string, string | undefined>>[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const part of env) {
    for (const [name, value] of Object.entries(part)) {
      if (value !== undefined && !name.startsWith("ATRIUM_") && !name.startsWith("ELECTRON_")) merged[name] = value;
    }
  }
  if (merged["PATH"] !== undefined) merged["PATH"] = absolutePathEntries(merged["PATH"]);
  return merged;
}
