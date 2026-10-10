import { type SessionsLocation, sessionDirectories } from "@atrium/pi";
import type { DiscoveredDirectory } from "@atrium/protocol";
import { realpath, stat } from "node:fs/promises";

/**
 * Whether a path is a directory or inside it.
 *
 * @remarks
 * Compares whole path segments, so `/a/bc` is not inside `/a/b`.
 *
 * @sideEffects none
 * @param path - The path.
 * @param directory - The directory.
 * @returns Whether it is.
 */
function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/**
 * The real path of a directory, or `null` when it no longer exists or is not a directory.
 *
 * @remarks
 * See {@link discoverProjects}.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns The real path, or `null`.
 */
async function realDirectory(path: string): Promise<string | null> {
  const real = await realpath(path).catch(() => null);
  if (real === null) return null;
  const info = await stat(real).catch(() => null);
  return info?.isDirectory() === true ? real : null;
}

/**
 * The working directories of pi's past sessions that could become projects.
 *
 * @remarks
 * For first launch's third step (SPEC-0001, "首次启动 · 接口"). Each directory is its real path,
 * so two paths to one directory count as one. Left out: directories that no longer exist; those
 * that are, or are inside, a registered project or one of its workspaces, which `add_project`
 * refuses; and Atrium's own chats. Most recently used first, then by path.
 *
 * @sideEffects Reads pi's session files and the file system.
 * @param options - Where pi keeps sessions (`null` before the tools are found), the real paths of
 * the projects and workspaces, Atrium's chats directory, and a signal that stops the search.
 * @returns The directories.
 * @throws The signal's reason once it is aborted.
 */
export async function discoverProjects(options: {
  readonly location: SessionsLocation | null;
  readonly taken: readonly string[];
  readonly chatsRoot: string;
  readonly signal?: AbortSignal;
}): Promise<DiscoveredDirectory[]> {
  if (options.location === null) return [];
  const chats = (await realpath(options.chatsRoot).catch(() => null)) ?? options.chatsRoot;
  const found = new Map<string, DiscoveredDirectory>();
  for (const { cwd, sessions, lastUsedAt } of await sessionDirectories(options.location, options.signal)) {
    options.signal?.throwIfAborted();
    const path = await realDirectory(cwd);
    if (path === null || within(path, chats) || options.taken.some((taken) => within(path, taken))) continue;
    const before = found.get(path);
    found.set(path, {
      path,
      sessions: (before?.sessions ?? 0) + sessions,
      lastUsedAt: Math.max(before?.lastUsedAt ?? 0, lastUsedAt),
    });
  }
  return [...found.values()].toSorted(
    (one, other) => other.lastUsedAt - one.lastUsedAt || one.path.localeCompare(other.path),
  );
}
