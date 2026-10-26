import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes";
import type { Received } from "./framing";
import { encryptTransport, generateKeyPair, HandshakeState } from "./noise";
import { SecureChannel } from "./secure-channel";
import {
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
  const hostChannel = new SecureChannel(responder.finish(), {
    write: (bytes) => wire.toPhone.push(bytes),
    sendLimit: HOST_TO_PHONE_LIMIT,
    receiveLimit: PHONE_TO_HOST_LIMIT,
    onReceive: (received) => log.host.push(received),
    onClose: (reason) => log.hostClosed.push(reason),
    clock,
  });
  const flush = () => {
    while (wire.toHost.length > 0 || wire.toPhone.length > 0) {
      for (const bytes of wire.toHost.splice(0)) hostChannel.receive(bytes);
      for (const bytes of wire.toPhone.splice(0)) phone.receive(bytes);
    }
  };
  return { phone, host: hostChannel, log, wire, flush, phoneTransport, clock };
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
});
