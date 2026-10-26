import { createTempDir } from "@atrium/testkit";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { type VaultCrypto, createVaultKeeper } from "./vault";

// Exact native messages, independently pinned here as the Electron 44.5.1 test oracle.
const DECRYPT_FAILED = "Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.";
const TEMPORARILY_UNAVAILABLE = "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.";

/**
 * A stand-in for `safeStorage`: reversible, but not the plain text, and switchable off.
 *
 * @remarks
 * The real one needs the keychain, which a test must not touch.
 *
 * @sideEffects none
 * @returns The crypto and a switch.
 */
function fakeCrypto() {
  const state = {
    available: true,
    failEncrypt: false,
    rejectAvailabilityOnce: false,
    rejectDecrypt: false,
    decryptError: undefined as unknown,
    decryptCalls: 0,
    encryptCalls: 0,
  };
  const crypto: VaultCrypto = {
    available: async () => {
      if (state.rejectAvailabilityOnce) {
        state.rejectAvailabilityOnce = false;
        throw new Error("keychain unavailable");
      }
      return state.available;
    },
    encrypt: async (text) => {
      state.encryptCalls++;
      if (state.failEncrypt) throw new Error("no key");
      return Buffer.from(`enc:${Buffer.from(text).toString("base64")}`);
    },
    decrypt: async (data) => {
      state.decryptCalls++;
      if (state.rejectDecrypt) throw state.decryptError;
      const text = data.toString();
      if (!text.startsWith("enc:")) throw new Error(DECRYPT_FAILED);
      return Buffer.from(text.slice(4), "base64").toString();
    },
  };
  return { crypto, state };
}

/**
 * A keeper over a vault path in a new temporary folder.
 *
 * @remarks
 * The folder is removed after the test.
 *
 * @sideEffects Creates a temporary folder.
 * @returns The keeper, the vault's path and the crypto's state.
 */
async function keeper() {
  const dir = await createTempDir("vault");
  onTestFinished(() => dir.cleanup());
  const path = join(dir.path, "remote", "vault.bin");
  const { crypto, state } = fakeCrypto();
  return { vault: createVaultKeeper({ path, crypto }), path, state, crypto, dir: dir.path };
}

