import { describe, expect, it } from "vitest";
import { newPairing, pairDevice, serviceFixture } from "./service-fixture";

/**
 * Counts real TCP handles independently of the host's resource tracker.
 * @remarks A forgotten relay data socket must not be hidden by a premature tracker release.
 * @sideEffects none
 * @returns Live TCP socket handles in this test process.
 */
function sockets(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;
}

describe("remote service resource ownership", () => {
  it("returns sockets, timers and tracked resources to baseline over forty pair/connect/revoke cycles", async () => {
    // Exercise ownership, not the relay's 30-new-streams/minute production quota.
    const f = await serviceFixture({ newStreamsPerIpPerMinute: 1_000 });
    const phone = f.phone();
    const baseline = { ...f.resources.snapshot(), "remote.data": 0 };
    const timerBaseline = f.clock.pendingTimers();
    const socketBaseline = sockets();
    for (let round = 0; round < 40; round++) {
      f.service.get("watcher", true);
      const pair = await pairDevice(f, phone);
      const daily = await phone.connect();
      await f.service.revokeDevice(pair.deviceId);
      await Promise.all([pair.session.control(["revoked"]), daily.control(["revoked"])]);
      await Promise.all([pair.session.closed, daily.closed]);
      f.service.unwatch("watcher");
      await expect.poll(() => f.resources.snapshot()).toStrictEqual(baseline);
      expect(f.clock.pendingTimers()).toBe(timerBaseline);
      expect(f.accepted.every((item) => item.closed)).toBe(true);
      expect(f.vault.contents().devices).toStrictEqual([]);
    }
    await expect.poll(sockets).toBe(socketBaseline);
    await f.service.close();
    expect(f.clock.pendingTimers()).toBe(0);
    expect(Object.values(f.resources.snapshot()).every((count) => count === 0)).toBe(true);
  });

  it("drains all unconfirmed data sockets over twenty disable/enable cycles", async () => {
    const f = await serviceFixture({ newStreamsPerIpPerMinute: 1_000 });
    const phones = [f.phone(), f.phone(), f.phone(), f.phone()];
    const socketBaseline = sockets();
    for (let round = 0; round < 20; round++) {
      const pairing = newPairing(f);
      const sessions = [];
      for (const phone of phones) sessions.push(await phone.pair(pairing.qr, { confirm: false }));
      expect(f.resources.snapshot()["remote.data"]).toBe(4);
      await f.service.set(false, undefined);
      await Promise.all(sessions.map((session) => session.closed));
      expect(f.clock.pendingTimers()).toBe(0);
      expect(Object.values(f.resources.snapshot()).every((count) => count === 0)).toBe(true);
      expect(f.accepted).toStrictEqual([]);
      await f.service.set(true, undefined);
      await expect.poll(() => f.service.get("observer", undefined).relay?.status).toBe("connected");
    }
    await expect.poll(sockets).toBe(socketBaseline);
  });
});
