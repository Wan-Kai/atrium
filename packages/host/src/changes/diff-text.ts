import type { DiffFile, DiffHunk, DiffLine, DiffStat } from "@atrium/protocol";

/** One file as `git diff --raw --numstat -z` lists it. */
export interface DiffEntry {
  readonly path: string;
  /** The path before a rename; `null` otherwise. */
  readonly oldPath: string | null;
  readonly status: DiffFile["status"];
  /** A file turned into a link or back, which the patch shows as two sections. */
  readonly typeChanged: boolean;
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

/** A raw record's status letter, as the panel names it. */
const STATUSES: Readonly<Record<string, DiffFile["status"]>> = { A: "added", C: "added", D: "deleted", R: "renamed" };

/**
 * The files and patch of one `git diff --raw --numstat -p -z`.
 *
 * @remarks
 * One run, so the files and their sections come from one look at the tree. The raw records
 * (`:<modes> <ids> <status>` then the path, two for a rename or copy) come first, then the numstat
 * records in the same order (`added<TAB>removed<TAB>path`, or an empty path and then two for a
 * rename), then an empty field, then the patch. A binary file's counts are `-`. A copy is a new
 * file; a type change counts as a modification.
 *
 * @sideEffects none
 * @param output - What git printed.
 * @returns The files, in git's order, and the patch.
 */
export function parseDiffOutput(output: string): { readonly entries: DiffEntry[]; readonly patch: string } {
  const fields = output.split("\0");
  const raw: { status: string; path: string; oldPath: string | null }[] = [];
  let at = 0;
  for (; at < fields.length && (fields[at] ?? "").startsWith(":"); at++) {
    const status = (fields[at] ?? "").split(" ").at(-1)?.charAt(0) ?? "M";
    if (status === "R" || status === "C") {
      raw.push({ status, oldPath: fields[at + 1] ?? "", path: fields[at + 2] ?? "" });
      at += 2;
    } else {
      raw.push({ status, oldPath: null, path: fields[at + 1] ?? "" });
      at += 1;
    }
  }
  const counts: { added: number; removed: number; binary: boolean }[] = [];
  for (; at < fields.length; at++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[at] ?? "");
    if (match === null) break;
    const [, added = "", removed = "", path = ""] = match;
    const binary = added === "-";
    counts.push({ added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
    if (path === "") at += 2;
  }
  const entries = raw.map(({ status, path, oldPath }, index): DiffEntry => {
    const count = counts[index] ?? { added: 0, removed: 0, binary: false };
    return {
      path,
      oldPath: status === "R" ? oldPath : null,
      status: STATUSES[status] ?? "modified",
      typeChanged: status === "T",
      ...count,
    };
  });
  return { entries, patch: fields.slice(at + 1).join("\0") };
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
 * "\ No newline at end of file" is left out, and an empty line within the hunk is an empty context
 * line. A binary file's section has no hunks.
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
  /** Past the hunk's old lines, an empty line is the patch's own end, not a line. */
  let oldEnd = 0;
  for (const line of section.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      const [, oldStart = "0", oldCount = "1", newStart = "0", newCount = "1"] = header;
      lines = [];
      oldNumber = Number(oldStart);
      newNumber = Number(newStart);
      oldEnd = Number(oldStart) + Number(oldCount);
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
    } else if (mark === " " || (line === "" && oldNumber < oldEnd)) {
      // git writes an empty context line with no space when `diff.suppressBlankEmpty` is on.
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