describe("createVaultKeeper", () => {
  it("pins the reviewed native message contract to Electron 44.5.1", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      devDependencies: { electron: string };
    };
    expect(pkg.devDependencies.electron).toBe("44.5.1");
    expect(Object.hasOwn(new Error(TEMPORARILY_UNAVAILABLE), "code")).toBe(false);
  });

  it.each([
    { label: "temporarily unavailable", error: new Error(TEMPORARILY_UNAVAILABLE) },
    { label: "unknown failure", error: new Error("unrecognized native error; private text") },
    { label: "known message with an unknown suffix", error: new Error(`${DECRYPT_FAILED} private suffix`) },
    { label: "non-Error rejection", error: { message: DECRYPT_FAILED } },
  ])("preserves a high-version vault when decrypt rejects with $label despite availability", async ({ error }) => {
    const { vault, path, state } = await keeper();
    expect(await vault.handle({ type: "vault_write", id: 1, version: 50, data: "original-identity" })).toStrictEqual({
      type: "vault_result",
      id: 1,
      ok: true,
    });
    const original = await readFile(path);
    state.rejectDecrypt = true;
    state.decryptError = error;
    expect(state.available).toBe(true);
    expect(await vault.handle({ type: "vault_read", id: 2 })).toStrictEqual({
      type: "vault_result",
      id: 2,
      ok: false,
      error: "keychain_unavailable",
    });
    expect(await vault.handle({ type: "vault_write", id: 3, version: 1, data: "must-not-reset" })).toStrictEqual({
      type: "vault_result",
      id: 3,
      ok: false,
      error: "keychain_unavailable",
    });
    expect(await vault.handle({ type: "vault_write", id: 4, version: 51, data: "must-not-replace" })).toStrictEqual({
      type: "vault_result",
      id: 4,
      ok: false,
      error: "keychain_unavailable",
    });
    expect(state.decryptCalls).toBe(3);
    expect(state.encryptCalls).toBe(1);
    expect(await readFile(path)).toStrictEqual(original);
    expect(await readdir(join(path, ".."))).toStrictEqual(["vault.bin"]);
    state.rejectDecrypt = false;
    expect(await vault.handle({ type: "vault_write", id: 5, version: 1, data: "still-stale" })).toStrictEqual({
      type: "vault_result",
      id: 5,
      ok: false,
      error: "stale",
    });
    expect(state.decryptCalls).toBe(4);
    expect(await vault.handle({ type: "vault_read", id: 6 })).toStrictEqual({
      type: "vault_result",
      id: 6,
      ok: true,
      version: 50,
      data: "original-identity",
    });
    expect(await readFile(path)).toStrictEqual(original);
    expect(state.encryptCalls).toBe(1);
  });

  it("does not lower an already-known version to zero after a rejected read", async () => {
    const { vault, path, state } = await keeper();
    await vault.handle({ type: "vault_write", id: 1, version: 50, data: "original" });
    const original = await readFile(path);
    state.rejectDecrypt = true;
    state.decryptError = new Error(TEMPORARILY_UNAVAILABLE);
    // Intentionally leave encryption usable: this proves the guard, not a platform overwrite scenario.
    await vault.handle({ type: "vault_read", id: 2 });
    expect(await vault.handle({ type: "vault_write", id: 3, version: 1, data: "replacement" })).toStrictEqual({
      type: "vault_result",
      id: 3,
      ok: false,
      error: "keychain_unavailable",
    });
    expect(await readFile(path)).toStrictEqual(original);
    state.rejectDecrypt = false;
    expect(await vault.handle({ type: "vault_read", id: 4 })).toStrictEqual({
      type: "vault_result",
      id: 4,
      ok: true,
      version: 50,
      data: "original",
    });
  });

  it("does not initialize version 1 over an unread vault when an unknown decrypt rejection recovers", async () => {
    const { vault, path, state, crypto } = await keeper();
    await vault.handle({ type: "vault_write", id: 1, version: 80, data: "original" });
    const original = await readFile(path);
    const fresh = createVaultKeeper({ path, crypto });
    state.rejectDecrypt = true;
    state.decryptError = new Error("unknown decrypt rejection");
    expect(await fresh.handle({ type: "vault_write", id: 2, version: 1, data: "replacement" })).toStrictEqual({
      type: "vault_result",
      id: 2,
      ok: false,
      error: "keychain_unavailable",
    });
    expect(await readFile(path)).toStrictEqual(original);
    state.rejectDecrypt = false;
    expect(await fresh.handle({ type: "vault_write", id: 3, version: 1, data: "replacement" })).toStrictEqual({
      type: "vault_result",
      id: 3,
      ok: false,
      error: "stale",
    });
    expect(await fresh.handle({ type: "vault_read", id: 4 })).toStrictEqual({
      type: "vault_result",
      id: 4,
      ok: true,
      version: 80,
      data: "original",
    });
    expect(await readFile(path)).toStrictEqual(original);
  });

  it("reads no file as an empty vault at version 0", async () => {
    const { vault } = await keeper();

    expect(await vault.handle({ type: "vault_read", id: 1 })).toStrictEqual({
      type: "vault_result",
      id: 1,
      ok: true,
      version: 0,
      data: null,
    });
  });

  it("writes it encrypted, 0600 in a 0700 folder, and reads it back", async () => {
    const { vault, path } = await keeper();
    await vault.handle({ type: "vault_read", id: 1 });

    expect(await vault.handle({ type: "vault_write", id: 2, version: 1, data: "secret-key" })).toStrictEqual({
      type: "vault_result",
      id: 2,
      ok: true,
    });
    expect(await vault.handle({ type: "vault_read", id: 3 })).toStrictEqual({
      type: "vault_result",
      id: 3,
      ok: true,
      version: 1,
      data: "secret-key",
    });
    expect((await readFile(path, "utf8")).includes("secret-key")).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(path, ".."))).toStrictEqual(["vault.bin"]);
  });

  it("refuses a write whose version is not newer than the one it has", async () => {
    const { vault } = await keeper();
    await vault.handle({ type: "vault_write", id: 1, version: 2, data: "a" });

    expect(await vault.handle({ type: "vault_write", id: 2, version: 2, data: "b" })).toStrictEqual({
      type: "vault_result",
      id: 2,
      ok: false,
      error: "stale",
    });
    expect(await vault.handle({ type: "vault_write", id: 3, version: 1, data: "c" })).toMatchObject({
      error: "stale",
    });
    expect(await vault.handle({ type: "vault_read", id: 4 })).toMatchObject({ version: 2, data: "a" });
  });

  it("learns the version on disk before a first write", async () => {
    const { path } = await keeper();
    await createVaultKeeper({ path, crypto: fakeCrypto().crypto }).handle({
      type: "vault_write",
      id: 1,
      version: 5,
      data: "a",
    });
    const again = createVaultKeeper({ path, crypto: fakeCrypto().crypto });

    expect(await again.handle({ type: "vault_write", id: 1, version: 5, data: "b" })).toMatchObject({
      error: "stale",
    });
    expect(await again.handle({ type: "vault_write", id: 2, version: 6, data: "b" })).toMatchObject({ ok: true });
  });

  it.each([
    { label: "exact native ciphertext failure", bytes: "garbage" },
    { label: "successfully decrypted invalid JSON", bytes: `enc:${Buffer.from("{").toString("base64")}` },
    {
      label: "successfully decrypted invalid format",
      bytes: `enc:${Buffer.from('{"version":-1,"data":""}').toString("base64")}`,
    },
  ])("allows explicit reset after $label", async ({ bytes }) => {
    const { vault, path } = await keeper();
    await vault.handle({ type: "vault_write", id: 9, version: 5, data: "before" });
    await writeFile(path, bytes);
    expect(await vault.handle({ type: "vault_read", id: 1 })).toStrictEqual({
      type: "vault_result",
      id: 1,
      ok: false,
      error: "corrupt",
    });
    expect(await vault.handle({ type: "vault_write", id: 4, version: 1, data: "fresh" })).toStrictEqual({
      type: "vault_result",
      id: 4,
      ok: true,
    });
    expect(await vault.handle({ type: "vault_read", id: 5 })).toStrictEqual({
      type: "vault_result",
      id: 5,
      ok: true,
      version: 1,
      data: "fresh",
    });
  });

  it("fails closed without the keychain: no read, no write, nothing written", async () => {
    const { vault, path, state } = await keeper();
    await vault.handle({ type: "vault_read", id: 9 });
    state.available = false;
    expect(await vault.handle({ type: "vault_write", id: 8, version: 1, data: "a" })).toMatchObject({
      error: "keychain_unavailable",
    });

    expect(await vault.handle({ type: "vault_read", id: 1 })).toStrictEqual({
      type: "vault_result",
      id: 1,
      ok: false,
      error: "keychain_unavailable",
    });
    expect(await vault.handle({ type: "vault_write", id: 2, version: 1, data: "a" })).toMatchObject({
      error: "keychain_unavailable",
    });
    state.available = true;
    state.failEncrypt = true;
    expect(await vault.handle({ type: "vault_write", id: 3, version: 1, data: "a" })).toMatchObject({
      error: "keychain_unavailable",
    });
    await expect(stat(path)).rejects.toThrow("ENOENT");
  });

  it.each(["vault_read", "vault_write"] as const)(
    "answers keychain_unavailable when %s availability rejects, then continues queued requests",
    async (type) => {
      const { vault, state } = await keeper();
      await vault.handle({ type: "vault_read", id: 1 });
      state.rejectAvailabilityOnce = true;

      expect(
        await Promise.all([
          vault.handle({ type, id: 2, version: 1, data: "not-written" }),
          vault.handle({ type: "vault_write", id: 3, version: 1, data: "recovered" }),
          vault.handle({ type: "vault_read", id: 4 }),
        ]),
      ).toStrictEqual([
        { type: "vault_result", id: 2, ok: false, error: "keychain_unavailable" },
        { type: "vault_result", id: 3, ok: true },
        { type: "vault_result", id: 4, ok: true, version: 1, data: "recovered" },
      ]);
    },
  );

  it("answers io when the file cannot be written, leaving no temporary file", async () => {
    const { vault, path } = await keeper();
    await vault.handle({ type: "vault_read", id: 1 });
    // A folder where the file goes makes the rename fail.
    await mkdir(path, { recursive: true });

    expect(await vault.handle({ type: "vault_write", id: 2, version: 1, data: "a" })).toStrictEqual({
      type: "vault_result",
      id: 2,
      ok: false,
      error: "io",
    });
    expect(await readdir(join(path, ".."))).toStrictEqual(["vault.bin"]);
    expect(await vault.handle({ type: "vault_read", id: 3 })).toMatchObject({ error: "io" });
  });

  it("answers io even when temporary-file cleanup rejects, and accepts the next write", async () => {
    const { vault, dir } = await keeper();
    await vault.handle({ type: "vault_read", id: 1 });
    const parent = join(dir, "remote");
    await writeFile(parent, "not a directory");
    // This real filesystem failure affects both mkdir and the attempted temporary-file cleanup.
    await expect(rm(join(parent, ".probe.tmp"), { force: true })).rejects.toMatchObject({ code: "ENOTDIR" });

    expect(await vault.handle({ type: "vault_write", id: 2, version: 1, data: "not-written" })).toStrictEqual({
      type: "vault_result",
      id: 2,
      ok: false,
      error: "io",
    });
    await rm(parent);
    expect(await vault.handle({ type: "vault_write", id: 3, version: 1, data: "recovered" })).toStrictEqual({
      type: "vault_result",
      id: 3,
      ok: true,
    });
    expect(await vault.handle({ type: "vault_read", id: 4 })).toStrictEqual({
      type: "vault_result",
      id: 4,
      ok: true,
      version: 1,
      data: "recovered",
    });
  });

  it("handles requests one at a time, in the order they came", async () => {
    const { vault } = await keeper();
    const answers = await Promise.all([
      vault.handle({ type: "vault_write", id: 1, version: 1, data: "a" }),
      vault.handle({ type: "vault_write", id: 2, version: 2, data: "b" }),
      vault.handle({ type: "vault_read", id: 3 }),
    ]);

    expect(answers.map((answer) => answer?.ok)).toStrictEqual([true, true, true]);
    expect(answers[2]).toMatchObject({ version: 2, data: "b" });
  });

  it.each([
    { label: "invalid version", version: 0, data: "a" },
    { label: "invalid data", version: 1, data: 7 },
    { label: "oversized data", version: 1, data: "a".repeat(4 * 1024 * 1024 + 1) },
  ])("answers io for a known request with $label instead of dropping it", async ({ version, data }) => {
    const { vault, path } = await keeper();

    expect(await vault.handle({ type: "vault_write", id: 11, version, data })).toStrictEqual({
      type: "vault_result",
      id: 11,
      ok: false,
      error: "io",
    });
    await expect(stat(path)).rejects.toThrow("ENOENT");
    expect(await vault.handle({ type: "vault_write", id: 12, version: 1, data: "valid" })).toStrictEqual({
      type: "vault_result",
      id: 12,
      ok: true,
    });
    expect(await vault.handle({ type: "vault_read", id: 13 })).toStrictEqual({
      type: "vault_result",
      id: 13,
      ok: true,
      version: 1,
      data: "valid",
    });
  });

  it("ignores what is not a vault request", async () => {
    const { vault } = await keeper();

    for (const message of [
      null,
      { type: "shutdown" },
      { type: "vault_read", id: 0 },
      { type: "vault_read", id: 1.5 },
    ]) {
      expect(await vault.handle(message)).toBeNull();
    }
  });
});
