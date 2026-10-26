import { describe, expect, it, vi } from "vitest";
import { type VaultPort, type VaultWrite, VaultStore, portVault } from "./vault";

describe("portVault", () => {
  it("matches answers to requests by id, whatever their order", async () => {
    const posted: unknown[] = [];
    const { vault, receive } = portVault((message) => posted.push(message));

    const first = vault.read();
    const second = vault.read();
    expect(receive({ type: "vault_result", id: 2, ok: true, version: 0, data: null })).toBe(true);
    expect(receive({ type: "vault_result", id: 1, ok: false, error: "keychain_unavailable" })).toBe(true);

    expect(posted).toStrictEqual([
      { type: "vault_read", id: 1 },
      { type: "vault_read", id: 2 },
    ]);
    expect(await second).toStrictEqual({ ok: true, version: 0, data: null });
    expect(await first).toStrictEqual({ ok: false, error: "keychain_unavailable" });
  });

  it("rejects a successful read missing its version or data", async () => {
    const { vault, receive } = portVault(() => undefined);
    const read = vault.read();
    receive({ type: "vault_result", id: 1, ok: true });

    expect(await read).toStrictEqual({ ok: false, error: "corrupt" });
  });

  it("passes on a write's success and failure", async () => {
    const posted: unknown[] = [];
    const { vault, receive } = portVault((message) => posted.push(message));
    const ok = vault.write(1, "a");
    const failed = vault.write(2, "b");
    receive({ type: "vault_result", id: 1, ok: true });
    receive({ type: "vault_result", id: 2, ok: false, error: "io" });

    expect(await ok).toStrictEqual({ ok: true });
    expect(await failed).toStrictEqual({ ok: false, error: "io" });
    expect(posted).toStrictEqual([
      { type: "vault_write", version: 1, data: "a", id: 1 },
      { type: "vault_write", version: 2, data: "b", id: 2 },
    ]);
  });

  it("ignores what is not a vault answer, and an answer to nothing", () => {
    const { receive } = portVault(() => undefined);

    expect(receive({ type: "shutdown" })).toBe(false);
    expect(receive({ type: "vault_result", id: 1, ok: false, error: "oops" })).toBe(false);
    expect(receive({ type: "vault_result", id: 0, ok: true })).toBe(false);
    expect(receive({ type: "vault_result", id: 9, ok: true })).toBe(true);
  });
});

/** A port that records writes and answers them as the test says. */
function recordingPort(answers: VaultWrite[], read = { ok: true as const, version: 4, data: "{}" }) {
  const writes: [number, string][] = [];
  const port: VaultPort = {
    read: async () => read,
    write: async (version, data) => {
      writes.push([version, data]);
      return answers.shift() ?? { ok: true };
    },
  };
  return { port, writes };
}

describe("VaultStore", () => {
  it("recovers the save queue when the port rejects unexpectedly", async () => {
    const write = vi
      .fn<VaultPort["write"]>()
      .mockRejectedValueOnce(new Error("port closed"))
      .mockResolvedValue({ ok: true });
    const store = new VaultStore({
      read: async () => ({ ok: true, version: 0, data: null }),
      write,
    });
    expect(await store.save("a")).toStrictEqual({ ok: false, error: "io" });
    expect(await store.save("b")).toStrictEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("terminates an oversized write before sending it over the port", async () => {
    const posted: unknown[] = [];
    const { vault } = portVault((value) => posted.push(value));
    const result = await vault.write(1, "a".repeat(4 * 1024 * 1024 + 1));
    expect(result).toStrictEqual({ ok: false, error: "io" });
    expect(posted).toStrictEqual([]);
  });
  it("writes each save as the next version after the one it read", async () => {
    const { port, writes } = recordingPort([]);
    const store = new VaultStore(port);

    expect(await store.load()).toStrictEqual({ ok: true, version: 4, data: "{}" });
    const saves = [store.save("a"), store.save("b")];
    expect(await Promise.all(saves)).toStrictEqual([{ ok: true }, { ok: true }]);

    expect(writes).toStrictEqual([
      [5, "a"],
      [6, "b"],
    ]);
  });

  it("does not use up a version on a failed write", async () => {
    const { port, writes } = recordingPort([{ ok: false, error: "keychain_unavailable" }]);
    const store = new VaultStore(port);
    await store.load();

    expect(await store.save("a")).toStrictEqual({ ok: false, error: "keychain_unavailable" });
    expect(await store.save("b")).toStrictEqual({ ok: true });
    expect(writes).toStrictEqual([
      [5, "a"],
      [5, "b"],
    ]);
  });

  it("starts from version 0 when the vault could not be read, so a reset can write", async () => {
    const { port, writes } = recordingPort([], { ok: false, error: "corrupt" } as never);
    const store = new VaultStore(port);

    expect(await store.load()).toStrictEqual({ ok: false, error: "corrupt" });
    await store.save("fresh");
    expect(writes).toStrictEqual([[1, "fresh"]]);
  });

  it("sends a write only after the one before it was answered", async () => {
    const answered: (() => void)[] = [];
    const order: string[] = [];
    const port: VaultPort = {
      read: async () => ({ ok: true, version: 0, data: null }),
      write: (version) => {
        order.push(`write ${version}`);
        return new Promise((resolve) => answered.push(() => resolve({ ok: true })));
      },
    };
    const store = new VaultStore(port);
    const first = store.save("a");
    const second = store.save("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toStrictEqual(["write 1"]);
    answered.shift()?.();
    await first;
    await vi.waitFor(() => expect(order).toStrictEqual(["write 1", "write 2"]));
    answered.shift()?.();
    expect(await second).toStrictEqual({ ok: true });
  });
});
