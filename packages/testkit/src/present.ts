/**
 * Returns `value`, failing the test when it is `null` or `undefined`.
 *
 * @remarks
 * Test bodies must not branch (testing.md, "让每个测试都有效"); narrowing an optional result with
 * `??` or `?.` would hide a missing value behind a default. This fails loudly instead.
 *
 * @sideEffects Throws when the value is missing.
 * @param value - Value expected to exist.
 * @param what - Description used in the failure message.
 * @returns The value, typed as present.
 * @throws {Error} When `value` is `null` or `undefined`.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}
