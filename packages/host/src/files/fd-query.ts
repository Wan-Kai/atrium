import { basename, isAbsolute, join, relative, sep } from "node:path";

/** An entry `fd` printed, relative to where it searched. */
export interface FdEntry {
  /** The path, a directory's ending in `/`. */
  readonly path: string;
  readonly isDirectory: boolean;
}

/** How many entries one `fd` run returns (pi's terminal: 100). */
const MAX_RESULTS = 100;
/** How many candidates `@` shows (pi's terminal: 20). */
const SHOWN = 20;

/**
 * How well an entry matches what was typed after `@`.
 *
 * @remarks
 * pi's terminal's scoring (`packages/tui/src/autocomplete.ts`): the file name equal to the query
 * 100, starting with it 80, containing it 50, the path containing it 30, all without case; a
 * matching directory 10 more. An empty query matches everything alike.
 *
 * @sideEffects none
 * @param path - The entry's path.
 * @param query - The query.
 * @param isDirectory - Whether the entry is a directory.
 * @returns The score; 0 for no match.
 */
export function scoreEntry(path: string, query: string, isDirectory: boolean): number {
  if (query === "") return 1;
  const name = basename(path).toLowerCase();
  const wanted = query.toLowerCase();
  let score = 0;
  if (name === wanted) score = 100;
  else if (name.startsWith(wanted)) score = 80;
  else if (name.includes(wanted)) score = 50;
  else if (path.toLowerCase().includes(wanted)) score = 30;
  return isDirectory && score > 0 ? score + 10 : score;
}

/**
 * How many segments a path has.
 *
 * @remarks
 * Shallower entries rank first among equals.
 *
 * @sideEffects none
 * @param path - The path.
 * @returns The count.
 */
function depth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/**
 * The entries that match, best first, at most `SHOWN`.
 *
 * @remarks
 * pi's terminal's order: score, then fewer path segments, then a shorter path, then by name.
 *
 * @sideEffects none
 * @param entries - What `fd` found.
 * @param query - The query.
 * @returns The ranked entries.
 */
export function rankEntries(entries: readonly FdEntry[], query: string): FdEntry[] {
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry.path, query, entry.isDirectory) }))
    .filter(({ score }) => score > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        depth(a.entry.path) - depth(b.entry.path) ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path),
    )
    .slice(0, SHOWN)
    .map(({ entry }) => entry);
}

/** Where a query with a directory in it searches. */
export interface FdScope {
  /** The directory to search. */
  readonly baseDir: string;
  /** What to look for in it: the query after its last `/`. */
  readonly query: string;
  /** The query's directory part, put back in front of the paths found. */
  readonly shownBase: string;
}

/**
 * Where a query that names a directory searches.
 *
 * @remarks
 * As in pi's terminal, `src/se` looks for `se` inside `src/`, when that directory exists. Unlike
 * it, only inside the working directory: `~/`, absolute paths and `..` out of it find nothing
 * (SPEC-0001, "模型与输入框").
 *
 * @sideEffects Calls `isDirectory`.
 * @param cwd - The session's working directory.
 * @param query - The query.
 * @param isDirectory - Whether a path is a directory.
 * @returns The scope, `null` for a query to search as it is, or `outside` for one leaving `cwd`.
 */
export function scopeOf(
  cwd: string,
  query: string,
  isDirectory: (path: string) => boolean,
): FdScope | null | "outside" {
  if (query.startsWith("~") || isAbsolute(query)) return "outside";
  const slash = query.lastIndexOf("/");
  if (slash === -1) return null;
  const shownBase = query.slice(0, slash + 1);
  const baseDir = join(cwd, query.slice(0, slash));
  const inside = relative(cwd, baseDir);
  if (inside === ".." || inside.startsWith(`..${sep}`)) return "outside";
  return isDirectory(baseDir) ? { baseDir, query: query.slice(slash + 1), shownBase } : null;
}

/**
 * The arguments of one `fd` run.
 *
 * @remarks
 * pi's terminal's: files and directories, following links, hidden ones included, `.git` left
 * out, at most 100; a query with a slash matched against the whole path. Unlike pi, the query is
 * matched literally (`--fixed-strings`), so a `+` or `(` in a name finds it instead of failing as
 * a pattern. `fd` matches without case unless the query has capitals.
 *
 * @sideEffects none
 * @param baseDir - Where to search.
 * @param query - What to look for; empty for everything.
 * @param maxDepth - How deep, or `null` for all the way.
 * @returns The arguments.
 */
export function fdArguments(baseDir: string, query: string, maxDepth: number | null): string[] {
  const args = [
    "--base-directory",
    baseDir,
    "--max-results",
    String(MAX_RESULTS),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];
  if (maxDepth !== null) args.push("--max-depth", String(maxDepth));
  if (query.includes("/")) args.push("--full-path");
  if (query !== "") args.push("--fixed-strings", query);
  return args;
}

/**
 * The entries `fd` printed.
 *
 * @remarks
 * One a line, a directory's ending in `/`; a `.git` directory and anything in one left out, as pi
 * does.
 *
 * @sideEffects none
 * @param stdout - What `fd` printed.
 * @returns The entries.
 */
export function parseFdOutput(stdout: string): FdEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .filter((line) => !line.split("/").includes(".git"))
    .map((line) => ({ path: line, isDirectory: line.endsWith("/") }));
}
