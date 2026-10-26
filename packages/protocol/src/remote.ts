import { z } from "zod";

// The desktop's "手机" page: remote access through the relay (SPEC-0005, "宿主 · 给本机界面的命令和事件").
// Only local connections may use these; the phone never sees them.

/** Milliseconds since the Unix epoch, from the host's clock. */
const Timestamp = z.number().int().nonnegative();

/** A paired phone: `dev_` and 16 hex digits (SPEC-0005, "概念"). */
export const DeviceId = z.string().regex(/^dev_[0-9a-f]{16}$/);
export type DeviceId = z.infer<typeof DeviceId>;

/** One pairing under way: `pair_` and 16 hex digits. */
export const PairingId = z.string().regex(/^pair_[0-9a-f]{16}$/);
export type PairingId = z.infer<typeof PairingId>;

/**
 * The line `atrium-relay add-host` prints once: `atrium-relay://<hostId>:<token>@<host[:port]>[/prefix]`
 * (SPEC-0005, "部署 relay" item 4).
 */
export const RelayLine = z
  .string()
  .max(512)
  .regex(
    /^atrium-relay:\/\/hst_[0-9a-f]{16}:[A-Za-z0-9_-]{43}@(?:[A-Za-z0-9.-]+|\[::1\])(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/,
  );

/**
 * Where the vault stands (SPEC-0005, "MP3a 定的细节").
 *
 * @remarks
 * `unread` while remote access is off and the vault was never asked for; `waiting` while the main
 * process waits for the keychain; `unavailable` when the host runs without Electron.
 */
export const VaultStatus = z.enum(["unread", "waiting", "ok", "keychain_unavailable", "corrupt", "unavailable"]);
export type VaultStatus = z.infer<typeof VaultStatus>;

/** The control connection to the relay. */
export const RelayStatus = z.enum(["off", "connecting", "connected", "error"]);
export type RelayStatus = z.infer<typeof RelayStatus>;

/** Evidence from a finished check, never an inferred cause for an unobserved stage. */
export const RemoteDiagnosticCheck = z.enum(["passed", "failed", "unknown", "not_applicable"]);
export type RemoteDiagnosticCheck = z.infer<typeof RemoteDiagnosticCheck>;

/** Safe failure categories: no raw errors, certificates, paths or credentials. */
export const RemoteDiagnosticFailure = z.enum([
  "resolution_failed",
  "tcp_connect_failed",
  "tls_failed",
  "websocket_upgrade_failed",
  "token_rejected",
  "timeout",
  "connection_closed",
  "unknown",
]);
export type RemoteDiagnosticFailure = z.infer<typeof RemoteDiagnosticFailure>;

/** The last finished connection or same-socket liveness check; not persisted. */
export const RemoteRelayDiagnostics = z.strictObject({
  kind: z.enum(["connect", "live"]),
  checkedAt: Timestamp,
  /** TCP connectivity to this relay, not general Internet availability. */
  network: RemoteDiagnosticCheck,
  resolution: RemoteDiagnosticCheck,
  tls: RemoteDiagnosticCheck,
  token: RemoteDiagnosticCheck,
  failure: RemoteDiagnosticFailure.nullable(),
});
export type RemoteRelayDiagnostics = z.infer<typeof RemoteRelayDiagnostics>;

/** The relay this host uses; the token never leaves the host. */
export const RemoteRelay = z.strictObject({
  /** `wss://<publicHost><pathPrefix>`, without the token. */
  url: z.string().min(1).max(512),
  hostId: z.string().regex(/^hst_[0-9a-f]{16}$/),
  status: RelayStatus,
  /** Why the last attempt failed, while `status` is `error` or `connecting` again. */
  error: z.enum(["relay_unreachable", "relay_rejected"]).nullable(),
  lastConnectedAt: Timestamp.nullable(),
  /** Null until a check finishes; live checks do not reauthenticate or redo DNS/TLS. */
  diagnostics: RemoteRelayDiagnostics.nullable(),
});
export type RemoteRelay = z.infer<typeof RemoteRelay>;

/** A paired phone as the "手机" page lists it. */
export const RemoteDevice = z.strictObject({
  deviceId: DeviceId,
  /** The name given on the Mac, else the one the phone reported when it paired. */
  name: z.string().min(1).max(64),
  /** Self-reported when paired, not hardware attestation; blank stored values project to null. */
  model: z.string().min(1).max(64).nullable(),
  pairedAt: Timestamp,
  lastSeenAt: Timestamp.nullable(),
  online: z.boolean(),
  /** Bytes per second over the last two seconds: `down` to the phone, `up` from it. */
  traffic: z.strictObject({ down: z.number().nonnegative(), up: z.number().nonnegative() }),
});
export type RemoteDevice = z.infer<typeof RemoteDevice>;

/** A pairing's states (SPEC-0005, "配对流程"). */
export const PairingState = z.enum(["available", "awaiting_confirmation", "committed", "rejected", "expired"]);
export type PairingState = z.infer<typeof PairingState>;

/** Why a pairing ended without a device (SPEC-0005, "MP3a 定的细节"). */
export const PairingEndReason = z.enum(["cancelled", "declined", "timeout", "disconnected", "vault_failed"]);
export type PairingEndReason = z.infer<typeof PairingEndReason>;

/** The pairing under way, or the last one until the next starts. */
export const RemotePairing = z.strictObject({
  pairingId: PairingId,
  /** The `atrium://pair?…` text of the QR code; it holds the one-time key, so it is never logged. */
  qr: z.string().min(1).max(2048),
  expiresAt: Timestamp,
  state: PairingState,
  /** Current candidates await encrypted key confirmation; M1 alone is not proof of the PSK. */
  handshaking: z.boolean(),
  reason: PairingEndReason.nullable(),
  /** The phone waiting for the Mac's answer, with the SAS both show. */
  request: z
    .strictObject({
      deviceName: z.string().max(64),
      model: z.string().max(64),
      sas: z.string().regex(/^\d{6}$/),
    })
    .nullable(),
  /** Phones turned away because another was already being confirmed. */
  refused: z.number().int().nonnegative(),
});
export type RemotePairing = z.infer<typeof RemotePairing>;

/** Everything the "手机" page shows. */
export const RemoteState = z.strictObject({
  enabled: z.boolean(),
  vault: VaultStatus,
  /** `null` until a relay line was given. */
  relay: RemoteRelay.nullable(),
  /** The first 8 bytes of SHA-256 of the host's public key, hex; the UI groups it. `null` before there is a key. */
  hostFingerprint: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .nullable(),
  devices: z.array(RemoteDevice).max(256),
  pairing: RemotePairing.nullable(),
});
export type RemoteState = z.infer<typeof RemoteState>;

/** The remote state changed; sent whole to the local connections that watch it (`get_remote({ watch: true })`). */
export const RemoteUpdatedEvent = z.strictObject({ type: z.literal("remote_updated"), remote: RemoteState });
export type RemoteUpdatedEvent = z.infer<typeof RemoteUpdatedEvent>;
