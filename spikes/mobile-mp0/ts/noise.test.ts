import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromHex, toHex, utf8 } from "./bytes.ts";
import {
  decryptTransport,
  encryptTransport,
  generateKeyPair,
  HandshakeState,
  keyPairFrom,
  MAX_HANDSHAKE_PAYLOAD,
  MAX_MESSAGE,
  MAX_TRANSPORT_PLAINTEXT,
  NoiseError,
  type NoiseFailure,
  type Pattern,
  type Transport,
} from "./noise.ts";

const VECTORS_FILE = new URL("vectors/cacophony.txt", import.meta.url);
const VECTORS_SHA256 = "3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae";

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_static: string;
  resp_ephemeral: string;
  resp_psks?: string[];
  handshake_hash: string;
  messages: { payload: string; ciphertext: string }[];
}

/**
 * The single cacophony vector of a pattern.
 *
 * @sideEffects Reads the vectors file.
 * @param pattern - IK or IKpsk2.
 * @returns The vector.
 */
function vectorOf(pattern: Pattern): Vector {
  const text = readFileSync(VECTORS_FILE);
  expect(createHash("sha256").update(text).digest("hex")).toBe(VECTORS_SHA256);
  const name = `Noise_${pattern}_25519_ChaChaPoly_SHA256`;
  const matches = (JSON.parse(text.toString("utf8")) as { vectors: Vector[] }).vectors.filter(
    (vector) => vector.protocol_name === name,
  );
  expect(matches).toHaveLength(1);
  return matches[0] as Vector;
}

/**
 * Asserts that a call throws a NoiseError with a reason.
 *
 * @sideEffects Runs the call.
 * @param run - The call.
 * @param reason - The expected reason.
 */
function expectFailure(run: () => unknown, reason: NoiseFailure): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(NoiseError);
  expect((thrown as NoiseError).reason).toBe(reason);
}

const prologue = utf8("atrium-test");

/**
 * Starts both sides of a handshake with fresh keys.
 *
 * @sideEffects Reads the random source.
 * @param pattern - IK or IKpsk2.
 * @param psk - The PSK for IKpsk2; the responder can be given a different one.
 * @param responderPsk - The responder's PSK, when it should differ.
 * @returns Both states.
 */
function pair(pattern: Pattern, psk?: Uint8Array, responderPsk = psk) {
  const phone = generateKeyPair();
  const host = generateKeyPair();
  const initiator = HandshakeState.initiator({
    pattern,
    prologue,
    staticKey: phone,
    remoteStatic: host.publicKey,
    ...(psk === undefined ? {} : { psk }),
  });
  const responder = HandshakeState.responder({
    pattern,
    prologue,
    staticKey: host,
    ...(responderPsk === undefined ? {} : { psk: responderPsk }),
  });
  return { initiator, responder, phone, host };
}

/**
 * Runs a whole IK handshake with fresh keys.
 *
 * @sideEffects Reads the random source.
 * @returns Both transports.
 */
function connected(): { phone: Transport; host: Transport } {
  const { initiator, responder } = pair("IK");
  responder.readMessage(initiator.writeMessage(utf8("{}")));
  initiator.readMessage(responder.writeMessage(utf8("{}")));
  return { phone: initiator.finish(), host: responder.finish() };
}

describe("cacophony vectors", () => {
  for (const pattern of ["IK", "IKpsk2"] as const) {
    it(`matches ${pattern} byte for byte: two handshake messages, four transport messages, h`, () => {
      const vector = vectorOf(pattern);
      const psk = vector.init_psks?.[0];
      const initiator = HandshakeState.initiator(
        {
          pattern,
          prologue: fromHex(vector.init_prologue),
          staticKey: keyPairFrom(fromHex(vector.init_static)),
          remoteStatic: fromHex(vector.init_remote_static),
          ...(psk === undefined ? {} : { psk: fromHex(psk) }),
        },
        { ephemeral: keyPairFrom(fromHex(vector.init_ephemeral)) },
      );
      const responderPsk = vector.resp_psks?.[0];
      const responder = HandshakeState.responder(
        {
          pattern,
          prologue: fromHex(vector.init_prologue),
          staticKey: keyPairFrom(fromHex(vector.resp_static)),
          ...(responderPsk === undefined ? {} : { psk: fromHex(responderPsk) }),
        },
        { ephemeral: keyPairFrom(fromHex(vector.resp_ephemeral)) },
      );
      const [first, second, ...transport] = vector.messages;
      expect(transport).toHaveLength(4);

      const message1 = initiator.writeMessage(fromHex(first!.payload));
      expect(toHex(message1)).toBe(first!.ciphertext);
      expect(toHex(responder.readMessage(message1))).toBe(first!.payload);
      const message2 = responder.writeMessage(fromHex(second!.payload));
      expect(toHex(message2)).toBe(second!.ciphertext);
      expect(toHex(initiator.readMessage(message2))).toBe(second!.payload);

      const phone = initiator.finish();
      const host = responder.finish();
      expect(toHex(phone.handshakeHash)).toBe(vector.handshake_hash);
      expect(toHex(host.handshakeHash)).toBe(vector.handshake_hash);
      expect(toHex(host.remoteStatic)).toBe(toHex(keyPairFrom(fromHex(vector.init_static)).publicKey));

      // After the handshake the vector keeps alternating: initiator, responder, initiator, responder.
      transport.forEach((message, index) => {
        const [sender, receiver] = index % 2 === 0 ? [phone, host] : [host, phone];
        const ciphertext = encryptTransport(sender.send, fromHex(message.payload));
        expect(toHex(ciphertext)).toBe(message.ciphertext);
        expect(toHex(decryptTransport(receiver.receive, ciphertext))).toBe(message.payload);
      });
    });
  }
});

