import type { DirEntry, StudyProgress } from "@atrium/protocol";
import { workspacePath } from "../files/workspace-path";
import { stepTitle } from "./progress";

// A direction's files on its home ("档案") and in its viewer tabs (SPEC-0008, "ML4 定的细节 · 档案";
// design-language "学习模式", prototype study-home 4A). The host lists the folders; the UI orders them.

/** A demo in the archive: its file name in `visuals/`, and the lesson it belongs to, if one. */
interface ArchiveDemo {
  readonly name: string;
  /** "第 M 步 · 课名"; `null` for one not named by the rule or of no step there. */
  readonly label: string | null;
}

/** The demos of one level, or, with `level` `null`, those matched to no step ("没对上课的"). */
export interface ArchiveDemoGroup {
  readonly level: number | null;
  readonly demos: readonly ArchiveDemo[];
}

/** A visual's name by the rule: level and step as numbers, the step in two digits (SPEC-0008, "演示"). */
const RULE = /^([1-9][0-9]*)-([0-9]{2,})-(.+)\.html$/u;

/** A file name ending in `.html`, any case. */
const HTML = /\.html$/iu;

/**
 * The archive's demos, grouped by level, the newest level first.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 档案": the level and step come from the name's `<级>-<步>-` prefix and
 * are matched in the progress (a level by its place in the ladder, skipped ones too); within a
 * level by step, then by name. Those matched to nothing go last, by name.
 *
 * @sideEffects none
 * @param names - The files right in `visuals/`.
 * @param progress - The direction's progress, if any.
 * @returns The groups; none without demos.
 */
export function demoGroups(names: readonly string[], progress: StudyProgress | null): ArchiveDemoGroup[] {
  const matched = new Map<number, { readonly name: string; readonly step: number; readonly label: string }[]>();
  const rest: string[] = [];
  for (const name of names.filter((one) => HTML.test(one))) {
    const rule = RULE.exec(name);
    const level = Number(rule?.[1]);
    const stepNumber = Number(rule?.[2]);
    const ladderLevel = progress?.ladder[level - 1];
    const step = ladderLevel === undefined ? undefined : progress?.steps[ladderLevel.id]?.[stepNumber - 1];
    if (step === undefined || progress === null) {
      rest.push(name);
      continue;
    }
    const label = `第 ${String(stepNumber)} 步 · ${stepTitle(step, level, progress.ladder)}`;
    matched.set(level, [...(matched.get(level) ?? []), { name, step: stepNumber, label }]);
  }
  const groups: ArchiveDemoGroup[] = [...matched.entries()]
    .toSorted(([a], [b]) => b - a)
    .map(([level, demos]) => ({
      level,
      demos: demos
        .toSorted((a, b) => a.step - b.step || byName(a.name, b.name))
        .map(({ name, label }) => ({ name, label })),
    }));
  if (rest.length > 0) {
    groups.push({ level: null, demos: rest.toSorted(byName).map((name) => ({ name, label: null })) });
  }
  return groups;
}

/**
 * Two names in the order a list shows them: by code point.
 *
 * @remarks
 * The same everywhere, whatever the system's language.
 *
 * @sideEffects none
 * @param a - One name.
 * @param b - The other.
 * @returns Negative, zero or positive.
 */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether an entry is a known one: of this name and kind.
 *
 * @remarks
 * A folder named `resources.md` is the learner's own, not the resources.
 *
 * @sideEffects none
 * @param entry - The entry.
 * @param name - The known name.
 * @param kind - Its kind.
 * @returns Whether.
 */
function known(entry: DirEntry, name: string, kind: DirEntry["kind"]): boolean {
  return entry.name === name && entry.kind === kind;
}

/** The files the archive lists first, in order, with their kind (SPEC-0008, "ML4 定的细节 · 档案"). */
const FIRST: readonly (readonly [string, DirEntry["kind"]])[] = [
  ["resources.md", "file"],
  ["cheatsheet.md", "file"],
  ["notes", "dir"],
  ["lab", "dir"],
];

/**
 * The archive's "文件": the direction's root in its order.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 档案": `resources.md`, `cheatsheet.md`, `notes/`, `lab/`, then the
 * learner's own by name, then `AGENTS.md`; `visuals/` is shown as the demos instead. A known name
 * of another kind is the learner's own. The host lists no dot file there.
 *
 * @sideEffects none
 * @param entries - The root's entries, in no order.
 * @returns Them in order.
 */
export function archiveFiles(entries: readonly DirEntry[]): DirEntry[] {
  const first = FIRST.flatMap(([name, kind]) => entries.filter((entry) => known(entry, name, kind)));
  const agents = entries.filter((entry) => known(entry, "AGENTS.md", "file"));
  const own = entries
    .filter(
      (entry) =>
        !first.includes(entry) && !agents.includes(entry) && !(entry.name === "visuals" && entry.kind === "dir"),
    )
    .toSorted((a, b) => byName(a.name, b.name));
  return [...first, ...own, ...agents];
}

/**
 * Whether a path in a direction is a demo its viewer tab renders: a `.html` right in `visuals/`.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 从档案打开的演示": only these are resolved for the direction; a
 * `.html` elsewhere, as in `lab/`, shows its source. In any case: the Mac's volume does not tell
 * `Visuals/a.HTML` from `visuals/a.html`, so a link written either way is the same demo and stays
 * in the sandbox.
 *
 * @sideEffects none
 * @param path - The path, relative to the direction.
 * @returns Whether.
 */
export function isDirectionVisual(path: string): boolean {
  return /^visuals\/[^/]+\.html$/iu.test(path);
}

/**
 * Whether a path in a direction is in its `visuals/`, at any depth and in any case.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 从档案打开的演示": nothing there goes to the system browser, where it
 * would run outside the sandbox and reach the network; the Mac's volume does not tell the cases
 * apart.
 *
 * @sideEffects none
 * @param path - The path, relative to the direction.
 * @returns Whether.
 */
export function inDirectionVisuals(path: string): boolean {
  return /^visuals(?:\/|$)/iu.test(path);
}

/**
 * Where a direction's sessions ran: its directory when not archived.
 *
 * @remarks
 * Archiving moves it to `Archive/<名>/` and leaves the sessions' records as they were
 * (SPEC-0008, "方向是一种新容器").
 *
 * @sideEffects none
 * @param direction - Where it is now and whether archived.
 * @returns The directory.
 */
export function directionHomeDir(direction: { readonly dir: string; readonly archived: boolean }): string {
  return direction.archived ? direction.dir.replace(/\/Archive\/([^/]+)\/*$/u, "/$1") : direction.dir;
}

/**
 * A path a direction's session names, relative to the direction, if it is in it.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 方向里的查看标签": relative to the direction's directory, where its
 * sessions run; absolute in where it is now, or in where it was when its sessions ran (archived
 * since). Any `..` is resolved and must stay in it (`workspacePath`).
 *
 * @sideEffects none
 * @param path - The path.
 * @param direction - Where it is now and whether archived.
 * @returns The relative path, or `null`.
 */
export function directionPath(
  path: string,
  direction: { readonly dir: string; readonly archived: boolean },
): string | null {
  return (
    workspacePath(path, direction.dir) ??
    (path.startsWith("/") ? workspacePath(path, directionHomeDir(direction)) : null)
  );
}
