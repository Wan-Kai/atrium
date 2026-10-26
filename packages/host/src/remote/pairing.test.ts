import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { ResourceTracker } from "../platform/resources";
import { CONFIRM_TIMEOUT_MS, PAIRING_TTL_MS, PairingMachine } from "./pairing";

/** Builds a deterministic pairing fixture. @remarks No network. @sideEffects none */
function fixture() {
  const clock = new FakeClock(0);
  const resources = new ResourceTracker();
  const ends: unknown[] = [];
  const machine = new PairingMachine<string>({
    clock,
    resources,
    onChange: () => {},
    onEnded: (end) => ends.push(end),
  });
  const pairing = { pairingId: "pair_0123456789abcdef", psk: new Uint8Array(32), qr: "atrium://pair?test" };
  const claim = { deviceName: "phone", model: "model", sas: "123456", publicKey: "key", stream: "stream" };
  machine.start(pairing);
  return { clock, resources, ends, machine, pairing, claim };
}

describe("PairingMachine", () => {
  it("expires an unused code exactly at its deadline", () => {
    const f = fixture();
    expect(f.machine.pskOf("wrong")).toBeNull();
    expect(f.machine.pskOf(f.pairing.pairingId)).toStrictEqual(f.pairing.psk);
    f.clock.advance(PAIRING_TTL_MS - 1);
    expect(f.machine.check()).toBe("ok");
    f.clock.advance(1);
    expect(f.machine.view()).toMatchObject({ state: "expired", reason: null, request: null, refused: 0 });
    expect(f.machine.claim(f.pairing.pairingId, f.claim)).toBe("pairing_expired");
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it("keeps an awaiting phone busy past the QR expiry and counts competing confirmations", () => {
    const f = fixture();
    f.clock.advance(PAIRING_TTL_MS - 1);
    expect(f.machine.claim("wrong", f.claim)).toBe("pairing_expired");
    expect(f.machine.claim(f.pairing.pairingId, f.claim)).toBe("ok");
    f.clock.advance(1);
    expect(f.machine.check()).toBe("pairing_busy");
    expect(f.machine.claim(f.pairing.pairingId, { ...f.claim, stream: "other" })).toBe("pairing_busy");
    expect(f.machine.view()).toMatchObject({ state: "awaiting_confirmation", refused: 1, request: { sas: "123456" } });
    expect(f.machine.start(f.pairing)).toBe(false);
    f.clock.advance(CONFIRM_TIMEOUT_MS - 1);
    expect(f.machine.view()).toMatchObject({ state: "rejected", reason: "timeout" });
    expect(f.ends).toStrictEqual([{ stream: "stream", reason: "timeout" }]);
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it.each([
    { result: "committed", state: "committed", reason: null },
    { result: "failed", state: "rejected", reason: "vault_failed" },
  ] as const)("lets only the vault decide after acceptance: $result", ({ result, state, reason }) => {
    const f = fixture();
    f.machine.claim(f.pairing.pairingId, f.claim);
    expect(f.machine.answer("wrong", true)).toBeNull();
    expect(f.machine.answer(f.pairing.pairingId, true)).toStrictEqual(f.claim);
    expect(f.machine.answer(f.pairing.pairingId, true)).toBeNull();
    f.machine.cancel();
    f.machine.disconnected("stream");
    f.clock.advance(PAIRING_TTL_MS);
    expect(f.machine.view()?.state).toBe("awaiting_confirmation");
    f.machine[result]();
    expect(f.machine.view()).toMatchObject({
      state,
      reason,
    });
    expect(f.ends).toStrictEqual([]);
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it.each([
    { reason: "declined", act: (f: ReturnType<typeof fixture>) => f.machine.answer(f.pairing.pairingId, false) },
    { reason: "disconnected", act: (f: ReturnType<typeof fixture>) => f.machine.disconnected("stream") },
    { reason: "cancelled", act: (f: ReturnType<typeof fixture>) => f.machine.cancel() },
  ])("ends a claimed pairing: $reason", ({ reason, act }) => {
    const f = fixture();
    f.machine.claim(f.pairing.pairingId, f.claim);
    f.machine.disconnected("other");
    expect(f.machine.view()?.state).toBe("awaiting_confirmation");
    act(f);
    expect(f.ends).toStrictEqual([{ stream: "stream", reason }]);
    expect(f.machine.answer(f.pairing.pairingId, true)).toBeNull();
    f.machine.cancel();
    expect(f.machine.view()).toBeNull();
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });
});
