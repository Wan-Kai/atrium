import type { FileLineRange } from "../state/workspace-views";

/** A local reference, still subject to the current workspace's boundary. */
export interface ReplyFileTarget {
  readonly path: string;
  readonly range?: FileLineRange;
}

/** Separates an explicit local file address from its one-based line navigation.
 * @remarks Decoding follows suffix extraction so a filename's encoded colon is not a line marker.
 * This does not grant file access: the existing workspace opener and host still check the path.
 * @sideEffects none
 * @param source - The original Markdown address or entire inline-code text.
 * @param inline - Whether a line marker and an unambiguous file-shaped token are required.
 * @returns The local target, or null for unsupported syntax and unsafe addresses.
 */
export function replyFileTarget(source: string, inline = false): ReplyFileTarget | null {
  const suffix = /(?:#L([0-9]+)(?:-L([0-9]+))?|:([0-9]+)(?:-([0-9]+))?)$/u.exec(source);
  const start = Number(suffix?.[1] ?? suffix?.[3]);
  const end = Number(suffix?.[2] ?? suffix?.[4] ?? suffix?.[1] ?? suffix?.[3]);
  const range = suffix === null ? undefined : { start, end };
  if (range !== undefined && (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start))
    return null;
  let path = suffix === null ? source : source.slice(0, suffix.index);
  // A second raw numeric colon is a line/column address, not a different filename.
  // Mutation review: range's presence is redundant here: any raw terminal :digits in a
  // source without a parsed suffix would itself have been parsed as that suffix.
  if (range !== undefined && /:[0-9]+(?:-[0-9]+)?$/u.test(path)) return null;
  if (/[?#]/u.test(path) || /%2f|%5c/iu.test(path)) return null;
  if (/^file:/iu.test(path)) {
    // Mutation review: the trailing anchor is redundant after the raw ?/# refusal above;
    // the greedy path class already consumes the entire remaining address.
    const file = /^file:\/\/(?:localhost)?(\/[^?#]*)$/iu.exec(path);
    if (file?.[1] === undefined) return null;
    path = file[1];
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (
    path === "" ||
    path.length > 4096 ||
    /\p{Cc}|\\/u.test(path) ||
    path.startsWith("//") ||
    path.startsWith("~") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(path) ||
    path.split("/").includes("..")
  )
    return null;
  // Bare name:digits is indistinguishable from host:port; ./ or #L makes intent explicit.
  // Mutation review: range's short circuit proves suffix exists before its defensive optional access.
  if (inline && (range === undefined || /\s/u.test(path) || (!path.includes("/") && suffix?.[1] === undefined)))
    return null;
  return { path, ...(range === undefined ? {} : { range }) };
}
