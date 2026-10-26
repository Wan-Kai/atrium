import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toHex, utf8 } from "./bytes.ts";
import {
  ChannelError,
  type ChannelFailure,
  CHUNK_TIMEOUT_MS,
  encodeMessage,
  FrameReader,
  firstFrame,
  HOST_TO_PHONE_LIMIT,
  MAX_CHUNK,
  parseFirstFrame,
  PHONE_TO_HOST_LIMIT,
  prologue,
  type Received,
  sas,
  SecureChannel,
  type SetTimer,
} from "./channel.ts";
import { concat, encryptTransport, generateKeyPair, HandshakeState } from "./noise.ts";

/**
 * A timer source the test advances by hand.
 *
 * @sideEffects none
 * @returns The timer and a way to move time.
 */
function manualTimers(): { setTimer: SetTimer; advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    setTimer: (ms, run) => {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance: (ms) => {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
      }
    },
    pending: () => timers.size,
  };
}

/**
 * Asserts that a call throws a ChannelError with a reason.
 *
 * @sideEffects Runs the call.
 * @param run - The call.
 * @param reason - The expected reason.
 */
function expectFailure(run: () => unknown, reason: ChannelFailure): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ChannelError);
  expect((thrown as ChannelError).reason).toBe(reason);
}

describe("first frame and prologue", () => {
  it("prefixes message 1 with A, version 1 and the mode, and reads it back", () => {
    const message = Uint8Array.of(9, 8, 7);
    expect(toHex(firstFrame("IK", message))).toBe("410101090807");
    expect(toHex(firstFrame("IKpsk2", message))).toBe("410102090807");
    expect(parseFirstFrame(firstFrame("IKpsk2", message))).toStrictEqual({ pattern: "IKpsk2", message });
  });

  it("refuses other versions, modes and magic bytes without falling back", () => {
    expectFailure(() => parseFirstFrame(Uint8Array.of(0x41, 0x02, 0x01, 0)), "unknown_version");
    expectFailure(() => parseFirstFrame(Uint8Array.of(0x41, 0x01, 0x03, 0)), "unknown_mode");
    expectFailure(() => parseFirstFrame(Uint8Array.of(0x41, 0x01, 0x00, 0)), "unknown_mode");
    expectFailure(() => parseFirstFrame(Uint8Array.of(0x42, 0x01, 0x01, 0)), "bad_first_frame");
    expectFailure(() => parseFirstFrame(Uint8Array.of(0x41, 0x01)), "bad_first_frame");
  });

  it("builds the prologue as atrium-remote/1 NUL hostId NUL", () => {
    expect(Buffer.from(prologue("hst_0123456789abcdef")).toString("latin1")).toBe(
      "atrium-remote/1\0hst_0123456789abcdef\0",
    );
    expect(() => prologue("hst_\0")).toThrow();
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
    const timers = manualTimers();
    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, timers.setTimer, () => {});
    expect(reader.push(frames[0]!)).toBeNull();
    expect(timers.pending()).toBe(1);
    expect(reader.push(frames[1]!)).toStrictEqual({ kind: "message", text });
    expect(timers.pending()).toBe(0);
  });

  it("keeps multi-byte characters whole across chunk borders", () => {
    const text = "a".repeat(MAX_CHUNK - 1) + "猫猫";
    const frames = encodeMessage(text, PHONE_TO_HOST_LIMIT);
    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, manualTimers().setTimer, () => {});
    const results = frames.map((frame) => reader.push(frame));
    expect(results.at(-1)).toStrictEqual({ kind: "message", text });
  });

  it("lets heartbeats and control messages through between chunks", () => {
    const frames = encodeMessage("z".repeat(MAX_CHUNK * 2 + 1), HOST_TO_PHONE_LIMIT);
    expect(frames).toHaveLength(3);
    const reader = new FrameReader(HOST_TO_PHONE_LIMIT, manualTimers().setTimer, () => {});
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
    const timers = manualTimers();
    let timedOut = 0;
    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, timers.setTimer, () => (timedOut += 1));
    reader.push(Uint8Array.of(0x01, 0x61));
    timers.advance(CHUNK_TIMEOUT_MS - 1);
    reader.push(Uint8Array.of(0x01, 0x62));
    expect(timedOut).toBe(0);
    timers.advance(1);
    expect(timedOut).toBe(1);
  });

  it("enforces 1 MiB from the phone and 8 MiB to the phone, on both ends", () => {
    expect(() => encodeMessage("a".repeat(PHONE_TO_HOST_LIMIT), PHONE_TO_HOST_LIMIT)).not.toThrow();
    expectFailure(() => encodeMessage("a".repeat(PHONE_TO_HOST_LIMIT + 1), PHONE_TO_HOST_LIMIT), "message_too_large");
    expectFailure(() => encodeMessage("a".repeat(HOST_TO_PHONE_LIMIT + 1), HOST_TO_PHONE_LIMIT), "message_too_large");

    const reader = new FrameReader(PHONE_TO_HOST_LIMIT, manualTimers().setTimer, () => {});
    const frames = encodeMessage("b".repeat(PHONE_TO_HOST_LIMIT + 1), HOST_TO_PHONE_LIMIT);
    const last = frames.pop()!;
    for (const frame of frames) reader.push(frame);
    expectFailure(() => reader.push(last), "message_too_large");
  });

  it("refuses empty frames, unknown types, padded heartbeats, bad control and bad UTF-8", () => {
    const reader = () => new FrameReader(PHONE_TO_HOST_LIMIT, manualTimers().setTimer, () => {});
    expectFailure(() => reader().push(new Uint8Array(0)), "bad_frame");
    expectFailure(() => reader().push(Uint8Array.of(0x05)), "unknown_frame_type");
    expectFailure(() => reader().push(Uint8Array.of(0xff, 1)), "unknown_frame_type");
    expectFailure(() => reader().push(Uint8Array.of(0x02, 0)), "bad_frame");
    expectFailure(() => reader().push(Uint8Array.of(0x03, 0)), "bad_frame");
    expectFailure(() => reader().push(concat(Uint8Array.of(0x04), utf8("[1]"))), "bad_control");
    expectFailure(() => reader().push(concat(Uint8Array.of(0x04), utf8('{"kind":1}'))), "bad_control");
    expectFailure(() => reader().push(concat(Uint8Array.of(0x04), utf8("{"))), "bad_control");
    expectFailure(() => reader().push(Uint8Array.of(0x00, 0xc3)), "bad_utf8");
  });
});

