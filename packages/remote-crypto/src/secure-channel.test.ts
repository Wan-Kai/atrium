import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes";
import type { Clock, Received } from "./framing";
import { decryptTransport, encryptTransport, generateKeyPair, HandshakeState } from "./noise";
import { SecureChannel } from "./secure-channel";
import {
  CHUNK_TIMEOUT_MS,
  ChannelError,
  type ChannelFailure,
  HOST_TO_PHONE_LIMIT,
  MAX_CHUNK,
  PHONE_TO_HOST_LIMIT,
  prologue,
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
 * Two channels over a finished IK handshake, wired to each other in memory.
 *
 * @remarks
 * The host's channel schedules its chunk timeout on `hostClock`; both default to one fake clock.
 *
 * @sideEffects Reads the random source.
 * @param hostClock - The host channel's clock, when a test needs a different one.
 * @returns Both channels, both transports and what each received.
 */
function wiredChannels(hostClock?: Clock) {
  const host = generateKeyPair();
  const initiator = HandshakeState.initiator({
    pattern: "IK",
    prologue: prologue("hst_0"),
    staticKey: generateKeyPair(),
    remoteStatic: host.publicKey,
  });
  const responder = HandshakeState.responder({ pattern: "IK", prologue: prologue("hst_0"), staticKey: host });
  const clock = new FakeClock();
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
    clock,
  });
  const hostTransport = responder.finish();
  const hostChannel = new SecureChannel(hostTransport, {
    write: (bytes) => wire.toPhone.push(bytes),
    sendLimit: HOST_TO_PHONE_LIMIT,
    receiveLimit: PHONE_TO_HOST_LIMIT,
    onReceive: (received) => log.host.push(received),
    onClose: (reason) => log.hostClosed.push(reason),
    clock: hostClock ?? clock,
  });
  const flush = () => {
    while (wire.toHost.length > 0 || wire.toPhone.length > 0) {
      for (const bytes of wire.toHost.splice(0)) hostChannel.receive(bytes);
      for (const bytes of wire.toPhone.splice(0)) phone.receive(bytes);
    }
  };
  return { phone, host: hostChannel, log, wire, flush, phoneTransport, hostTransport, clock };
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
    expect(failureOf(() => phone.sendMessage("a".repeat(PHONE_TO_HOST_LIMIT + 1)))).toBe("message_too_large");
    phone.sendMessage("small");
    flush();
    expect(log.host).toStrictEqual([{ kind: "message", text: "small" }]);
  });

  it("closes when a chunked message stays incomplete for 30 seconds", () => {
    const { host, log, phoneTransport, clock } = wiredChannels();
    host.receive(encryptTransport(phoneTransport.send, Uint8Array.of(0x01, 0x61)));
    clock.advance(CHUNK_TIMEOUT_MS - 1);
    expect(log.hostClosed).toStrictEqual([]);
    clock.advance(1);
    expect(log.hostClosed).toStrictEqual(["chunk_timeout"]);
    expect(host.closed).toBe(true);
  });

  it("closes once, stops the chunk timer, kills both ciphers and drops later sends", () => {
    const { host, log, wire, phoneTransport, hostTransport, clock } = wiredChannels();
    host.receive(encryptTransport(phoneTransport.send, Uint8Array.of(0x01, 0x61)));
    expect(clock.pendingTimers()).toBe(1);
    host.close("revoked");
    host.close("again");
    expect(log.hostClosed).toStrictEqual(["revoked"]);
    expect(host.closed).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
    expect(() => encryptTransport(hostTransport.send, utf8("x"))).toThrow("noise: dead");
    expect(() => decryptTransport(hostTransport.receive, encryptTransport(phoneTransport.send, utf8("x")))).toThrow(
      "noise: dead",
    );
    host.sendMessage("late");
    host.ping();
    expect(wire.toPhone).toStrictEqual([]);
  });

  it("closes with nonce_exhausted when the send counter runs out, writing nothing", () => {
    const { phone, log, wire, phoneTransport } = wiredChannels();
    phoneTransport.send.setNonceForTest(2n ** 64n - 1n);
    phone.ping();
    expect(wire.toHost).toStrictEqual([]);
    expect(log.phoneClosed).toStrictEqual(["nonce_exhausted"]);
    expect(phone.closed).toBe(true);
  });

  it("closes with the reason error when something other than Noise or framing throws", () => {
    const brokenClock: Clock = {
      now: () => 0,
      setTimeout: () => {
        throw new Error("clock stopped");
      },
    };
    const { host, log, phoneTransport } = wiredChannels(brokenClock);
    host.receive(encryptTransport(phoneTransport.send, Uint8Array.of(0x01, 0x61)));
    expect(log.hostClosed).toStrictEqual(["error"]);
  });
});
