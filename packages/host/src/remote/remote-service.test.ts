import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { ResourceTracker } from "../platform/resources";
import type { IndexFile } from "../store/index-file";
import type { RemoteDocument } from "./devices";
import { RemoteService } from "./remote-service";
import type { VaultPort, VaultRead } from "./vault";

/** Builds the service without opening a relay. @remarks Storage is in memory. @sideEffects none */
function fixture(port?: VaultPort) {
  let document: RemoteDocument = { enabled: false, lastSeen: {} };
  const index: IndexFile<RemoteDocument> = {
    read: () => document,
    save: async (next) => {
      document = next;
    },
    flush: async () => {},
  };
  const events: unknown[] = [];
  const resources = new ResourceTracker();
  const service = new RemoteService({
    vault: port,
    index,
    clock: new FakeClock(1),
    resources,
    logger: pino({ enabled: false }),
    hostName: "Mac",
    send: (id, event) => events.push([id, event]),
    accept: () => {},
  });
  return { service, events, resources };
}

describe("RemoteService", () => {
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

  it("treats malformed decrypted content as corrupt until explicit reset", async () => {
    const writes: string[] = [];
    const f = fixture({
      read: async () => ({ ok: true, version: 8, data: "{}" }),
      write: async (_v, data) => {
        writes.push(data);
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
  });
});
