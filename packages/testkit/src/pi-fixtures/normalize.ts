import type { Json } from "./format";

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ENTRY_ID = /^[0-9a-f]{8}$/;
/** An 8-hex word inside text; replaced only when it is an entry id already seen under an id key. */
const ENTRY_ID_WORD = /\b[0-9a-f]{8}\b/g;
/** Keys whose value is a session entry id or a reference to one (pi-internals.md §1). */
const ENTRY_ID_KEYS: ReadonlySet<string> = new Set([
  "id",
  "parentId",
  "leafId",
  "since",
  "targetId",
  "firstKeptEntryId",
]);
/**
 * Numbers that measure the run rather than describe it: token counts depend on the system prompt,
 * which contains the working directory's path, and wall time and durations (a tool's, from pi
 * 1.1.0) on the machine.
 */
const MEASURED_KEYS: ReadonlySet<string> = new Set([
  "tokensBefore",
  "estimatedTokensAfter",
  "wall_time_seconds",
  "durationMs",
]);
const FIXED_TIME = "1970-01-01T00:00:00.000Z";
/** The time pi puts in session file names, with `-` for `:` and `.` (pi-internals.md §1). */
const FILE_NAME_TIME = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g;

/**
 * Creates a function that replaces everything run-specific in pi's output with stable placeholders.
 *
 * @remarks
 * Fixtures must come out byte for byte the same when re-recorded on the same machine, so only
 * real changes in pi show up in a diff (testing.md, "pi 夹具"). Timestamps, including the one in
 * session file names, become fixed values, and so do measurements: every number in `usage`, token
 * counts, wall time and durations become 0. Paths become named placeholders; UUIDs (the session id) and 8-hex
 * entry ids become numbered tokens in order of first appearance. Entry ids are recognized only
 * under the keys that hold them, so text that happens to be 8 hex digits stays as it is. The
 * numbering is shared by every value the function sees, so an id and every reference to it
 * (`parentId`, `leafId`, `since`) get the same token and the entry tree keeps its shape; an id
 * already seen is also replaced where text mentions it, as in a command's argument. Longer
 * paths are replaced first, so a path inside another is not cut in half.
 *
 * @sideEffects none; the returned function remembers the tokens it has handed out.
 * @param paths - Absolute paths and their placeholders, such as the working directory → `<cwd>`.
 * @returns The normalizing function.
 */
export function createNormalizer(paths: Readonly<Record<string, string>>): (value: Json) => Json {
  const byLength = Object.entries(paths).toSorted(([a], [b]) => b.length - a.length);
  const uuids = new Map<string, string>();
  const entryIds = new Map<string, string>();

  /**
   * Normalizes one string.
   *
   * @remarks
   * Order matters: paths may contain UUIDs (session file names), so they go first.
   *
   * @sideEffects Records new tokens.
   * @param text - The string.
   * @param key - The key it sits under, if any.
   * @returns The normalized string.
   */
  function normalizeString(text: string, key: string | undefined): string {
    if (ISO_TIME.test(text)) return FIXED_TIME;
    if (key !== undefined && ENTRY_ID_KEYS.has(key) && ENTRY_ID.test(text)) {
      if (!entryIds.has(text)) entryIds.set(text, `e${entryIds.size + 1}`);
      return entryIds.get(text) ?? text;
    }
    let result = text.replace(FILE_NAME_TIME, "1970-01-01T00-00-00-000Z");
    for (const [path, placeholder] of byLength) result = result.replaceAll(path, placeholder);
    // An entry id already seen elsewhere, mentioned in text such as a command's argument.
    result = result.replace(ENTRY_ID_WORD, (word) => entryIds.get(word) ?? word);
    return result.replace(UUID, (uuid) => {
      if (!uuids.has(uuid)) uuids.set(uuid, `<uuid-${uuids.size + 1}>`);
      return uuids.get(uuid) ?? uuid;
    });
  }

  /**
   * Normalizes any JSON value.
   *
   * @remarks
   * Numbers under a `timestamp` key are times, and numbers inside `usage` or under a measured key
   * are measurements; other numbers (exit codes, counts of messages) are kept.
   *
   * @sideEffects Records new tokens.
   * @param value - The value.
   * @param key - The key it sits under, if any.
   * @param inUsage - Whether the value sits somewhere inside a `usage` object.
   * @returns The normalized value.
   */
  function normalize(value: Json, key: string | undefined, inUsage: boolean): Json {
    if (typeof value === "string") return normalizeString(value, key);
    if (typeof value === "number") {
      return inUsage || key === "timestamp" || (key !== undefined && MEASURED_KEYS.has(key)) ? 0 : value;
    }
    if (Array.isArray(value)) return value.map((item: Json) => normalize(item, undefined, inUsage));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, normalize(item, name, inUsage || name === "usage")]),
      );
    }
    return value;
  }

  return (value) => normalize(value, undefined, false);
}
