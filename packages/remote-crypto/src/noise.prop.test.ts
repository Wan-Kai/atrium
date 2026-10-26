import fc from "fast-check";
import { FakeClock, present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes";
import { FrameReader } from "./framing";
import { decryptTransport, encryptTransport, generateKeyPair, HandshakeState, NoiseError } from "./noise";
import { ChannelError, parseFirstFrame, PHONE_TO_HOST_LIMIT } from "./wire";

/**
 * Runs a call and says how it failed, if it did.
 *
 * @remarks
 * Malformed input must only ever fail with the package's own errors, never crash otherwise.
 *
 * @sideEffects Runs the call.
 * @param run - The call.
 * @returns "ok", "refused" for a Noise or wire error, or the other error.
 */
function outcome(run: () => unknown): unknown {
  try {
    run();
    return "ok";
  } catch (error) {
    return error instanceof NoiseError || error instanceof ChannelError ? "refused" : error;
  }
}

const host = generateKeyPair();

describe("fuzzing", () => {
  it.each([
    ["IK", {}],
    ["IKpsk2", { psk: new Uint8Array(32) }],
  ] as const)("refuses any random message 1 of %s with its own error", (pattern, psk) => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (message) => {
        const responder = HandshakeState.responder({ pattern, prologue: utf8("p"), staticKey: host, ...psk });
        expect(outcome(() => responder.readMessage(message))).toBe("refused");
      }),
    );
  });

  it("refuses every message 1 with one byte changed", () => {
    const phone = generateKeyPair();
    const make = () =>
      HandshakeState.initiator(
        { pattern: "IK", prologue: utf8("p"), staticKey: phone, remoteStatic: host.publicKey },
        { ephemeral: phone },
      ).writeMessage(utf8('{"kind":"connect"}'));
    const message = make();
    fc.assert(
      fc.property(fc.nat({ max: message.length - 1 }), fc.integer({ min: 1, max: 255 }), (at, flip) => {
        const changed = make();
        changed.set([present(changed[at], "the byte") ^ flip], at);
        const responder = HandshakeState.responder({ pattern: "IK", prologue: utf8("p"), staticKey: host });
        expect(outcome(() => responder.readMessage(changed))).toBe("refused");
      }),
    );
  });

  it("refuses random transport ciphertexts", () => {
    const phone = generateKeyPair();
    const initiator = HandshakeState.initiator({
      pattern: "IK",
      prologue: utf8("p"),
      staticKey: phone,
      remoteStatic: host.publicKey,
    });
    const responder = HandshakeState.responder({ pattern: "IK", prologue: utf8("p"), staticKey: host });
    responder.readMessage(initiator.writeMessage(utf8("{}")));
    initiator.readMessage(responder.writeMessage(utf8("{}")));
    const sides = { phone: initiator.finish(), host: responder.finish() };
    // A real one first, so the counter is not at 0.
    decryptTransport(sides.host.receive, encryptTransport(sides.phone.send, utf8("x")));
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (ciphertext) => {
        const fresh = HandshakeState.responder({ pattern: "IK", prologue: utf8("p"), staticKey: host });
        expect(outcome(() => fresh.readMessage(ciphertext))).toBe("refused");
      }),
    );
  });

  it("only ever accepts or refuses random first frames and plaintexts", () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 8 }), (frames) => {
        const clock = new FakeClock();
        const reader = new FrameReader(PHONE_TO_HOST_LIMIT, clock, () => {});
        for (const frame of frames) {
          expect(["ok", "refused"]).toContain(outcome(() => parseFirstFrame(frame)));
          expect(["ok", "refused"]).toContain(outcome(() => reader.push(frame)));
        }
        reader.dispose();
        expect(clock.pendingTimers()).toBe(0);
      }),
    );
  });
});
