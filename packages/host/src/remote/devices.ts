import { DeviceId } from "@atrium/protocol";
import { fromBase64Url } from "@atrium/remote-crypto";
import { z } from "zod";
import type { IndexFileSpec } from "../store/index-file";

/** A paired phone as the vault keeps it (SPEC-0005, "概念 · 设备"). */
const VaultDevice = z.strictObject({
  deviceId: DeviceId,
  /** X25519 public key, base64url. */
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** The name the phone reported when it paired. */
  reportedName: z.string().min(1).max(64),
  /** The name given on the Mac, or `null` for the reported one. */
  name: z.string().min(1).max(64).nullable(),
  model: z.string().max(64),
  pairedAt: z.number().int().nonnegative(),
});
export type VaultDevice = z.infer<typeof VaultDevice>;

/** Everything secret about remote access, written whole into the vault. */
const VaultContents = z.strictObject({
  format: z.literal(1),
  /** The host's X25519 private key, base64url. */
  hostKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** The `atrium-relay://` line with the host token, or `null` before one was given. */
  relay: z.string().max(512).nullable(),
  devices: z.array(VaultDevice).max(256),
});
export type VaultContents = z.infer<typeof VaultContents>;

/**
 * Reads the vault's text.
 *
 * @remarks
 * Anything that does not parse is a damaged vault: remote access stays off until it is reset, and
 * the host never makes a new identity by itself (SPEC-0005, "保险箱的进程交接").
 *
 * @sideEffects none
 * @param text - What the main process decrypted.
 * @returns The contents, or `null`.
 */
export function parseVault(text: string): VaultContents | null {
  try {
    const parsed = VaultContents.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    fromBase64Url(parsed.data.hostKey, 32);
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const device of parsed.data.devices) {
      fromBase64Url(device.publicKey, 32);
      if (ids.has(device.deviceId) || keys.has(device.publicKey)) return null;
      ids.add(device.deviceId);
      keys.add(device.publicKey);
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/** What `remote.json` keeps: nothing secret (SPEC-0005, "MP3a 定的细节"). */
const RemoteDocument = z.looseObject({
  enabled: z.boolean(),
  /** When each device was last online. */
  lastSeen: z.record(z.string(), z.number().int().nonnegative()),
});
export type RemoteDocument = z.infer<typeof RemoteDocument>;

/** `remote.json` in Atrium's home (domain-model §1, "索引的存储"). */
export const REMOTE_FILE: IndexFileSpec<RemoteDocument> = {
  name: "remote",
  version: 1,
  schema: RemoteDocument,
  empty: () => ({ enabled: false, lastSeen: {} }),
};

/**
 * The name a device goes by: the one given on the Mac, else the one it reported.
 *
 * @remarks
 * Clearing the given name brings the reported one back (SPEC-0005, "给本机界面的命令和事件").
 *
 * @sideEffects none
 * @param device - The device.
 * @returns Its name.
 */
export function nameOf(device: VaultDevice): string {
  return device.name ?? device.reportedName;
}
