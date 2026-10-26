import { PROTOCOL_VERSION } from "@atrium/protocol";
import { toBase64Url } from "@atrium/remote-crypto";
import { describe, expect, it } from "vitest";
import { HANDSHAKE_TIMEOUT_MS, SILENCE_MS } from "../../src/remote/channel";
import { CONFIRM_TIMEOUT_MS, PAIRING_TTL_MS } from "../../src/remote/pairing";
import { awaiting, newPairing, pairDevice, serviceFixture, type ServiceFixture } from "./service-fixture";

/**
 * Ends a pairing using one explicit local action.
 * @remarks The parameterized cases assert each public rejection independently.
 * @sideEffects Cancels or declines the current pairing.
 * @param fixture - Running service.
 * @param id - Pairing being answered.
 * @param action - Local decision.
 * @returns When the decision has completed.
 */
async function endPairing(fixture: ServiceFixture, id: string, action: "decline" | "cancel"): Promise<void> {
  if (action === "decline") await fixture.service.confirmPairing(id, false);
  else fixture.service.cancelPairing();
}

describe("RemoteService through a real relay process", () => {
  it("requires key confirmation, matches SAS, persists before accepting and publishes only to watchers", async () => {
    const f = await serviceFixture();
    f.service.get("watcher", true);
    f.service.get("not-watching", false);
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr, { confirm: false });
    expect(f.service.get("observer", undefined).pairing).toMatchObject({ state: "available", request: null });
    expect(f.accepted).toStrictEqual([]);
    session.channel.sendControl({ kind: "pair_confirm" });
    await awaiting(f);
    expect(f.service.get("observer", undefined).pairing?.request).toStrictEqual({
      deviceName: "Fake iPhone",
      model: "test",
      sas: session.sas,
    });
    const gate = f.vault.pause();
    const confirming = f.service.confirmPairing(pairing.pairingId, true);
    await gate.entered;
    expect(f.accepted).toStrictEqual([]);
    expect(f.vault.contents().devices).toStrictEqual([]);
    gate.release();
    await confirming;
    const paired = await session.control(["paired"]);
    expect(paired).toStrictEqual({
      kind: "paired",
      deviceId: f.vault.contents().devices[0]?.deviceId,
      hostName: "Test Mac",
    });
    expect(f.accepted.map((item) => item.origin)).toStrictEqual([{ origin: "remote", deviceId: paired.deviceId }]);
    expect(f.events.length).toBeGreaterThan(0);
    expect(new Set(f.events.map((item) => item.id))).toStrictEqual(new Set(["watcher"]));
    f.service.unwatch("watcher");
    const count = f.events.length;
    await f.service.renameDevice(String(paired.deviceId), "Renamed");
    expect(f.events).toHaveLength(count);
  });

  it("rejects a refreshed or cancelled QR without admitting a device", async () => {
    const f = await serviceFixture();
    const old = newPairing(f);
    newPairing(f);
    await expect(f.phone().pair(old.qr)).rejects.toThrow("socket_closed");
    const current = f.service.get("observer", undefined).pairing;
    expect(current?.state).toBe("available");
    f.service.cancelPairing();
    await expect(f.phone().pair(current!.qr)).rejects.toThrow("socket_closed");
    expect(f.accepted).toStrictEqual([]);
    expect(f.vault.contents().devices).toStrictEqual([]);
  });

  it("authenticates the expired-code rejection after its five-minute deadline", async () => {
    expect(PAIRING_TTL_MS).toBe(300_000);
    const f = await serviceFixture();
    const pairing = newPairing(f);
    f.clock.advance(PAIRING_TTL_MS);
    expect(f.service.get("observer", undefined).pairing?.state).toBe("expired");
    // A large virtual-time jump intentionally also expires the relay heartbeat. Reconnect first.
    await expect.poll(() => f.service.get("observer", undefined).relay?.status).toBe("error");
    await f.service.testRelay();
    await expect(f.phone().pair(pairing.qr)).rejects.toThrow("pairing_expired");
    expect(f.accepted).toStrictEqual([]);
  });

  it.each([
    { action: "decline", reason: "rejected" },
    { action: "cancel", reason: "cancelled" },
  ] as const)("sends an authenticated rejection on $action and closes the phone", async ({ action, reason }) => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr);
    await awaiting(f);
    await endPairing(f, pairing.pairingId, action);
    expect(await session.control(["pair_rejected"])).toStrictEqual({ kind: "pair_rejected", reason });
    await session.closed;
    expect(f.accepted).toStrictEqual([]);
    expect(f.vault.contents().devices).toStrictEqual([]);
  });

  it("rejects after two minutes awaiting desktop confirmation while the phone remains alive", async () => {
    expect(CONFIRM_TIMEOUT_MS).toBe(120_000);
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr);
    await awaiting(f);
    for (let elapsed = 0; elapsed < CONFIRM_TIMEOUT_MS - 10_000; elapsed += 10_000) {
      f.clock.advance(10_000);
      session.channel.ping();
      await session.next((value) => value.kind === "pong");
    }
    f.clock.advance(10_000);
    expect(await session.control(["pair_rejected"])).toStrictEqual({ kind: "pair_rejected", reason: "timeout" });
    await session.closed;
    expect(f.service.get("observer", undefined).pairing).toMatchObject({ state: "rejected", reason: "timeout" });
    expect(f.accepted).toStrictEqual([]);
  });

  it("rejects a claimed pairing when its phone disconnects before confirmation", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr);
    await awaiting(f);
    await session.close({ terminate: true });
    await expect.poll(() => f.service.get("observer", undefined).pairing?.reason).toBe("disconnected");
    await expect(f.service.confirmPairing(pairing.pairingId, true)).rejects.toMatchObject({ code: "pairing_expired" });
    expect(f.vault.contents().devices).toStrictEqual([]);
  });

  it("lets only the first encrypted confirmation win when two phones use one QR", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const first = await f.phone({ deviceName: "First" }).pair(pairing.qr, { confirm: false });
    const second = await f.phone({ deviceName: "Second" }).pair(pairing.qr, { confirm: false });
    first.channel.sendControl({ kind: "pair_confirm" });
    await awaiting(f);
    second.channel.sendControl({ kind: "pair_confirm" });
    expect(await second.control(["pair_rejected"])).toStrictEqual({ kind: "pair_rejected", reason: "pairing_busy" });
    await second.closed;
    expect(f.service.get("observer", undefined).pairing).toMatchObject({
      refused: 1,
      request: { deviceName: "First" },
    });
    expect(() => f.service.startPairing()).toThrow("pairing_busy");
    await f.service.confirmPairing(pairing.pairingId, true);
    await first.control(["paired"]);
    expect(f.vault.contents().devices.map((device) => device.reportedName)).toStrictEqual(["First"]);
    expect(f.accepted).toHaveLength(1);
  });

  it("does not let a wrong PSK claim or consume the code", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const wrong = new URL(pairing.qr);
    wrong.searchParams.set("psk", toBase64Url(new Uint8Array(32)));
    await expect(f.phone().pair(wrong.toString())).rejects.toThrow(/^noise:/);
    expect(f.service.get("observer", undefined).pairing).toMatchObject({ state: "available", request: null });
    const good = await f.phone().pair(pairing.qr);
    await awaiting(f);
    expect(f.service.get("observer", undefined).pairing?.request?.sas).toBe(good.sas);
    expect(f.accepted).toStrictEqual([]);
  });

  it("rejects pairing and daily protocol mismatches without consuming known identity", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const phone = f.phone();
    await expect(phone.pair(pairing.qr, { protocolVersion: PROTOCOL_VERSION + 1 })).rejects.toThrow("version_mismatch");
    expect(f.service.get("observer", undefined).pairing?.state).toBe("available");
    await pairDevice(f, phone);
    await expect(phone.connect(undefined, { protocolVersion: PROTOCOL_VERSION + 1 })).rejects.toThrow(
      "version_mismatch",
    );
    expect(phone.hosts).toHaveLength(1);
    expect(f.accepted).toHaveLength(1);
  });

  it("sends host_error and never grants access when confirming cannot write the vault", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr);
    await awaiting(f);
    f.vault.failNext = true;
    await expect(f.service.confirmPairing(pairing.pairingId, true)).rejects.toMatchObject({
      code: "keychain_unavailable",
    });
    expect(await session.control(["pair_rejected"])).toStrictEqual({ kind: "pair_rejected", reason: "host_error" });
    await session.closed;
    expect(f.service.get("observer", undefined).pairing).toMatchObject({ state: "rejected", reason: "vault_failed" });
    expect(f.vault.contents().devices).toStrictEqual([]);
    expect(f.accepted).toStrictEqual([]);
  });

  it("recovers a committed pairing whose paired control was lost, using daily IK", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const pairing = newPairing(f);
    const session = await phone.pair(pairing.qr);
    await awaiting(f);
    const gate = f.vault.pause();
    const confirm = f.service.confirmPairing(pairing.pairingId, true);
    await gate.entered;
    await session.close({ terminate: true });
    await expect.poll(() => f.resources.snapshot()["remote.data"]).toBe(0);
    f.service.cancelPairing();
    expect(() => f.service.startPairing()).toThrow("pairing_busy");
    gate.release();
    await confirm;
    expect(f.accepted).toStrictEqual([]);
    expect(phone.hosts[0]?.deviceId).toBeNull();
    const daily = await phone.connect();
    expect(daily.deviceId).toBe(f.vault.contents().devices[0]?.deviceId);
    expect(phone.hosts[0]?.deviceId).toBe(daily.deviceId);
    expect(f.accepted.map((item) => item.origin)).toStrictEqual([{ origin: "remote", deviceId: daily.deviceId }]);
  });

  it("rejects an unknown key before pairing commits", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const pairing = newPairing(f);
    const session = await phone.pair(pairing.qr, { confirm: false });
    await session.close();
    await expect(phone.connect()).rejects.toThrow("device_unknown");
    expect(phone.hosts).toStrictEqual([]);
    expect(f.accepted).toStrictEqual([]);
  });

  it("revokes all channels immediately, retains a block after write failure, and allows persistence retry", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const { session, deviceId } = await pairDevice(f, phone);
    const daily = await phone.connect();
    f.vault.failNext = true;
    await expect(f.service.revokeDevice(deviceId)).rejects.toMatchObject({ code: "keychain_unavailable" });
    expect(await session.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    expect(await daily.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    await Promise.all([session.closed, daily.closed]);
    expect(f.accepted.every((item) => item.closed)).toBe(true);
    expect(f.service.get("observer", undefined).devices).toStrictEqual([]);
    expect(f.vault.contents().devices).toHaveLength(1);
    // Reuse the same static identity but recover host metadata from a new QR without committing.
    const again = newPairing(f);
    const pending = await phone.pair(again.qr, { confirm: false });
    await pending.close();
    await expect(phone.connect()).rejects.toThrow("device_unknown");
    await f.service.revokeDevice(deviceId);
    expect(f.vault.contents().devices).toStrictEqual([]);
  });

  it("reuses device identity and custom name on re-pair, supports rename reset and identity reset", async () => {
    const f = await serviceFixture();
    const phone = f.phone({ deviceName: "Reported" });
    const original = await pairDevice(f, phone);
    await f.service.renameDevice(original.deviceId, "Personal");
    expect(f.service.get("observer", undefined).devices[0]?.name).toBe("Personal");
    const repaired = await pairDevice(f, phone);
    expect(repaired.deviceId).toBe(original.deviceId);
    expect(f.vault.contents().devices).toHaveLength(1);
    expect(f.service.get("observer", undefined).devices[0]?.name).toBe("Personal");
    await f.service.renameDevice(original.deviceId, "");
    expect(f.service.get("observer", undefined).devices[0]?.name).toBe("Reported");
    const fingerprint = f.service.get("observer", undefined).hostFingerprint;
    await f.service.resetIdentity();
    expect(await original.session.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    expect(await repaired.session.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    await Promise.all([original.session.closed, repaired.session.closed]);
    expect(f.service.get("observer", undefined).hostFingerprint).not.toBe(fingerprint);
    expect(f.vault.contents().devices).toStrictEqual([]);
    expect(f.vault.contents().relay).toBe(f.relay.line);
  });

  it("never re-admits a device revoked while re-pair confirmation is writing", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const first = await pairDevice(f, phone);
    const pairing = newPairing(f);
    const pending = await phone.pair(pairing.qr);
    await awaiting(f);
    const gate = f.vault.pause();
    const confirm = f.service.confirmPairing(pairing.pairingId, true);
    await gate.entered;
    const revoke = f.service.revokeDevice(first.deviceId);
    await first.session.control(["revoked"]);
    await first.session.closed;
    gate.release();
    await Promise.all([confirm, revoke]);
    await pending.closed;
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]?.closed).toBe(true);
    expect(f.vault.contents().devices).toStrictEqual([]);
    expect(f.service.get("observer", undefined).devices).toStrictEqual([]);
    expect(pending.channel.closed).toBe(true);
  });

  it("does not admit a replacement identity when re-pair confirmation is queued between two revocations", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const original = await pairDevice(f, phone);
    const pairing = newPairing(f);
    const pending = await phone.pair(pairing.qr);
    await awaiting(f);
    const gate = f.vault.pause();
    const firstRevoke = f.service.revokeDevice(original.deviceId);
    await gate.entered;
    await original.session.control(["revoked"]);
    await original.session.closed;
    expect(f.vault.contents().devices.map((device) => device.deviceId)).toStrictEqual([original.deviceId]);
    const confirmation = f.service.confirmPairing(pairing.pairingId, true);
    const secondRevoke = f.service.revokeDevice(original.deviceId);
    gate.release();
    await Promise.all([firstRevoke, confirmation, secondRevoke]);
    expect(f.accepted.map((item) => item.origin)).toStrictEqual([{ origin: "remote", deviceId: original.deviceId }]);
    expect(f.accepted.every((item) => item.closed)).toBe(true);
    expect(f.vault.contents().devices).toStrictEqual([]);
    expect(f.service.get("observer", undefined).devices).toStrictEqual([]);
    await pending.closed;
    expect(pending.channel.closed).toBe(true);
  });

  it("caps pending handshakes at four and releases them at the ten-second deadline", async () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(10_000);
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const sessions = [];
    for (let index = 0; index < 4; index++) sessions.push(await f.phone().pair(pairing.qr, { confirm: false }));
    expect(f.resources.snapshot()["remote.data"]).toBe(4);
    await expect(f.phone().pair(pairing.qr, { confirm: false })).rejects.toThrow("socket_closed");
    f.clock.advance(HANDSHAKE_TIMEOUT_MS);
    await Promise.all(sessions.map((session) => session.closed));
    await expect.poll(() => f.resources.snapshot()["remote.data"]).toBe(0);
    expect(f.service.get("observer", undefined).pairing?.state).toBe("available");
    expect(f.accepted).toStrictEqual([]);
  });

  it("keeps at most two accepted channels and drops a silent channel after thirty seconds", async () => {
    expect(SILENCE_MS).toBe(30_000);
    const f = await serviceFixture();
    const phone = f.phone();
    const first = await pairDevice(f, phone);
    const second = await phone.connect();
    const third = await phone.connect();
    await first.session.closed;
    expect(f.accepted.map((item) => item.closed)).toStrictEqual([true, false, false]);
    f.clock.advance(SILENCE_MS - 1);
    expect(f.accepted[2]?.transport.checkAlive()).toBe(true);
    await third.next((item) => item.kind === "ping");
    third.channel.ping();
    await third.next((item) => item.kind === "pong");
    f.clock.advance(SILENCE_MS);
    expect(f.accepted[2]?.transport.checkAlive()).toBe(false);
    await third.closed;
    await second.close();
    await expect.poll(() => f.accepted.every((item) => item.closed)).toBe(true);
  });

  it("samples traffic only while watched and returns idle rates to zero", async () => {
    const f = await serviceFixture();
    const timerBaseline = f.clock.pendingTimers();
    f.service.get("traffic-watcher", true);
    const paired = await pairDevice(f, f.phone());
    expect(f.service.get("observer", undefined).devices[0]?.lastSeenAt).toBe(f.clock.now());
    paired.session.send({ type: "test-message", value: "phone payload" });
    await expect.poll(() => f.accepted[0]?.messages.length).toBe(1);
    f.accepted[0]!.transport.send(JSON.stringify({ type: "test-event", value: "host payload" }));
    expect(await paired.session.message()).toStrictEqual({ type: "test-event", value: "host payload" });
    f.clock.advance(1_000);
    const active = f.service.get("observer", undefined).devices[0]!.traffic;
    expect(active.up).toBeGreaterThan(0);
    expect(active.down).toBeGreaterThan(0);
    f.clock.advance(2_000);
    expect(f.service.get("observer", undefined).devices[0]?.traffic).toStrictEqual({ up: 0, down: 0 });
    f.service.unwatch("traffic-watcher");
    expect(f.clock.pendingTimers()).toBe(timerBaseline);
    const events = f.events.length;
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(events);
  });

  it("cancels an owned test_relay probe during close without waiting for its deadline", async () => {
    const f = await serviceFixture();
    await f.service.set(false, undefined);
    // Pause only the fixture's child: the real relay cannot finish the probe's HTTP upgrade.
    process.kill(f.relay.pid, "SIGSTOP");
    let closing: Promise<void> | undefined;
    try {
      const probe = f.service.testRelay().catch((error: unknown) => error);
      await expect.poll(() => f.resources.snapshot()["remote.control"]).toBe(1);
      let closed = false;
      closing = f.service.close().then(() => {
        closed = true;
        return undefined;
      });
      await expect.poll(() => closed).toBe(true);
      expect(await probe).toMatchObject({ code: "relay_unreachable" });
      expect(f.clock.pendingTimers()).toBe(0);
      expect(Object.values(f.resources.snapshot()).every((count) => count === 0)).toBe(true);
    } finally {
      process.kill(f.relay.pid, "SIGCONT");
      await closing;
    }
  });

  it("owns every data socket through shutdown and cannot accept a late confirmation", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr);
    await awaiting(f);
    const gate = f.vault.pause();
    const confirm = f.service.confirmPairing(pairing.pairingId, true);
    await gate.entered;
    const closing = f.service.close();
    await session.closed;
    await expect.poll(() => Object.values(f.resources.snapshot()).every((count) => count === 0)).toBe(true);
    gate.release();
    await Promise.all([confirm, closing]);
    expect(f.accepted).toStrictEqual([]);
  });
});