describe("handshake failures", () => {
  it("refuses a tampered message 1 and is dead afterwards", () => {
    const { initiator, responder } = pair("IK");
    const message = initiator.writeMessage(utf8("{}"));
    message[40]! ^= 1; // inside the encrypted static key
    expectFailure(() => responder.readMessage(message), "decrypt_failed");
    expectFailure(() => responder.writeMessage(utf8("{}")), "dead");
    expectFailure(() => responder.finish(), "dead");
  });

  it("refuses a tampered message 2 on the phone", () => {
    const { initiator, responder } = pair("IK");
    responder.readMessage(initiator.writeMessage(utf8("{}")));
    const message = responder.writeMessage(utf8("{}"));
    message[message.length - 1]! ^= 0x80;
    expectFailure(() => initiator.readMessage(message), "decrypt_failed");
    expectFailure(() => initiator.finish(), "dead");
  });

  it("aborts on every low-order ephemeral key in message 1", () => {
    const lowOrder = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for (const point of lowOrder) {
      const { initiator, responder } = pair("IK");
      const message = initiator.writeMessage(utf8("{}"));
      message.set(fromHex(point), 0);
      expectFailure(() => responder.readMessage(message), "low_order_key");
      expectFailure(() => responder.writeMessage(utf8("{}")), "dead");
    }
  });

  it("aborts when the host key from the QR code is low-order", () => {
    const initiator = HandshakeState.initiator({
      pattern: "IK",
      prologue,
      staticKey: generateKeyPair(),
      remoteStatic: new Uint8Array(32),
    });
    expectFailure(() => initiator.writeMessage(utf8("{}")), "low_order_key");
  });

  it("refuses handshake messages over 65535 bytes and payloads over 1 KiB", () => {
    const tooLong = pair("IK");
    expectFailure(() => tooLong.responder.readMessage(new Uint8Array(MAX_MESSAGE + 1)), "message_too_long");

    const bigPayload = pair("IK");
    expectFailure(
      () => bigPayload.initiator.writeMessage(new Uint8Array(MAX_HANDSHAKE_PAYLOAD + 1)),
      "payload_too_long",
    );
    expectFailure(() => bigPayload.initiator.writeMessage(new Uint8Array(1)), "dead");

    // Read side: 32 (e) + 48 (s) + 1025 + 16 (tag) is refused before decrypting.
    const bigRead = pair("IK");
    expectFailure(
      () => bigRead.responder.readMessage(new Uint8Array(96 + MAX_HANDSHAKE_PAYLOAD + 1)),
      "payload_too_long",
    );

    // Exactly 1 KiB is fine.
    const limit = pair("IK");
    const payload = new Uint8Array(MAX_HANDSHAKE_PAYLOAD).fill(0x61);
    expect(limit.responder.readMessage(limit.initiator.writeMessage(payload))).toStrictEqual(payload);
  });

  it("refuses a message 1 too short to hold e and s", () => {
    const { responder } = pair("IK");
    expectFailure(() => responder.readMessage(new Uint8Array(95)), "message_too_short");
  });

  it("refuses calls out of turn", () => {
    const { initiator, responder } = pair("IK");
    expectFailure(() => responder.writeMessage(utf8("{}")), "wrong_turn");
    expectFailure(() => initiator.finish(), "wrong_turn");
  });

  it("fails when the prologues differ", () => {
    const host = generateKeyPair();
    const initiator = HandshakeState.initiator({
      pattern: "IK",
      prologue: utf8("a"),
      staticKey: generateKeyPair(),
      remoteStatic: host.publicKey,
    });
    const responder = HandshakeState.responder({ pattern: "IK", prologue: utf8("b"), staticKey: host });
    expectFailure(() => responder.readMessage(initiator.writeMessage(utf8("{}"))), "decrypt_failed");
  });

  it("fails when one side runs IK and the other IKpsk2", () => {
    const host = generateKeyPair();
    const initiator = HandshakeState.initiator({
      pattern: "IKpsk2",
      prologue,
      staticKey: generateKeyPair(),
      remoteStatic: host.publicKey,
      psk: new Uint8Array(32).fill(7),
    });
    const responder = HandshakeState.responder({ pattern: "IK", prologue, staticKey: host });
    expectFailure(() => responder.readMessage(initiator.writeMessage(utf8("{}"))), "decrypt_failed");
  });

  it("with the wrong PSK, the host reads message 1 fine and only the key confirmation fails", () => {
    // Why SPEC-0005 adds `pair_confirm`: the PSK is mixed in at the end of message 2.
    const { initiator, responder } = pair("IKpsk2", new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    expect(responder.readMessage(initiator.writeMessage(utf8("{}")))).toStrictEqual(utf8("{}"));
    const message2 = responder.writeMessage(utf8("{}"));
    const host = responder.finish();
    expectFailure(() => initiator.readMessage(message2), "decrypt_failed");

    // A phone that skips its check and sends the confirmation anyway is caught by the host.
    const { initiator: liar, responder: honest } = pair(
      "IKpsk2",
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
    );
    honest.readMessage(liar.writeMessage(utf8("{}")));
    honest.writeMessage(utf8("{}"));
    const hostSide = honest.finish();
    expectFailure(() => decryptTransport(hostSide.receive, encryptTransport(host.send, utf8("x"))), "decrypt_failed");
  });
});

describe("transport failures", () => {
  it("refuses a tampered message and stays dead even for good ones", () => {
    const { phone, host } = connected();
    const good = encryptTransport(phone.send, utf8("one"));
    const tampered = good.slice();
    tampered[0]! ^= 1;
    expectFailure(() => decryptTransport(host.receive, tampered), "decrypt_failed");
    expectFailure(() => decryptTransport(host.receive, good), "dead");
  });

  it("refuses a replayed message", () => {
    const { phone, host } = connected();
    const message = encryptTransport(phone.send, utf8("one"));
    expect(decryptTransport(host.receive, message)).toStrictEqual(utf8("one"));
    expectFailure(() => decryptTransport(host.receive, message), "decrypt_failed");
  });

  it("refuses messages out of order", () => {
    const { phone, host } = connected();
    encryptTransport(phone.send, utf8("one"));
    const second = encryptTransport(phone.send, utf8("two"));
    expectFailure(() => decryptTransport(host.receive, second), "decrypt_failed");
  });

  it("refuses a message sent in the other direction back to its sender", () => {
    const { phone } = connected();
    const message = encryptTransport(phone.send, utf8("one"));
    expectFailure(() => decryptTransport(phone.receive, message), "decrypt_failed");
  });

  it("refuses sizes outside 16..65535 and plaintexts over 65519, and dies", () => {
    const { phone, host } = connected();
    expectFailure(() => encryptTransport(phone.send, new Uint8Array(MAX_TRANSPORT_PLAINTEXT + 1)), "message_too_long");
    expectFailure(() => encryptTransport(phone.send, utf8("x")), "dead");
    expectFailure(() => decryptTransport(host.receive, new Uint8Array(MAX_MESSAGE + 1)), "message_too_long");
    const other = connected();
    expectFailure(() => decryptTransport(other.host.receive, new Uint8Array(15)), "message_too_short");
    expectFailure(() => decryptTransport(other.host.receive, encryptTransport(other.phone.send, utf8("x"))), "dead");
    // The largest plaintext fits exactly in the largest message.
    const third = connected();
    const largest = encryptTransport(third.phone.send, new Uint8Array(MAX_TRANSPORT_PLAINTEXT));
    expect(largest).toHaveLength(MAX_MESSAGE);
    expect(decryptTransport(third.host.receive, largest)).toHaveLength(MAX_TRANSPORT_PLAINTEXT);
  });

  it("closes when the nonce reaches 2^64 - 1", () => {
    const { phone } = connected();
    phone.send.setNonceForTest(2n ** 64n - 2n);
    encryptTransport(phone.send, utf8("last"));
    expectFailure(() => encryptTransport(phone.send, utf8("one more")), "nonce_exhausted");
    expectFailure(() => encryptTransport(phone.send, utf8("again")), "dead");
  });
});
