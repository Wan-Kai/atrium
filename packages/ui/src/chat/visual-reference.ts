/** A `visual` code block's reference (SPEC-0007, "接口与数据"). */
export interface VisualReference {
  readonly path: string;
  /** A short title for the placeholder; `null` when none was given. */
  readonly title: string | null;
}

/** The longest path the host takes, as the protocol does. */
const PATH_MAX = 4096;

/** The longest title shown. */
const TITLE_MAX = 200;

/**
 * Reads a `visual` code block: one line of JSON, `{"path": string, "title"?: string}`.
 *
 * @remarks
 * SPEC-0007 ("一个演示 = 一个文件"). Anything else is no reference, and the card says the block is
 * written wrong rather than loading anything. A blank title counts as none.
 *
 * @sideEffects none
 * @param code - The block's text.
 * @returns The reference, or `null`.
 */
export function parseVisualReference(code: string): VisualReference | null {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const path: unknown = Reflect.get(value, "path");
  const title: unknown = Reflect.get(value, "title");
  if (typeof path !== "string" || path === "" || path.length > PATH_MAX) return null;
  if (title !== undefined && typeof title !== "string") return null;
  const shown = title?.trim() ?? "";
  return { path, title: shown === "" ? null : shown.slice(0, TITLE_MAX) };
}

/**
 * Whether a visual's path is relative to the session's working directory.
 *
 * @remarks
 * Only such a path can be opened in a viewer tab, which reads the workspace's files (SPEC-0007,
 * MV1 details).
 *
 * @sideEffects none
 * @param path - The path.
 * @returns Whether it is relative.
 */
export function isRelativeVisual(path: string): boolean {
  return !path.startsWith("/");
}
