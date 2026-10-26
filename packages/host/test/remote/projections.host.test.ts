import { PROTOCOL_VERSION } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { HANDSHAKE_TIMEOUT_MS } from "../../src/remote/channel";
import { PAIRING_TTL_MS } from "../../src/remote/pairing";
import { awaiting, newPairing, pairDevice, serviceFixture, type ServiceFixture } from "./service-fixture";

/** Ends candidate activity through a local command. @remarks Tests retain the public lifecycle paths rather than manipulate candidate state. @sideEffects Cancels pairing or closes remote resources. */
async function endCandidate(f: ServiceFixture, action: "cancel" | "off" | "reset"): Promise<void> {
  if (action === "cancel") f.service.cancelPairing();
  else if (action === "off") await f.service.set(false, undefined);
  else await f.service.resetIdentity();
}

describe("protocol 27 local remote projections", () => {
  it("publishes finished live and off-probe diagnostics and clears them on generation changes", async () => {
    const f = await serviceFixture();
    f.service.get("watcher", true);
    expect(f.service.get("local", undefined).relay?.diagnostics).toStrictEqual({
      kind: "connect",
      checkedAt: f.clock.now(),
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "passed",
      failure: null,
    });
    f.clock.advance(1);
    expect(await f.service.testRelay()).toStrictEqual({});
    expect(f.events.at(-1)?.event.remote.relay?.diagnostics).toStrictEqual({
      kind: "live",
      checkedAt: f.clock.now(),
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: null,
    });
    await f.service.set(false, undefined);
    expect(f.service.get("local", undefined).relay?.diagnostics).toBeNull();
    expect(await f.service.testRelay()).toStrictEqual({});
    expect(f.events.at(-1)?.event.remote.relay).toMatchObject({
      status: "off",
      diagnostics: { kind: "connect", token: "passed", checkedAt: f.clock.now() },
    });
    await f.service.resetIdentity();
    expect(f.service.get("local", undefined).relay?.diagnostics).toBeNull();
    await f.service.testRelay();
    await f.service.set(false, f.relay.line);
    expect(f.service.get("local", undefined).relay?.diagnostics).toBeNull();
  });

  it("never publishes old diagnostics under a reset identity while candidates are pending", async () => {
    const f = await serviceFixture();
    f.service.get("watcher", true);
    const pairing = newPairing(f);
    await f.phone().pair(pairing.qr, { confirm: false });
    const previous = f.service.get("local", undefined);
    f.events.length = 0;
    f.clock.advance(1);
    await f.service.resetIdentity();
    expect(f.service.get("local", undefined).hostFingerprint).not.toBe(previous.hostFingerprint);
    expect(f.events.map(({ event }) => event.remote.relay?.diagnostics?.checkedAt)).not.toContain(
      previous.relay!.diagnostics!.checkedAt,
    );
    expect(f.events.map(({ event }) => event.remote.pairing?.handshaking)).not.toContain(true);
  });

  it.each([
    ["  iPhone 16 Pro  ", "iPhone 16 Pro"],
    [" \t ", null],
    ["", null],
  ])("projects stored model %j without changing its persisted value", async (reported, model) => {
    const f = await serviceFixture();
    const phone = f.phone({ model: reported });
    const { session, deviceId } = await pairDevice(f, phone);
    expect(f.service.get("local", undefined).devices).toStrictEqual([
      {
        deviceId,
        name: "Fake iPhone",
        model,
        pairedAt: f.clock.now(),
        lastSeenAt: f.clock.now(),
        online: true,
        traffic: { down: 0, up: 0 },
      },
    ]);
    expect(f.vault.contents().devices[0]?.model).toBe(reported);
    await f.service.renameDevice(deviceId, "Not a hardware model");
    expect(f.service.get("local", undefined).devices[0]?.model).toBe(model);
    await session.close();
    await f.restart();
    await expect.poll(() => f.service.get("local", undefined).vault).toBe("ok");
    expect(f.service.get("local", undefined).devices[0]).toMatchObject({ model, online: false });
  });

  it("projects only current available candidates, coalesces starts and clears confirmation immediately", async () => {
    const f = await serviceFixture();
    f.service.get("watcher", true);
    const pairing = newPairing(f);
    expect(pairing.handshaking).toBe(false);
    f.events.length = 0;
    const first = await f.phone({ deviceName: "Secret candidate" }).pair(pairing.qr, { confirm: false });
    const second = await f.phone().pair(pairing.qr, { confirm: false });
    expect(f.service.get("local", undefined).pairing).toStrictEqual({ ...pairing, handshaking: true });
    expect(f.service.get("local", undefined).devices).toStrictEqual([]);
    expect(f.accepted).toStrictEqual([]);
    expect(f.events).toStrictEqual([]);
    f.clock.advance(100);
    expect(f.events.map(({ event }) => event.remote.pairing)).toStrictEqual([{ ...pairing, handshaking: true }]);
    await first.close();
    await expect.poll(() => f.logs.filter((entry) => entry.msg === "remote stream closed").length).toBe(1);
    expect(f.service.get("local", undefined).pairing?.handshaking).toBe(true);
    expect(f.events).toHaveLength(1);
    second.channel.sendControl({ kind: "pair_confirm" });
    await awaiting(f);
    expect(f.events.at(-1)?.event.remote.pairing).toMatchObject({
      state: "awaiting_confirmation",
      handshaking: false,
      request: { sas: second.sas },
    });
    expect(f.vault.contents().devices).toStrictEqual([]);
    expect(f.accepted).toStrictEqual([]);
  });

  it("clears activity observed by a late watcher and releases its coalescing timer on unwatch", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const candidate = await f.phone().pair(pairing.qr, { confirm: false });
    expect(f.service.get("late", true).pairing?.handshaking).toBe(true);
    await candidate.close();
    await expect.poll(() => f.events.at(-1)?.event.remote.pairing?.handshaking).toBe(false);
    const next = await f.phone().pair(pairing.qr, { confirm: false });
    f.service.unwatch("late");
    const count = f.events.length;
    f.clock.advance(100);
    expect(f.events).toHaveLength(count);
    await next.close();
  });

  it("suppresses rapid candidate churn and unrelated unauthenticated closes", async () => {
    const f = await serviceFixture();
    f.service.get("watcher", true);
    const pairing = newPairing(f);
    f.events.length = 0;
    for (let i = 0; i < 3; i++) {
      const candidate = await f.phone().pair(pairing.qr, { confirm: false });
      expect(f.service.get("local", undefined).pairing?.handshaking).toBe(true);
      await candidate.close();
      await expect.poll(() => f.service.get("local", undefined).pairing?.handshaking).toBe(false);
    }
    await expect(f.phone().pair(pairing.qr, { protocolVersion: PROTOCOL_VERSION + 1 })).rejects.toThrow(
      "version_mismatch",
    );
    f.clock.advance(100);
    expect(f.events).toStrictEqual([]);
    expect(f.service.get("local", undefined).pairing).toStrictEqual(pairing);
  });

  it("does not let an old stream clear a new QR candidate or extend fixed expiry", async () => {
    const f = await serviceFixture();
    const old = newPairing(f);
    const previous = await f.phone().pair(old.qr, { confirm: false });
    const current = newPairing(f);
    expect(current.handshaking).toBe(false);
    const next = await f.phone().pair(current.qr, { confirm: false });
    previous.channel.sendControl({ kind: "pair_confirm" });
    expect(await previous.control(["pair_rejected"])).toMatchObject({ reason: "pairing_expired" });
    await previous.closed;
    expect(f.service.get("local", undefined).pairing).toStrictEqual({ ...current, handshaking: true });
    f.clock.advance(HANDSHAKE_TIMEOUT_MS);
    expect(f.service.get("local", undefined).pairing).toStrictEqual(current);
    await next.closed;
    f.clock.advance(PAIRING_TTL_MS - HANDSHAKE_TIMEOUT_MS);
    expect(f.service.get("local", undefined).pairing).toStrictEqual({ ...current, state: "expired" });
  });

  it("clears activity at the fixed QR expiry even for a freshly arrived candidate", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    f.clock.advance(PAIRING_TTL_MS - 200);
    await expect.poll(() => f.service.get("local", undefined).relay?.status).toBe("error");
    await f.service.testRelay();
    f.service.get("watcher", true);
    await f.phone().pair(pairing.qr, { confirm: false });
    f.clock.advance(100);
    expect(f.events.at(-1)?.event.remote.pairing?.handshaking).toBe(true);
    f.clock.advance(100);
    expect(f.events.at(-1)?.event.remote.pairing).toStrictEqual({ ...pairing, state: "expired" });
    expect(f.accepted).toStrictEqual([]);
  });

  it.each(["cancel", "off", "reset"] as const)("clears candidate projection immediately on %s", async (action) => {
    const f = await serviceFixture();
    f.service.get("watcher", true);
    const pairing = newPairing(f);
    await f.phone().pair(pairing.qr, { confirm: false });
    f.clock.advance(100);
    expect(f.events.at(-1)?.event.remote.pairing?.handshaking).toBe(true);
    await endCandidate(f, action);
    expect(f.service.get("local", undefined).pairing).toBeNull();
    expect(f.events.at(-1)?.event.remote.pairing).toBeNull();
    const count = f.events.length;
    f.clock.advance(100);
    expect(f.events).toHaveLength(count);
    expect(f.accepted).toStrictEqual([]);
  });

  it("clears candidate projection immediately on failure", async () => {
    const f = await serviceFixture();
    f.service.get("watcher", true);
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr, { confirm: false });
    f.clock.advance(100);
    expect(f.events.at(-1)?.event.remote.pairing?.handshaking).toBe(true);
    session.channel.sendControl({ kind: "paired" });
    await session.closed;
    await expect.poll(() => f.service.get("local", undefined).pairing?.handshaking).toBe(false);
    expect(f.events.at(-1)?.event.remote.pairing).toStrictEqual(pairing);
    const count = f.events.length;
    f.clock.advance(100);
    expect(f.events).toHaveLength(count);
    expect(f.accepted).toStrictEqual([]);
  });
});
