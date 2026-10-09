import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A path with a leading `~` resolved against a home directory.
 *
 * @remarks
 * pi accepts `~` in its directory variables (pi 1.0.2, `config.js` `expandTildePath`).
 *
 * @sideEffects none
 * @param path - The path.
 * @param home - The home directory.
 * @returns The path, `~` resolved.
 */
export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * Where pi keeps its settings, sessions and tools.
 *
 * @remarks
 * `PI_CODING_AGENT_DIR`, by default `~/.pi/agent` (pi-internals.md §1).
 *
 * @sideEffects none
 * @param env - pi's environment.
 * @returns The directory.
 */
export function agentDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const home = env["HOME"] ?? homedir();
  const fromEnv = env["PI_CODING_AGENT_DIR"];
  return fromEnv === undefined || fromEnv === "" ? join(home, ".pi", "agent") : expandTilde(fromEnv, home);
}
