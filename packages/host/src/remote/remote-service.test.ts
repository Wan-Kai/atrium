import { once } from "node:events";
import { FakeClock } from "@atrium/testkit";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { RemoteUpdatedEvent } from "@atrium/protocol";
import pino from "pino";
import { ResourceTracker } from "../platform/resources";
import type { IndexFile } from "../store/index-file";
import type { RemoteDocument } from "./devices";
import { RemoteService } from "./remote-service";
import type { VaultPort, VaultRead, VaultWrite } from "./vault";

const cleanup: RemoteService[] = [];
afterEach(async () => {
  for (const service of cleanup.splice(0)) await service.close();
});

/** Builds the service without opening a relay. @remarks Storage is in memory. @sideEffects Registers service cleanup. */
function fixture(port?: VaultPort, initial: RemoteDocument = { enabled: false, lastSeen: {} }) {
  let document = initial;
  const index: IndexFile<RemoteDocument> = {
    read: () => document,
    save: async (next) => {
      document = next;
    },
    flush: async () => {},
  };
  const events: [string, RemoteUpdatedEvent][] = [];
  const resources = new ResourceTracker();
  const clock = new FakeClock(1);
  const service = new RemoteService({
    vault: port,
    index,
    clock,
    resources,
    logger: pino({ enabled: false }),
    hostName: "Mac",
    send: (id, event) => events.push([id, event]),
    accept: () => {},
  });
  cleanup.push(service);
  return { service, events, resources, clock, index };
}

/** Starts a stalled control endpoint with a configured, disabled service. @remarks Real sockets expose cancellation races without replacing the relay module. @sideEffects Opens a loopback listener and registers teardown. */
async function stalledProbeFixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  onTestFinished(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  const f = fixture({
    read: async () => ({ ok: true, version: 0, data: null }),
    write: async () => ({ ok: true }),
  });
  const line = `atrium-relay://hst_0123456789abcdef:${"a".repeat(43)}@127.0.0.1:${address.port}`;
  await f.service.set(false, line);
  f.service.get("watcher", true);
  return { ...f, line, sockets };
}

/** Cancels a probe via a local lifecycle action. @remarks Each case exercises the public management boundary. @sideEffects Changes configuration or closes remote resources. */
async function cancelProbe(
  f: Awaited<ReturnType<typeof stalledProbeFixture>>,
  action: "configure" | "reset" | "off" | "close",
): Promise<void> {
  if (action === "configure") await f.service.set(false, f.line);
  else if (action === "reset") await f.service.resetIdentity();
  else if (action === "off") await f.service.set(false, undefined);
  else await f.service.close();
}

