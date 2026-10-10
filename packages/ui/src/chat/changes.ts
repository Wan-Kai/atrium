import type { DiffFile, DiffMode, DiffStat } from "@atrium/protocol";

/** The compact form Paseo writes large counts in. */
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * A count of lines as the changes capsule writes it.
 *
 * @remarks
 * Past 999 compactly, as Paseo: `1.2k`, `12.3k`, `1.3m`; smaller counts are written whole
 * (SPEC-0001, "工作区改动").
 *
 * @sideEffects none
 * @param count - The count.
 * @returns The text.
 */
export function formatDiffCount(count: number): string {
  return COMPACT.format(count).toLowerCase();
}

/** A mode chosen in the changes panel, and whether the tree had uncommitted changes then. */
export interface DiffChoice {
  readonly mode: DiffMode;
  readonly dirty: boolean;
}

/**
 * The mode the changes panel shows.
 *
 * @remarks
 * As Paseo: uncommitted changes when there are some, else the branch's commits; a choice holds
 * only while the tree is as dirty as when it was made (SPEC-0001, "工作区改动").
 *
 * @sideEffects none
 * @param choice - The mode chosen, if any.
 * @param dirty - Whether the tree has uncommitted changes now.
 * @returns The mode.
 */
export function diffModeOf(choice: DiffChoice | null, dirty: boolean): DiffMode {
  if (choice !== null && choice.dirty === dirty) return choice.mode;
  return dirty ? "uncommitted" : "base";
}

/**
 * A path's name and the directory it is in.
 *
 * @remarks
 * A file's header shows the name, then the directory in grey.
 *
 * @sideEffects none
 * @param path - The path.
 * @returns The name, and the directory ending in `/` or empty.
 */
export function splitPath(path: string): { readonly name: string; readonly dir: string } {
  const slash = path.lastIndexOf("/");
  return { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) };
}

/**
 * The lines the panel's files add and remove together.
 *
 * @remarks
 * The panel's header shows them; they may differ from the capsule's (SPEC-0001, "工作区改动").
 *
 * @sideEffects none
 * @param files - The files.
 * @returns The totals.
 */
export function diffTotals(files: readonly DiffFile[]): DiffStat {
  return {
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}
