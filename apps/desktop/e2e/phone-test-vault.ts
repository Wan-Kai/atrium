import { expect, type ElectronApplication } from "@playwright/test";

/**
 * Replaces safeStorage only inside the new test App, before enabling remote access.
 * @remarks The keeper calls these properties dynamically. Opaque file bytes reference an in-process
 * map, not a keychain or a reversible plaintext file. Never restore native functions during shutdown.
 * This is fake-platform IPC coverage, not a Keychain test.
 * @sideEffects Replaces the isolated Electron process's platform methods and verifies their identity/round trip.
 * @param app - A newly launched test App with remote access still disabled.
 */
export async function installPhoneTestVault(app: ElectronApplication): Promise<void> {
  const verified = await app.evaluate(async ({ safeStorage }) => {
    const values = new Map<string, string>();
    let sequence = 0;
    // oxlint-disable unicorn/consistent-function-scoping -- these functions must be serialized inside evaluate into the separate test App process.
    /** Refuses unexpected native/synchronous paths. @remarks No native fallback is safe. @sideEffects none @throws Always. */
    const denied = (): never => {
      throw new Error("native safeStorage is forbidden in phone e2e");
    };
    /** Reports only the fake platform. @remarks Never probes the real keychain. @sideEffects none */
    const available = async (): Promise<boolean> => true;
    // oxlint-enable unicorn/consistent-function-scoping
    /** Makes opaque synthetic bytes. @remarks Plaintext lives only in this process. @sideEffects Updates the fake map. */
    const encrypt = async (text: string): Promise<Buffer> => {
      const key = `e2e-phone-vault:${++sequence}`;
      values.set(key, text);
      return Buffer.from(key);
    };
    /** Accepts only this process's synthetic bytes. @remarks Unknown files fail closed. @sideEffects none */
    const decrypt = async (data: Buffer): Promise<Electron.DecryptStringAsyncReturnValue> => {
      const result = values.get(data.toString());
      if (result === undefined) throw new Error("not a synthetic phone vault");
      return { result, shouldReEncrypt: false };
    };
    safeStorage.isEncryptionAvailable = denied;
    safeStorage.encryptString = denied;
    safeStorage.decryptString = denied;
    safeStorage.setUsePlainTextEncryption = denied;
    safeStorage.getSelectedStorageBackend = denied;
    safeStorage.isAsyncEncryptionAvailable = available;
    safeStorage.encryptStringAsync = encrypt;
    safeStorage.decryptStringAsync = decrypt;
    const installed =
      safeStorage.isEncryptionAvailable === denied &&
      safeStorage.encryptString === denied &&
      safeStorage.decryptString === denied &&
      safeStorage.setUsePlainTextEncryption === denied &&
      safeStorage.getSelectedStorageBackend === denied &&
      safeStorage.isAsyncEncryptionAvailable === available &&
      safeStorage.encryptStringAsync === encrypt &&
      safeStorage.decryptStringAsync === decrypt;
    if (!installed) return false;
    const bytes = await safeStorage.encryptStringAsync("synthetic round-trip probe");
    const result = await safeStorage.decryptStringAsync(bytes);
    return (
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      /^e2e-phone-vault:\d+$/.test(bytes.toString()) &&
      result.result === "synthetic round-trip probe" &&
      !result.shouldReEncrypt
    );
  });
  expect(verified, "all fake safeStorage methods must be installed before enabling remote access").toBe(true);
}
