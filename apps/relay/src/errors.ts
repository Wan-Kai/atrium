/**
 * The `code` of a caught error, such as `ENOENT`, without its message.
 *
 * @remarks
 * File system messages carry paths; the relay only branches on the code. Not an assertion to
 * `NodeJS.ErrnoException`, which the type-aware lint rightly calls unsafe for `unknown`.
 *
 * @sideEffects none
 * @param error - What was caught.
 * @returns The code, or undefined.
 */
export function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}
