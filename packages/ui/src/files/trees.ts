import type { DiffFile, DirEntry } from "@atrium/protocol";

/** A row of the changes tree: a directory and what is in it, or a changed file. */
export type ChangeNode =
  | {
      readonly kind: "dir";
      /** The directory's path in the workspace, the deepest one where single directories join. */
      readonly path: string;
      /** What the row shows: from its parent row down, as `packages/ui/src` where joined. */
      readonly name: string;
      readonly added: number;
      readonly removed: number;
      readonly children: readonly ChangeNode[];
    }
  | { readonly kind: "file"; readonly name: string; readonly file: DiffFile };

/** A directory being built, before it is sorted and joined. */
interface Building {
  readonly dirs: Map<string, Building>;
  readonly files: DiffFile[];
}

/**
 * Compares two names by code point.
 *
 * @remarks
 * The changes tree orders as Paseo's does, not by locale (SPEC-0001, "M1.12 的文件与更改").
 * Names in one directory differ, so two are never equal.
 *
 * @sideEffects none
 * @param a - One name.
 * @param b - The other.
 * @returns Negative or positive.
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/**
 * The one directory a built directory holds, when it holds nothing else.
 *
 * @remarks
 * Such a directory shares its row with that one (`changeTree`).
 *
 * @sideEffects none
 * @param building - The directory.
 * @returns The directory's name and contents, or `null`.
 */
function soleDir(building: Building): readonly [string, Building] | null {
  if (building.files.length > 0 || building.dirs.size !== 1) return null;
  return [...building.dirs][0] ?? null;
}

/**
 * A built directory's rows, sorted, with directories that hold only one directory joined to it.
 *
 * @remarks
 * See `changeTree`.
 *
 * @sideEffects none
 * @param building - The directory.
 * @param prefix - Its path, ending in `/`, or empty at the top.
 * @returns Its rows.
 */
function rowsOf(building: Building, prefix: string): ChangeNode[] {
  const dirs = [...building.dirs]
    .toSorted(([a], [b]) => byCodePoint(a, b))
    .map(([name, inside]): ChangeNode => {
      let joined = name;
      let deepest = inside;
      for (let only = soleDir(deepest); only !== null; only = soleDir(deepest)) {
        joined = `${joined}/${only[0]}`;
        deepest = only[1];
      }
      const children = rowsOf(deepest, `${prefix}${joined}/`);
      const files = filesUnder(deepest);
      return {
        kind: "dir",
        path: `${prefix}${joined}`,
        name: joined,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0),
        children,
      };
    });
  const files = building.files
    .map((file): ChangeNode => ({ kind: "file", name: file.path.slice(prefix.length), file }))
    .toSorted((a, b) => byCodePoint(a.name, b.name));
  return [...dirs, ...files];
}

/**
 * Every file in a built directory and below it.
 *
 * @remarks
 * For a directory row's totals.
 *
 * @sideEffects none
 * @param building - The directory.
 * @returns The files.
 */
function filesUnder(building: Building): DiffFile[] {
  return [...building.files, ...[...building.dirs.values()].flatMap(filesUnder)];
}

/**
 * The changed files as a tree of directories.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 更改"): directories first, each level by code point; a
 * directory holding only one directory and no files shares its row (`packages/ui/src`); a
 * directory's row counts every file under it. A renamed file sits under its new path.
 *
 * @sideEffects none
 * @param files - The diff's files.
 * @returns The top rows.
 */
export function changeTree(files: readonly DiffFile[]): ChangeNode[] {
  const top: Building = { dirs: new Map(), files: [] };
  for (const file of files) {
    let at = top;
    for (const part of file.path.split("/").slice(0, -1)) {
      const next = at.dirs.get(part) ?? { dirs: new Map(), files: [] };
      at.dirs.set(part, next);
      at = next;
    }
    at.files.push(file);
  }
  return rowsOf(top, "");
}

/**
 * The files of a changes tree, in the order its rows show them.
 *
 * @remarks
 * The 改动 tab shows the files in this order (SPEC-0001, "M1.12 的文件与更改 · 查看标签").
 *
 * @sideEffects none
 * @param rows - The tree's rows.
 * @returns The files.
 */
export function treeOrder(rows: readonly ChangeNode[]): DiffFile[] {
  return rows.flatMap((row) => (row.kind === "file" ? [row.file] : treeOrder(row.children)));
}

/** How the files tree compares names: numbers by value, as Finder does. */
const BY_NAME = new Intl.Collator(undefined, { numeric: true });

/**
 * A directory's entries in the files tree's order.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 文件"): directories first, then by name with numbers by value;
 * a link shows as a file.
 *
 * @sideEffects none
 * @param entries - The entries, as `list_dir` gave them.
 * @returns Them sorted.
 */
export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return entries.toSorted(
    (a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || BY_NAME.compare(a.name, b.name),
  );
}

/** How deep an expanded directory may be and still open again by itself. */
const RESTORED_DEPTH = 5;

/**
 * The expanded directories that open again when the files tree shows.
 *
 * @remarks
 * Only those at most five levels down, as Paseo (SPEC-0001, "M1.12 的文件与更改 · 文件").
 *
 * @sideEffects none
 * @param paths - The directories remembered as expanded.
 * @returns Those that open again.
 */
export function restoredDirs(paths: Iterable<string>): Set<string> {
  return new Set([...paths].filter((path) => path.split("/").length <= RESTORED_DEPTH));
}
