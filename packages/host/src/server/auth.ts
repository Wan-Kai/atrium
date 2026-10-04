import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a presented token with the expected one in constant time.
 *
 * @remarks
 * Both values are hashed first so the comparison takes the same time whatever their lengths,
 * which `timingSafeEqual` alone does not allow (it throws on unequal lengths).
 *
 * @sideEffects none
 * @param expected - The host's token.
 * @param presented - The token a client sent.
 * @returns Whether they are equal.
 */
export function tokensMatch(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented));
}

/**
 * Hashes a token to a fixed-length digest.
 *
 * @remarks
 * Equal-length inputs let `timingSafeEqual` compare tokens of any length without leaking the
 * expected length.
 *
 * @sideEffects none
 * @param value - The token.
 * @returns Its SHA-256 digest.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
