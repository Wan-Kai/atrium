import { z } from "zod";

/** Why the vault could not be read or written; never with the main process's own words. */
export type VaultError = "keychain_unavailable" | "corrupt" | "stale" | "io";

/** What reading the vault gave. */
export type VaultRead =
  | { readonly ok: true; readonly version: number; readonly data: string | null }
  | { readonly ok: false; readonly error: VaultError };

/** What writing the vault gave. */
export type VaultWrite = { readonly ok: true } | { readonly ok: false; readonly error: VaultError };

/**
 * The vault as the host reaches it: through Electron's main process, which encrypts with
 * `safeStorage` (SPEC-0005, "保险箱的进程交接").
 *
 * @remarks
 * The host never sees the keychain or the encrypted file; it hands over text and a version.
 */
export interface VaultPort {
  read(): Promise<VaultRead>;
  /** Writes `data` as `version`, which must be newer than the one the main process has. */
  write(version: number, data: string): Promise<VaultWrite>;
}

/** The main process's answer to one request. */
const VaultResult = z.union([
  z.strictObject({
    type: z.literal("vault_result"),
    id: z.number().int().positive(),
    ok: z.literal(true),
    version: z.number().int().nonnegative().optional(),
    data: z
      .string()
      .max(4 * 1024 * 1024)
      .nullable()
      .optional(),
  }),
  z.strictObject({
    type: z.literal("vault_result"),
    id: z.number().int().positive(),
    ok: z.literal(false),
    error: z.enum(["keychain_unavailable", "corrupt", "stale", "io"]),
  }),
]);

/** A vault over Electron's port, and where the port's vault answers go. */
export interface PortVault {
  readonly vault: VaultPort;
  /** Takes one message from the main process; answers whether it was a vault answer. */
  readonly receive: (message: unknown) => boolean;
}

/**
 * A vault that asks Electron's main process over the process port, matching answers by id.
 *
 * @remarks
 * Requests carry an increasing id; the main process answers each once, in its own order. A read
 * may wait as long as the keychain asks the user, so there is no time limit here: the host never
 * waits on it to start (SPEC-0005, "风险与待定问题" item 1). A malformed answer is ignored, and an
 * answer to no request too.
 *
 * @sideEffects none until used; then posts requests and keeps them until answered.
 * @param post - Posts one message to the main process.
 * @returns The vault and the receiver of the port's messages.
 */
export function portVault(post: (message: unknown) => void): PortVault {
  let nextId = 0;
  const waiting = new Map<number, (answer: z.infer<typeof VaultResult>) => void>();

  /**
   * Posts one request and waits for its answer.
   *
   * @remarks
   * The id is filled in here, so callers cannot reuse one.
   *
   * @sideEffects Posts a message; keeps the request until answered.
   * @param request - The request without its id.
   * @returns The answer.
   */
  function ask(request: Record<string, unknown>): Promise<z.infer<typeof VaultResult>> {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      post({ ...request, id });
    });
  }

  return {
    vault: {
      read: async () => {
        const answer = await ask({ type: "vault_read" });
        if (!answer.ok) return { ok: false, error: answer.error };
        return { ok: true, version: answer.version ?? 0, data: answer.data ?? null };
      },
      write: async (version, data) => {
        const answer = await ask({ type: "vault_write", version, data });
        return answer.ok ? { ok: true } : { ok: false, error: answer.error };
      },
    },
    receive: (message) => {
      const answer = VaultResult.safeParse(message);
      if (!answer.success) return false;
      const resolve = waiting.get(answer.data.id);
      waiting.delete(answer.data.id);
      resolve?.(answer.data);
      return true;
    },
  };
}

/**
 * The vault's contents, written whole each time and read back once at the start.
 *
 * @remarks
 * Only the host writes it (SPEC-0005, "概念 · 保险箱"). Writes go one after another, each with
 * the next version, so the main process never sees them out of order; a failed write does not use
 * up its version, so the next one can still follow the last that landed.
 *
 * @sideEffects Reads and writes through the port.
 */
export class VaultStore {
  readonly #port: VaultPort;
  #version = 0;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * Makes the store over a port.
   *
   * @remarks
   * Nothing is read until `load`.
   *
   * @sideEffects none
   * @param port - The vault's port.
   */
  constructor(port: VaultPort) {
    this.#port = port;
  }

  /**
   * Reads the vault and remembers its version.
   *
   * @remarks
   * A corrupt vault keeps version 0, which the main process lets a reset write over.
   *
   * @sideEffects Asks the main process, which may make the keychain ask the user.
   * @returns What it read.
   */
  async load(): Promise<VaultRead> {
    const read = await this.#port.read();
    if (read.ok) this.#version = read.version;
    return read;
  }

  /**
   * Writes the whole contents as the next version, after the writes before it.
   *
   * @remarks
   * See the class.
   *
   * @sideEffects Asks the main process to write the file.
   * @param data - The contents.
   * @returns What the write gave.
   */
  save(data: string): Promise<VaultWrite> {
    const written = this.#queue.then(async () => {
      const result = await this.#port.write(this.#version + 1, data);
      if (result.ok) this.#version += 1;
      return result;
    });
    this.#queue = written;
    return written;
  }
}
