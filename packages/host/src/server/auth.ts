import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a presented token with the expected one without short-circuiting.
 *
 * @remarks
 * Both values are hashed first so `timingSafeEqual` always compares two equal-length digests:
 * it would throw on unequal lengths, and a plain `===` stops at the first differing character.
 * Hashing time still grows with the presented token's length, which the client knows anyway.
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

/** Shortest acceptable token: 32 random bytes encoded as base64url. */
const MIN_TOKEN_LENGTH = 43;

/**
 * Tells whether a token is long enough and uses only the base64url alphabet.
 *
 * @remarks
 * security.md requires at least 32 random bytes; the desktop app generates exactly that, and a
 * token set by hand for standalone runs must meet the same bar. Shorter values would also slip
 * past the log redactor, which ignores secrets under 8 characters.
 *
 * @sideEffects none
 * @param token - Candidate token.
 * @returns Whether the host may use it.
 */
export function isStrongToken(token: string): boolean {
  return token.length >= MIN_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token);
}
