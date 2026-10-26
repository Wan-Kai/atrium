import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes";
import { encodeMessage, FrameReader } from "./framing";
import { concat } from "./noise";
import {
  CHUNK_TIMEOUT_MS,
  ChannelError,
  type ChannelFailure,
  HOST_TO_PHONE_LIMIT,
  MAX_CHUNK,
  PHONE_TO_HOST_LIMIT,
} from "./wire";

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

/**
 * A fresh reader for one malformed frame.
 *
 * @remarks
 * A reader that refused something is not reused.
 *
 * @sideEffects none
 * @returns The reader.
 */
function freshReader(): FrameReader {
  return new FrameReader(PHONE_TO_HOST_LIMIT, new FakeClock(), () => {});
}

describe("framing", () => {
  it("sends a message that fits in one chunk as a single 0x00 frame", () => {
    const frames = encodeMessage("x".repeat(MAX_CHUNK), PHONE_TO_HOST_LIMIT);
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe(0x00);
    expect(frames[0]).toHaveLength(MAX_CHUNK + 1);
  });

  it("splits one byte more into 0x01 then 0x00, and the reader joins them", () => {
    const text = "y".repeat(MAX_CHUNK + 1);
    const frames = encodeMessage(text, PHONE_TO_HOST_LIMIT);
    expect(frames.map((frame) => [frame[0], frame.length])).toStrictEqual([
      [0x01, MAX_CHUNK + 1],
      [0x00, 2],
    ]);
    const clock = new FakeClock();
    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, clock, () => {});
    expect(reader.push(frames[0]!)).toBeNull();
    expect(clock.pendingTimers()).toBe(1);
    expect(reader.push(frames[1]!)).toStrictEqual({ kind: "message", text });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("keeps multi-byte characters whole across chunk borders", () => {
    const text = "a".repeat(MAX_CHUNK - 1) + "猫猫";
    const frames = encodeMessage(text, PHONE_TO_HOST_LIMIT);
    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, new FakeClock(), () => {});
    const results = frames.map((frame) => reader.push(frame));
    expect(results.at(-1)).toStrictEqual({ kind: "message", text });
  });

  it("lets heartbeats and control messages through between chunks", () => {
    const frames = encodeMessage("z".repeat(MAX_CHUNK * 2 + 1), HOST_TO_PHONE_LIMIT);
    expect(frames).toHaveLength(3);
    const reader = new FrameReader(HOST_TO_PHONE_LIMIT, new FakeClock(), () => {});
    expect(reader.push(frames[0]!)).toBeNull();
    expect(reader.push(Uint8Array.of(0x02))).toStrictEqual({ kind: "ping" });
    expect(reader.push(concat(Uint8Array.of(0x04), utf8('{"kind":"revoked"}')))).toStrictEqual({
      kind: "control",
      value: { kind: "revoked" },
    });
    expect(reader.push(frames[1]!)).toBeNull();
    expect(reader.push(Uint8Array.of(0x03))).toStrictEqual({ kind: "pong" });
    expect(reader.push(frames[2]!)).toStrictEqual({ kind: "message", text: "z".repeat(MAX_CHUNK * 2 + 1) });
  });

  it("times out 30 seconds after the first 0x01 chunk, not after the latest", () => {
    const clock = new FakeClock();
    let timedOut = 0;
    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, clock, () => (timedOut += 1));
    reader.push(Uint8Array.of(0x01, 0x61));
    clock.advance(CHUNK_TIMEOUT_MS - 1);
    reader.push(Uint8Array.of(0x01, 0x62));
    expect(timedOut).toBe(0);
    clock.advance(1);
    expect(timedOut).toBe(1);
  });

  it("enforces 1 MiB from the phone and 8 MiB to the phone, on both ends", () => {
    expect(() => encodeMessage("a".repeat(PHONE_TO_HOST_LIMIT), PHONE_TO_HOST_LIMIT)).not.toThrow();
    expect(failureOf(() => encodeMessage("a".repeat(PHONE_TO_HOST_LIMIT + 1), PHONE_TO_HOST_LIMIT))).toBe(
      "message_too_large",
    );
    expect(failureOf(() => encodeMessage("a".repeat(HOST_TO_PHONE_LIMIT + 1), HOST_TO_PHONE_LIMIT))).toBe(
      "message_too_large",
    );

    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, new FakeClock(), () => {});
    const frames = encodeMessage("b".repeat(PHONE_TO_HOST_LIMIT + 1), HOST_TO_PHONE_LIMIT);
    const last = frames.pop()!;
    for (const frame of frames) reader.push(frame);
    expect(failureOf(() => reader.push(last))).toBe("message_too_large");
  });

  it("refuses empty frames, unknown types, padded heartbeats, bad control and bad UTF-8", () => {
    expect(failureOf(() => freshReader().push(new Uint8Array(0)))).toBe("bad_frame");
    expect(failureOf(() => freshReader().push(Uint8Array.of(0x05)))).toBe("unknown_frame_type");
    expect(failureOf(() => freshReader().push(Uint8Array.of(0xff, 1)))).toBe("unknown_frame_type");
    expect(failureOf(() => freshReader().push(Uint8Array.of(0x02, 0)))).toBe("bad_frame");
    expect(failureOf(() => freshReader().push(Uint8Array.of(0x03, 0)))).toBe("bad_frame");
    expect(failureOf(() => freshReader().push(concat(Uint8Array.of(0x04), utf8("[1]"))))).toBe("bad_control");
    expect(failureOf(() => freshReader().push(concat(Uint8Array.of(0x04), utf8('{"kind":1}'))))).toBe("bad_control");
    expect(failureOf(() => freshReader().push(concat(Uint8Array.of(0x04), utf8("{"))))).toBe("bad_control");
    expect(failureOf(() => freshReader().push(Uint8Array.of(0x00, 0xc3)))).toBe("bad_utf8");
  });
});