describe("RemoteService", () => {
  it.each(["configure", "reset", "off", "close"] as const)(
    "never publishes a cancelled off-probe after %s",
    async (action) => {
      const f = await stalledProbeFixture();
      expect(f.service.get("local", undefined).relay?.diagnostics).toBeNull();
      const checking = f.service.testRelay().catch((error: unknown) => error);
      await expect.poll(() => f.sockets.length).toBe(1);
      await cancelProbe(f, action);
      expect(await checking).toMatchObject({ code: "relay_unreachable" });
      expect(f.service.get("local", undefined).relay?.diagnostics).toBeNull();
      expect(f.events.every(([, event]) => event.remote.relay?.diagnostics === null)).toBe(true);
    },
  );

  it("replaces a cancelled off-probe only with the newly enabled generation's diagnostics", async () => {
    const f = await stalledProbeFixture();
    const checking = f.service.testRelay().catch((error: unknown) => error);
    await expect.poll(() => f.sockets.length).toBe(1);
    await f.service.set(true, undefined);
    expect(await checking).toMatchObject({ code: "relay_unreachable" });
    expect(f.service.get("local", undefined).relay?.diagnostics).toBeNull();
    expect(f.events.every(([, event]) => event.remote.relay?.diagnostics === null)).toBe(true);
    await expect.poll(() => f.sockets.length).toBe(2);
    f.sockets[1]!.send('{"type":"ready"}');
    await expect.poll(() => f.service.get("local", undefined).relay?.status).toBe("connected");
    expect(f.events.at(-1)?.[1].remote.relay?.diagnostics).toMatchObject({ kind: "connect", token: "passed" });
  });

  it("publishes an off-probe rejection and retains it until the next probe actually finishes", async () => {
    const f = await stalledProbeFixture();
    const first = f.service.testRelay().catch((error: unknown) => error);
    await expect.poll(() => f.sockets.length).toBe(1);
    f.sockets[0]!.close(4401);
    expect(await first).toMatchObject({ code: "relay_rejected" });
    const failed = {
      kind: "connect",
      checkedAt: f.clock.now(),
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "failed",
      failure: "token_rejected",
    };
    expect(f.service.get("local", undefined).relay?.diagnostics).toStrictEqual(failed);
    expect(f.events.at(-1)?.[1].remote.relay?.diagnostics).toStrictEqual(failed);
    f.clock.advance(1);
    const second = f.service.testRelay();
    await expect.poll(() => f.sockets.length).toBe(2);
    expect(f.service.get("local", undefined).relay?.diagnostics).toStrictEqual(failed);
    f.sockets[1]!.send('{"type":"ready"}');
    expect(await second).toStrictEqual({});
    expect(f.events.at(-1)?.[1].remote.relay).toMatchObject({
      status: "off",
      diagnostics: { ...failed, checkedAt: f.clock.now(), token: "passed", failure: null },
    });
  });

  it("shares a pending vault load across startup and concurrent enable commands", async () => {
    const reading = Promise.withResolvers<VaultRead>();
    let reads = 0;
    const writes: [number, string][] = [];
    const f = fixture(
      {
        read: () => {
          reads++;
          return reading.promise;
        },
        write: async (version, data) => {
          writes.push([version, data]);
          return { ok: true };
        },
      },
      { enabled: true, lastSeen: { dev_0123456789abcdef: 42 } },
    );
    f.service.start();
    f.service.start();
    const enabling = [f.service.set(true, undefined), f.service.set(true, undefined)];
    await expect.poll(() => f.service.get("local", undefined).vault).toBe("waiting");
    expect(reads).toBe(1);
    expect(writes).toStrictEqual([]);
    reading.resolve({ ok: true, version: 4, data: null });
    expect(await Promise.all(enabling)).toStrictEqual([{}, {}]);
    expect(reads).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe(5);
    const saved: unknown = JSON.parse(writes[0]![1]);
    expect(saved).toStrictEqual({
      format: 1,
      hostKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      relay: null,
      devices: [],
    });
    expect(f.index.read()).toStrictEqual({ enabled: true, lastSeen: { dev_0123456789abcdef: 42 } });
    expect(f.service.get("local", undefined)).toMatchObject({ enabled: true, vault: "ok" });
    await f.service.set(true, undefined);
    expect(reads).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it("finishes shutdown before a keychain read and never initializes from its late answer", async () => {
    const reading = Promise.withResolvers<VaultRead>();
    const writes: string[] = [];
    const f = fixture({
      read: () => reading.promise,
      write: async (_version, data) => {
        writes.push(data);
        return { ok: true };
      },
    });
    f.service.get("watcher", true);
    const enabling = f.service.set(true, undefined);
    await expect.poll(() => f.service.get("local", undefined).vault).toBe("waiting");
    await f.service.close();
    const count = f.events.length;
    reading.resolve({ ok: true, version: 0, data: null });
    expect(await enabling).toStrictEqual({});
    f.service.start();
    f.service.get("late watcher", true);
    f.clock.advance(60_000);
    expect(writes).toStrictEqual([]);
    expect(f.events).toHaveLength(count);
    expect(f.service.get("local", undefined).hostFingerprint).toBeNull();
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
    await expect(f.service.set(true, undefined)).rejects.toMatchObject({ code: "remote_unavailable" });
    await expect(f.service.resetIdentity()).rejects.toMatchObject({ code: "remote_unavailable" });
  });

  it("samples once for all watchers and stops only after the last unsubscribe", async () => {
    const f = fixture();
    const state = f.service.get("first", true);
    f.service.get("first", true);
    f.service.get("second", true);
    f.service.get("not subscribed", undefined);
    expect(f.resources.snapshot()).toStrictEqual({ timer: 1 });
    f.clock.advance(999);
    expect(f.events).toStrictEqual([]);
    f.clock.advance(1);
    expect(f.events).toStrictEqual([
      ["first", { type: "remote_updated", remote: state }],
      ["second", { type: "remote_updated", remote: state }],
    ]);
    f.service.get("first", false);
    f.service.unwatch("not subscribed");
    expect(f.resources.snapshot()).toStrictEqual({ timer: 1 });
    f.clock.advance(1000);
    expect(f.events.slice(2)).toStrictEqual([["second", { type: "remote_updated", remote: state }]]);
    f.service.unwatch("second");
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
    f.clock.advance(10_000);
    expect(f.events).toHaveLength(3);
    f.service.get("again", true);
    f.clock.advance(1000);
    expect(f.events.slice(3)).toStrictEqual([["again", { type: "remote_updated", remote: state }]]);
    await f.service.close();
    expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it("reports background startup failure to watchers without rejecting local startup", async () => {
    const f = fixture(
      {
        read: async () => {
          throw new Error("keychain port disappeared");
        },
        write: async () => {
          throw new Error("must not replace unread identity");
        },
      },
      { enabled: true, lastSeen: {} },
    );
    f.service.get("local", true);
    expect(f.service.start()).toBeUndefined();
    await expect.poll(() => f.service.get("local", undefined).vault).toBe("keychain_unavailable");
    expect(f.events[0]).toStrictEqual([
      "local",
      {
        type: "remote_updated",
        remote: {
          enabled: true,
          vault: "waiting",
          relay: null,
          hostFingerprint: null,
          devices: [],
          pairing: null,
        },
      },
    ]);
    expect(f.events.at(-1)?.[1].remote.vault).toBe("keychain_unavailable");
    await expect(f.service.resetIdentity()).rejects.toMatchObject({ code: "keychain_unavailable" });
    await f.service.set(false, undefined);
    expect(f.index.read().enabled).toBe(false);
  });

  it("rejects malformed relay input before changing the switch or reading the vault", async () => {
    let reads = 0;
    const f = fixture({
      read: async () => {
        reads++;
        return { ok: true, version: 0, data: null };
      },
      write: async () => ({ ok: true }),
    });
    const initial = f.service.get("local", true);
    await expect(f.service.set(true, "not a relay")).rejects.toMatchObject({ code: "relay_unreachable" });
    expect(f.service.get("local", undefined)).toStrictEqual(initial);
    expect(f.index.read()).toStrictEqual({ enabled: false, lastSeen: {} });
    expect(f.events).toStrictEqual([]);
    expect(reads).toBe(0);
  });

  it.each(["io", "stale"] as const)("maps a %s read failure to keychain unavailable without saving", async (error) => {
    const writes: string[] = [];
    const f = fixture({
      read: async () => ({ ok: false, error }),
      write: async (_version, data) => {
        writes.push(data);
        return { ok: true };
      },
    });
    await expect(f.service.set(true, undefined)).rejects.toMatchObject({ code: "keychain_unavailable" });
    expect(f.service.get("local", undefined).vault).toBe("keychain_unavailable");
    await expect(f.service.renameDevice("dev_0123456789abcdef", "Name")).rejects.toMatchObject({
      code: "keychain_unavailable",
    });
    expect(writes).toStrictEqual([]);
  });

  it("retries failed identity initialization without consuming the vault version", async () => {
    const writes: [number, string][] = [];
    const answers: VaultWrite[] = [{ ok: false, error: "io" }, { ok: true }];
    const f = fixture({
      read: async () => ({ ok: true, version: 4, data: null }),
      write: async (version, data) => {
        writes.push([version, data]);
        return answers.shift()!;
      },
    });
    await expect(f.service.set(true, undefined)).rejects.toMatchObject({ code: "keychain_unavailable" });
    expect(f.service.get("local", undefined)).toMatchObject({ vault: "keychain_unavailable", hostFingerprint: null });
    expect(await f.service.set(true, undefined)).toStrictEqual({});
    expect(writes.map(([version]) => version)).toStrictEqual([5, 5]);
    expect(f.service.get("local", undefined)).toMatchObject({
      vault: "ok",
      hostFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    await expect(f.service.testRelay()).rejects.toMatchObject({ code: "remote_unavailable" });
    await expect(f.service.renameDevice("dev_0123456789abcdef", "Name")).rejects.toMatchObject({
      code: "device_not_found",
    });
    await expect(f.service.revokeDevice("dev_0123456789abcdef")).rejects.toMatchObject({ code: "device_not_found" });
    await expect(f.service.confirmPairing("pair_0123456789abcdef", true)).rejects.toMatchObject({
      code: "pairing_expired",
    });
    expect(f.service.cancelPairing()).toStrictEqual({});
    expect(writes).toHaveLength(2);
  });

  it("leaves the vault unread while off and reports standalone unavailable", async () => {
    let reads = 0;
    const f = fixture({
      read: async () => {
        reads++;
        return { ok: true, version: 0, data: null };
      },
      write: async () => ({ ok: true }),
    });
    f.service.start();
    expect(f.service.get("local", true)).toStrictEqual({
      enabled: false,
      vault: "unread",
      relay: null,
      hostFingerprint: null,
      devices: [],
      pairing: null,
    });
    expect(reads).toBe(0);
    await f.service.close();
    expect(Object.values(f.resources.snapshot()).every((n) => n === 0)).toBe(true);
    const standalone = fixture();
    expect(standalone.service.get("local", undefined).vault).toBe("unavailable");
    await expect(standalone.service.set(true, undefined)).rejects.toMatchObject({ code: "remote_unavailable" });
    await standalone.service.close();
  });

  it("keeps local reads and disable responsive while keychain permission is pending", async () => {
    const reading = Promise.withResolvers<VaultRead>();
    const f = fixture({
      read: () => reading.promise,
      write: async () => ({ ok: true }),
    });
    const enabling = f.service.set(true, undefined);
    await expect.poll(() => f.service.get("local", undefined).vault).toBe("waiting");
    await f.service.set(false, undefined);
    expect(f.service.get("local", undefined).enabled).toBe(false);
    reading.resolve({ ok: true, version: 0, data: null });
    await enabling;
    expect(f.service.get("local", undefined)).toMatchObject({ enabled: false, vault: "ok", relay: null });
    await f.service.close();
  });

  it.each([
    { error: "corrupt", code: "vault_corrupt" },
    { error: "keychain_unavailable", code: "keychain_unavailable" },
  ] as const)("fails closed for $error and never generates an identity", async ({ error, code }) => {
    const writes: string[] = [];
    const f = fixture({
      read: async () => ({ ok: false, error }),
      write: async (_version, data) => {
        writes.push(data);
        return { ok: true };
      },
    });
    await expect(f.service.set(true, undefined)).rejects.toMatchObject({
      code,
    });
    expect(writes).toStrictEqual([]);
    expect(f.service.get("local", undefined)).toMatchObject({
      vault: error,
      hostFingerprint: null,
      devices: [],
      relay: null,
    });
    expect(() => f.service.startPairing()).toThrow("remote_unavailable");
    await f.service.close();
  });

  it.each(["{}", JSON.stringify({ format: 1, hostKey: "A".repeat(43), relay: "not a relay", devices: [] })])(
    "treats malformed decrypted content as corrupt until explicit reset: %s",
    async (data) => {
      const writes: string[] = [];
      const f = fixture({
        read: async () => ({ ok: true, version: 8, data }),
        write: async (_v, saved) => {
          writes.push(saved);
          return { ok: true };
        },
      });
      await expect(f.service.set(true, undefined)).rejects.toMatchObject({ code: "vault_corrupt" });
      expect(writes).toStrictEqual([]);
      expect(await f.service.resetIdentity()).toStrictEqual({});
      expect(f.service.get("local", undefined)).toMatchObject({ vault: "ok", devices: [] });
      expect(f.service.get("local", undefined).hostFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(writes).toHaveLength(1);
      await f.service.close();
    },
  );
});
