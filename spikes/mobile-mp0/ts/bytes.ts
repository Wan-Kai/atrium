/** Byte encodings shared by the spike: hex for records, base64url for the pairing link. */

/**
 * Lower-case hex of bytes.
 *
 * @sideEffects none
 * @param bytes - The bytes.
 * @returns The hex.
 */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex");
}

/**
 * Bytes of a hex string.
 *
 * @sideEffects none
 * @param hex - Even length, hex digits only.
 * @returns The bytes.
 * @throws Error on anything else.
 */
export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("not hex");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * Base64url without padding.
 *
 * @sideEffects none
 * @param bytes - The bytes.
 * @returns The text.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("base64url");
}

/**
 * Bytes of base64url text, checked to round-trip so sloppy encodings are refused.
 *
 * @sideEffects none
 * @param text - Base64url without padding.
 * @param length - The byte length it must have.
 * @returns The bytes.
 * @throws Error when it is not canonical base64url of that length.
 */
export function fromBase64Url(text: string, length: number): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  if (bytes.length !== length || toBase64Url(bytes) !== text) throw new Error("bad base64url");
  return bytes;
}

/**
 * UTF-8 bytes of text.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The bytes.
 */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Text of UTF-8 bytes, refusing invalid sequences.
 *
 * @sideEffects none
 * @param bytes - The bytes.
 * @returns The text.
 * @throws TypeError on invalid UTF-8.
 */
export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