/**
 * Two channels over a finished IK handshake, wired to each other in memory.
 *
 * @sideEffects Reads the random source.
 * @returns Both channels and what each received.
 */
function wiredChannels() {
  const host = generateKeyPair();
  const initiator = HandshakeState.initiator({
    pattern: "IK",
    prologue: prologue("hst_0"),
    staticKey: generateKeyPair(),
    remoteStatic: host.publicKey,
  });
  const responder = HandshakeState.responder({ pattern: "IK", prologue: prologue("hst_0"), staticKey: host });
  responder.readMessage(initiator.writeMessage(utf8("{}")));
  initiator.readMessage(responder.writeMessage(utf8("{}")));
  const log = {
    phone: [] as Received[],
    host: [] as Received[],
    phoneClosed: [] as string[],
    hostClosed: [] as string[],
  };
  const wire = { toHost: [] as Uint8Array[], toPhone: [] as Uint8Array[] };
  const phoneTransport = initiator.finish();
  const phone = new SecureChannel(phoneTransport, {
    write: (bytes) => wire.toHost.push(bytes),
    sendLimit: PHONE_TO_HOST_LIMIT,
    receiveLimit: HOST_TO_PHONE_LIMIT,
    onReceive: (received) => log.phone.push(received),
    onClose: (reason) => log.phoneClosed.push(reason),
  });
  const hostChannel = new SecureChannel(responder.finish(), {
    write: (bytes) => wire.toPhone.push(bytes),
    sendLimit: HOST_TO_PHONE_LIMIT,
    receiveLimit: PHONE_TO_HOST_LIMIT,
    onReceive: (received) => log.host.push(received),
    onClose: (reason) => log.hostClosed.push(reason),
  });
  const flush = () => {
    while (wire.toHost.length > 0 || wire.toPhone.length > 0) {
      for (const bytes of wire.toHost.splice(0)) hostChannel.receive(bytes);
      for (const bytes of wire.toPhone.splice(0)) phone.receive(bytes);
    }
  };
  return { phone, host: hostChannel, log, wire, flush, phoneTransport };
}

describe("secure channel", () => {
  it("answers a heartbeat and carries messages and control both ways", () => {
    const { phone, host, log, flush } = wiredChannels();
    phone.ping();
    phone.sendMessage('{"type":"hello"}');
    host.sendControl({ kind: "paired", deviceId: "dev_1" });
    host.sendMessage("w".repeat(MAX_CHUNK * 3));
    flush();
    expect(log.host).toStrictEqual([{ kind: "ping" }, { kind: "message", text: '{"type":"hello"}' }]);
    // The host wrote its control and message before the pong, so the phone gets them first.
    expect(log.phone).toStrictEqual([
      { kind: "control", value: { kind: "paired", deviceId: "dev_1" } },
      { kind: "message", text: "w".repeat(MAX_CHUNK * 3) },
      { kind: "pong" },
    ]);
  });

  it("closes on a tampered frame and ignores everything after", () => {
    const { phone, host, log, wire, flush } = wiredChannels();
    phone.sendMessage("one");
    wire.toHost[0]![3]! ^= 1;
    flush();
    expect(log.hostClosed).toStrictEqual(["decrypt_failed"]);
    phone.sendMessage("two");
    flush();
    expect(log.host).toStrictEqual([]);
    expect(host.closed).toBe(true);
  });

  it("closes on a dropped frame (the next one fails to decrypt)", () => {
    const { phone, log, wire, flush } = wiredChannels();
    phone.sendMessage("one");
    wire.toHost.shift();
    phone.sendMessage("two");
    flush();
    expect(log.hostClosed).toStrictEqual(["decrypt_failed"]);
  });

  it("closes on an unknown frame type inside a valid ciphertext", () => {
    const { host, log, phoneTransport, flush } = wiredChannels();
    host.receive(encryptTransport(phoneTransport.send, Uint8Array.of(0x05)));
    flush();
    expect(log.hostClosed).toStrictEqual(["unknown_frame_type"]);
  });

  it("keeps the channel open when asked to send a message over its limit", () => {
    const { phone, log, flush } = wiredChannels();
    expectFailure(() => phone.sendMessage("a".repeat(PHONE_TO_HOST_LIMIT + 1)), "message_too_large");
    phone.sendMessage("small");
    flush();
    expect(log.host).toStrictEqual([{ kind: "message", text: "small" }]);
  });
});
