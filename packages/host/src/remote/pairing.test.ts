import { FakeClock } from "@atrium/testkit";
import type { RemotePairing } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { ResourceTracker } from "../platform/resources";
import { CONFIRM_TIMEOUT_MS, PAIRING_TTL_MS, PairingMachine } from "./pairing";

/** Builds a deterministic pairing fixture. @remarks No network. @sideEffects none */
function fixture() {
  const clock = new FakeClock(0);
  const resources = new ResourceTracker();
  const ends: unknown[] = [];
  const changes: (RemotePairing | null)[] = [];
  const machine: PairingMachine<string> = new PairingMachine<string>({
    clock,
    resources,
    onChange: () => {
      changes.push(machine.view());
    },
    onEnded: (end) => ends.push(end),
  });
  const pairing = { pairingId: "pair_0123456789abcdef", psk: new Uint8Array(32), qr: "atrium://pair?test" };
  const claim = { deviceName: "phone", model: "model", sas: "123456", publicKey: "key", stream: "stream" };
  machine.start(pairing);
  return { clock, resources, ends, changes, machine, pairing, claim };
}

/**
 * Projects the changing fields of published snapshots.
 * @remarks Static QR fields are asserted by the expiry and claim tests.
 * @sideEffects none
 * @param values - Published snapshots.
 * @returns State, reason and refused count for each notification.
 */
function transitions(values: readonly (RemotePairing | null)[]): unknown[] {
  return values.map((value) => (value === null ? null : [value.state, value.reason, value.refused]));
}

describe("PairingMachine", () => {
  it("publishes each visible transition and leaves empty-state operations harmless", () => {
    const f = fixture();
    f.machine.claim(f.pairing.pairingId, f.claim);
    f.machine.claim(f.pairing.pairingId, { ...f.claim, stream: "other" });
    f.machine.answer(f.pairing.pairingId, true);
    f.machine.committed();
    f.machine.failed();
    f.machine.disconnected("stream");
    f.machine.cancel();
    expect(transitions(f.changes)).toStrictEqual([
      ["available", null, 0],
      ["awaiting_confirmation", null, 0],
      ["awaiting_confirmation", null, 1],
      ["committed", null, 1],
      null,
    ]);
    const count = f.changes.length;
    expect(f.machine.pskOf(f.pairing.pairingId)).toBeNull();
    expect(f.machine.claim(f.pairing.pairingId, f.claim)).toBe("pairing_expired");
    expect(f.machine.answer(f.pairing.pairingId, true)).toBeNull();
    expect(f.machine.check()).toBe("pairing_expired");
    f.machine.committed();
    f.machine.failed();
    f.machine.cancel();
    f.machine.dispose();
    expect(f.changes).toHaveLength(count);
    expect(f.ends).toStrictEqual([]);
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it("publishes failed confirmation and permits a fresh code afterwards", () => {
    const f = fixture();
    f.machine.claim(f.pairing.pairingId, f.claim);
    f.machine.answer(f.pairing.pairingId, true);
    f.machine.failed();
    expect(f.changes.map((value) => [value?.state, value?.reason])).toStrictEqual([
      ["available", null],
      ["awaiting_confirmation", null],
      ["rejected", "vault_failed"],
    ]);
    expect(f.machine.start(f.pairing)).toBe(true);
    f.machine.cancel();
    expect(transitions(f.changes.slice(3))).toStrictEqual([["available", null, 0], ["rejected", "cancelled", 0], null]);
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it("disposes active and confirmed pairings but never rewrites a terminal result", () => {
    const available = fixture();
    available.machine.dispose();
    expect(available.changes.at(-1)).toMatchObject({ state: "rejected", reason: "cancelled" });
    expect(available.machine.view()).toBeNull();
    expect(available.ends).toStrictEqual([]);
    expect(available.resources.snapshot()).toStrictEqual({ timer: 0 });
    const confirming = fixture();
    confirming.machine.claim(confirming.pairing.pairingId, confirming.claim);
    confirming.machine.answer(confirming.pairing.pairingId, true);
    confirming.machine.dispose();
    expect(confirming.changes.at(-1)).toMatchObject({ state: "rejected", reason: "cancelled" });
    expect(confirming.machine.view()).toBeNull();
    expect(confirming.ends).toStrictEqual([{ stream: "stream", reason: "cancelled" }]);
    expect(confirming.resources.snapshot()).toStrictEqual({ timer: 0 });
    const committed = fixture();
    committed.machine.claim(committed.pairing.pairingId, committed.claim);
    committed.machine.answer(committed.pairing.pairingId, true);
    committed.machine.committed();
    const count = committed.changes.length;
    committed.machine.dispose();
    expect(committed.changes).toHaveLength(count);
    expect(committed.machine.view()).toBeNull();
    expect(committed.ends).toStrictEqual([]);
    expect(committed.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it("checks expiry before timer dispatch and never revives an expired code after clock rollback", () => {
    const timers = new FakeClock();
    let now = 0;
    const resources = new ResourceTracker();
    const machine = new PairingMachine<string>({
      clock: { now: () => now, setTimeout: (callback, ms) => timers.setTimeout(callback, ms) },
      resources,
      onChange: () => {},
      onEnded: () => {},
    });
    machine.start({ pairingId: "pair_0123456789abcdef", psk: new Uint8Array(32), qr: "qr" });
    now = PAIRING_TTL_MS - 1;
    expect(machine.check()).toBe("ok");
    now++;
    expect(machine.view()?.state).toBe("available");
    expect(machine.check()).toBe("pairing_expired");
    timers.advance(PAIRING_TTL_MS);
    now = 0;
    expect(machine.view()?.state).toBe("expired");
    expect(machine.check()).toBe("pairing_expired");
    machine.dispose();
    expect(resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it("refreshes an unclaimed code without letting its old deadline expire the replacement", () => {
    const f = fixture();
    f.clock.advance(1000);
    const replacement = {
      pairingId: "pair_fedcba9876543210",
      psk: new Uint8Array(32).fill(9),
      qr: "atrium://pair?fresh",
    };
    expect(f.machine.start(replacement)).toBe(true);
    expect(f.machine.view()).toStrictEqual({
      pairingId: replacement.pairingId,
      qr: replacement.qr,
      expiresAt: PAIRING_TTL_MS + 1000,
      state: "available",
      handshaking: false,
      reason: null,
      request: null,
      refused: 0,
    });
    expect(f.machine.pskOf(f.pairing.pairingId)).toBeNull();
    expect(f.machine.pskOf(replacement.pairingId)).toStrictEqual(replacement.psk);
    expect(f.machine.claim(f.pairing.pairingId, f.claim)).toBe("pairing_expired");
    expect(f.machine.answer(replacement.pairingId, true)).toBeNull();
    expect(f.resources.snapshot()).toStrictEqual({ timer: 1 });
    f.clock.advance(PAIRING_TTL_MS - 1000);
    expect(f.machine.check()).toBe("ok");
    expect(f.machine.view()?.state).toBe("available");
    expect(f.ends).toStrictEqual([]);
    f.machine.cancel();
    f.clock.advance(1000);
    expect(f.machine.view()).toBeNull();
    expect(f.machine.check()).toBe("pairing_expired");
    expect(f.machine.pskOf(replacement.pairingId)).toBeNull();
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

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
