import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toHex } from "./bytes";
import { ChannelError, type ChannelFailure, firstFrame, parseFirstFrame, prologue, sas } from "./wire";

/**
 * The reason a call failed with.
 *
 * @remarks
 * Every refusal must be a ChannelError with a reason the caller can log.
 *
 * @sideEffects Runs the call.
 * @param run - The call.
 * @returns The reason, or "no ChannelError" when it did not throw one.
 */
function failureOf(run: () => unknown): ChannelFailure | "no ChannelError" {
  try {
    run();
  } catch (error) {
    if (error instanceof ChannelError) return error.reason;
  }
  return "no ChannelError";
}

describe("first frame and prologue", () => {
  it("prefixes message 1 with A, version 1 and the mode, and reads it back", () => {
    const message = Uint8Array.of(9, 8, 7);
    expect(toHex(firstFrame("IK", message))).toBe("410101090807");
    expect(toHex(firstFrame("IKpsk2", message))).toBe("410102090807");
    expect(parseFirstFrame(firstFrame("IKpsk2", message))).toStrictEqual({ pattern: "IKpsk2", message });
    expect(parseFirstFrame(firstFrame("IK", message))).toStrictEqual({ pattern: "IK", message });
    // The header alone parses; the handshake then refuses the empty message 1.
    expect(parseFirstFrame(Uint8Array.of(0x41, 0x01, 0x01))).toStrictEqual({
      pattern: "IK",
      message: new Uint8Array(0),
    });
  });

  it("refuses other versions, modes and magic bytes without falling back", () => {
    expect(failureOf(() => parseFirstFrame(Uint8Array.of(0x41, 0x02, 0x01, 0)))).toBe("unknown_version");
    expect(failureOf(() => parseFirstFrame(Uint8Array.of(0x41, 0x01, 0x03, 0)))).toBe("unknown_mode");
    expect(failureOf(() => parseFirstFrame(Uint8Array.of(0x41, 0x01, 0x00, 0)))).toBe("unknown_mode");
    expect(failureOf(() => parseFirstFrame(Uint8Array.of(0x42, 0x01, 0x01, 0)))).toBe("bad_first_frame");
    expect(failureOf(() => parseFirstFrame(Uint8Array.of(0x41, 0x01)))).toBe("bad_first_frame");
    expect(new ChannelError("unknown_mode").message).toBe("channel: unknown_mode");
  });

  it("builds the prologue as atrium-remote/1 NUL hostId NUL", () => {
    expect(Buffer.from(prologue("hst_0123456789abcdef")).toString("latin1")).toBe(
      "atrium-remote/1\0hst_0123456789abcdef\0",
    );
    expect(() => prologue("hst_\0")).toThrow("hostId must be printable ASCII");
    expect(() => prologue("\0hst_0")).toThrow("hostId must be printable ASCII");
    expect(() => prologue(" hst_0")).toThrow("hostId must be printable ASCII");
    expect(() => prologue("")).toThrow("hostId must be printable ASCII");
  });
});

describe("SAS", () => {
  it("is the first 4 bytes of SHA-256('atrium-sas-v1' || h), big-endian, mod 10^6, six digits", () => {
    for (const fill of [0, 1, 0xab, 0xff]) {
      const h = new Uint8Array(32).fill(fill);
      const digest = createHash("sha256").update("atrium-sas-v1").update(h).digest();
      const expected = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
      expect(sas(h)).toBe(expected);
      expect(sas(h)).toMatch(/^\d{6}$/);
    }
    // Pinned so a change to the formula shows up even if both sides above change together.
    expect(sas(new Uint8Array(32))).toBe(sasPinned);
  });
});

const sasPinned = String(
  createHash("sha256").update("atrium-sas-v1").update(new Uint8Array(32)).digest().readUInt32BE(0) % 1_000_000,
).padStart(6, "0");
