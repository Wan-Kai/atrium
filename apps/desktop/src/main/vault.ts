import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How the main process encrypts: Electron's `safeStorage`, passed in so tests need no keychain. */
export interface VaultCrypto {
  /** Whether the keychain can be used at all. */
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

/** A request from the host (SPEC-0005, "保险箱的进程交接"). */
type VaultRequest =
  | { readonly type: "vault_read"; readonly id: number }
  | { readonly type: "vault_write"; readonly id: number; readonly version: number; readonly data: string };

/** The largest vault text the host may hand over. */
const MAX_DATA = 4 * 1024 * 1024;

/**
 * Reads a message from the host as a vault request.
 *
 * @remarks
 * The main process does not bundle zod, so the two shapes are checked by hand. A known request
 * with a valid id but invalid contents must get an error, not leave the host waiting forever.
 *
 * @sideEffects none
 * @param message - The message.
 * @returns The request, an invalid request with its id, or `null` for unrelated messages.
 */
function vaultRequest(message: unknown): VaultRequest | { readonly type: "invalid"; readonly id: number } | null {
  if (typeof message !== "object" || message === null) return null;
  const type: unknown = Reflect.get(message, "type");
  const id: unknown = Reflect.get(message, "id");
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return null;
  if (type === "vault_read") return { type, id };
  if (type !== "vault_write") return null;
  const version: unknown = Reflect.get(message, "version");
  const data: unknown = Reflect.get(message, "data");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { type: "invalid", id };
  if (typeof data !== "string" || data.length > MAX_DATA) return { type: "invalid", id };
  return { type, id, version, data };
}

/**
 * Reads the decrypted file as its version and the host's text.
 *
 * @remarks
 * Anything else means the file is damaged.
 *
 * @sideEffects none
 * @param text - The decrypted text.
 * @returns The contents, or `null`.
 */
function vaultContents(text: string): { version: number; data: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const version: unknown = Reflect.get(value, "version");
  const data: unknown = Reflect.get(value, "data");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || typeof data !== "string") return null;
  return { version, data };
}

/** The answer to one request, as posted back to the host. */
type VaultResult =
  | { type: "vault_result"; id: number; ok: true; version?: number; data?: string | null }
  | { type: "vault_result"; id: number; ok: false; error: "keychain_unavailable" | "corrupt" | "stale" | "io" };

/** The main process's side of the vault. */
export interface VaultKeeper {
  /**
   * Handles one message from the host.
   *
   * @returns The answer to post back, or `null` when the message was not a vault request.
   */
  handle(message: unknown): Promise<VaultResult | null>;
}

/**
 * Keeps the remote vault for the host: decrypts it on request and writes it encrypted.
 *
 * @remarks
 * SPEC-0005, "保险箱的进程交接" and "MP3a 定的细节". The host is the only writer; requests are
 * handled one at a time in the order they came, so writes land in order. The version last read or
 * written is kept here and a write whose version is not newer is refused as stale; an unreadable
 * file counts as version 0, so the host's reset can replace it. A write goes to a temporary file
 * beside the vault (mode 0600) and is renamed over it, in a folder of mode 0700. Every failure is
 * answered with a code and never falls back to plain text: no keychain, a file that does not
 * decrypt or parse, a write that fails. The keychain may ask the user first, which the async
 * `safeStorage` calls wait for without blocking the window.
 *
 * @sideEffects none until `handle` is called; then reads and writes the vault file.
 * @param options - Where the vault lives and how to encrypt.
 * @returns The keeper.
 */
export function createVaultKeeper(options: { readonly path: string; readonly crypto: VaultCrypto }): VaultKeeper {
  let queue: Promise<unknown> = Promise.resolve();
  /** The version on disk, once known. */
  let current: number | null = null;

  /**
   * Reads and decrypts the file.
   *
   * @remarks
   * Remembers its version for the stale check.
   *
   * @sideEffects Reads the file; may make the keychain ask the user.
   * @param id - The request's id.
   * @returns The answer.
   */
  async function read(id: number): Promise<VaultResult> {
    if (!(await options.crypto.available().catch(() => false)))
      return { type: "vault_result", id, ok: false, error: "keychain_unavailable" };
    let encrypted: Buffer;
    try {
      encrypted = await readFile(options.path);
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
        current = 0;
        return { type: "vault_result", id, ok: true, version: 0, data: null };
      }
      return { type: "vault_result", id, ok: false, error: "io" };
    }
    const contents = await options.crypto.decrypt(encrypted).then(vaultContents, () => null);
    if (contents === null) {
      current = 0;
      return { type: "vault_result", id, ok: false, error: "corrupt" };
    }
    current = contents.version;
    return { type: "vault_result", id, ok: true, version: contents.version, data: contents.data };
  }

  /**
   * Encrypts and writes the file through a temporary file and a rename.
   *
   * @remarks
   * Learns the version on disk first when nothing was read yet.
   *
   * @sideEffects Writes, renames and on failure removes files; may make the keychain ask.
   * @param id - The request's id.
   * @param version - The new version.
   * @param data - The host's text.
   * @returns The answer.
   */
  async function write(id: number, version: number, data: string): Promise<VaultResult> {
    if (current === null) {
      const before = await read(id);
      if (!before.ok && before.error !== "corrupt") return before;
    }
    if (version <= (current ?? 0)) return { type: "vault_result", id, ok: false, error: "stale" };
    if (!(await options.crypto.available().catch(() => false)))
      return { type: "vault_result", id, ok: false, error: "keychain_unavailable" };
    let encrypted: Buffer;
    try {
      encrypted = await options.crypto.encrypt(JSON.stringify({ version, data }));
    } catch {
      return { type: "vault_result", id, ok: false, error: "keychain_unavailable" };
    }
    const temporary = join(dirname(options.path), `.vault-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, options.path);
    } catch {
      await rm(temporary, { force: true });
      return { type: "vault_result", id, ok: false, error: "io" };
    }
    current = version;
    return { type: "vault_result", id, ok: true };
  }

  return {
    handle(message) {
      const data = vaultRequest(message);
      if (data === null) return Promise.resolve(null);
      if (data.type === "invalid")
        return Promise.resolve({ type: "vault_result", id: data.id, ok: false, error: "io" });
      const answer = queue
        .then(() => (data.type === "vault_read" ? read(data.id) : write(data.id, data.version, data.data)))
        // Cleanup can fail too: still answer this request and keep later requests runnable.
        .catch((): VaultResult => ({ type: "vault_result", id: data.id, ok: false, error: "io" }));
      queue = answer;
      return answer;
    },
  };
}
