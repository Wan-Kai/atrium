/**
 * The `code` of a Node system error.
 *
 * @remarks
 * File system and process calls fail with errors that carry a string `code` such as `ENOENT`;
 * callers branch on it without asserting the error's type.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns The code, or `undefined` when there is none.
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
