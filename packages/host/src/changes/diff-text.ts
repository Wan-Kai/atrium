import type { DiffFile, DiffHunk, DiffLine, DiffStat } from "@atrium/protocol";

/** One file as `git diff --numstat -z` lists it. */
export interface NumstatEntry {
  readonly path: string;
  /** The path before a rename or copy; `null` otherwise. */
  readonly oldPath: string | null;
  readonly added: number;
  readonly removed: number;
  /** git counts no lines in a binary file. */
  readonly binary: boolean;
}

/**
 * The lines added and removed, from `git diff --shortstat`.
 *
 * @remarks
 * git leaves out a part that is zero, and prints nothing for no change.
 *
 * @sideEffects none
 * @param output - What git printed.
 * @returns The counts.
 */
export function parseShortstat(output: string): DiffStat {
  const added = /(\d+) insertions?\(\+\)/.exec(output)?.[1];
  const removed = /(\d+) deletions?\(-\)/.exec(output)?.[1];
  return { added: Number(added ?? 0), removed: Number(removed ?? 0) };
}

/**
 * The files of `git diff --numstat -z`.
 *
 * @remarks
 * Each is `added<TAB>removed<TAB>path<NUL>`; a rename or copy leaves the path empty and gives the
 * old and new paths as the next two fields. A binary file's counts are `-`.
 *
 * @sideEffects none
 * @param output - What git printed.
 * @returns The files, in git's order.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const fields = output.split("\0");
  const entries: NumstatEntry[] = [];
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at] ?? "";
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (match === null) continue;
    const [, added = "", removed = "", path = ""] = match;
    const binary = added === "-";
    const counts = { added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary };
    if (path !== "") {
      entries.push({ path, oldPath: null, ...counts });
      continue;
    }
    const oldPath = fields[at + 1] ?? "";
    const newPath = fields[at + 2] ?? "";
    at += 2;
    entries.push({ path: newPath, oldPath, ...counts });
  }
  return entries;
}

/**
 * Each new path's status, from `git diff --name-status -z`.
 *
 * @remarks
 * A rename (`R`) or copy (`C`) gives a score, then the old and new paths; a copy is a new file. A
 * type change (`T`) counts as a modification.
 *
 * @sideEffects none
 * @param output - What git printed.
 * @returns The status by path.
 */
export function parseNameStatus(output: string): Map<string, DiffFile["status"]> {
  const fields = output.split("\0");
  const statuses = new Map<string, DiffFile["status"]>();
  for (let at = 0; at < fields.length; at++) {
    const code = (fields[at] ?? "").charAt(0);
    if (code === "R" || code === "C") {
      statuses.set(fields[at + 2] ?? "", code === "R" ? "renamed" : "added");
      at += 2;
    } else if (code !== "") {
      statuses.set(fields[at + 1] ?? "", code === "A" ? "added" : code === "D" ? "deleted" : "modified");
      at += 1;
    }
  }
  return statuses;
}

/**
 * A patch split into one section a file.
 *
 * @remarks
 * Each section starts at its `diff --git` line; sections come in the order `--numstat` lists
 * the files.
 *
 * @sideEffects none
 * @param patch - What `git diff` printed.
 * @returns The sections.
 */
export function splitPatch(patch: string): string[] {
  return patch.split(/^(?=diff --git )/m).filter((section) => section.startsWith("diff --git "));
}

/**
 * The hunks of one file's section of a patch.
 *
 * @remarks
 * Lines are numbered from each `@@ -a,b +c,d @@` header, old and new apart. Within a hunk a line's
 * first character says what it is, so a line that looks like a header is still a line; git's
 * "\ No newline at end of file" is left out. A binary file's section has no hunks.
 *
 * @sideEffects none
 * @param section - The file's section.
 * @returns The hunks.
 */
export function parseHunks(section: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let lines: DiffLine[] | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  for (const line of section.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      const [, oldStart = "0", oldCount = "1", newStart = "0", newCount = "1"] = header;
      lines = [];
      oldNumber = Number(oldStart);
      newNumber = Number(newStart);
      hunks.push({
        oldStart: Number(oldStart),
        oldCount: Number(oldCount),
        newStart: Number(newStart),
        newCount: Number(newCount),
        lines,
      });
      continue;
    }
    if (lines === null) continue;
    const mark = line.charAt(0);
    const text = line.slice(1);
    if (mark === "+") {
      lines.push({ kind: "add", oldNumber: null, newNumber, text });
      newNumber += 1;
    } else if (mark === "-") {
      lines.push({ kind: "del", oldNumber, newNumber: null, text });
      oldNumber += 1;
    } else if (mark === " ") {
      lines.push({ kind: "context", oldNumber, newNumber, text });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return hunks;
}

/** How much of a file is looked at to tell whether it is binary, as Paseo does. */
export const BINARY_SNIFF_BYTES = 16 * 1024;

/**
 * Whether a file's start looks binary.
 *
 * @remarks
 * As Paseo: a zero byte, or more than 30% control bytes (below 7, 14 to 31, or 127), means
 * binary; tabs, line breaks and form feeds are text (SPEC-0001, "工作区改动").
 *
 * @sideEffects none
 * @param start - The file's first bytes, up to `BINARY_SNIFF_BYTES`.
 * @returns Whether it is binary.
 */
export function isLikelyBinary(start: Uint8Array): boolean {
  if (start.length === 0) return false;
  let control = 0;
  for (const byte of start) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32) || byte === 127) control += 1;
  }
  return control / start.length > 0.3;
}

/**
 * How many lines a file has.
 *
 * @remarks
 * A last line break starts no line; CRLF counts once.
 *
 * @sideEffects none
 * @param text - The file's text.
 * @returns The count.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * A new file's text as one hunk of added lines.
 *
 * @remarks
 * For untracked files, whose diff git does not give without running once a file.
 *
 * @sideEffects none
 * @param text - The file's text.
 * @returns The hunk, or none for an empty file.
 */
export function addedFileHunks(text: string): DiffHunk[] {
  const count = countLines(text);
  if (count === 0) return [];
  const lines = text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .slice(0, count)
    .map((line, index): DiffLine => ({ kind: "add", oldNumber: null, newNumber: index + 1, text: line }));
  return [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: count, lines }];
}
