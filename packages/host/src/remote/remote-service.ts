import { createHash, randomBytes } from "node:crypto";
import {
  CommandError,
  PROTOCOL_VERSION,
  type RemoteRelayDiagnostics,
  type RemoteState,
  type RemoteUpdatedEvent,
} from "@atrium/protocol";
import {
  fromBase64Url,
  fromUtf8,
  generateKeyPair,
  HandshakeState,
  keyPairFrom,
  prologue,
  sas,
  toBase64Url,
  utf8,
  type ControlMessage,
  type Pattern,
} from "@atrium/remote-crypto";
import { z } from "zod";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import type { RemoteCommands } from "../server/router";
import type { ClientTransport, TransportOrigin } from "../server/transport";
import type { IndexFile } from "../store/index-file";
import { PhoneStream, SILENCE_MS, reasonOf } from "./channel";
import { nameOf, parseVault, type RemoteDocument, type VaultContents } from "./devices";
import { PairingMachine } from "./pairing";
import { parseRelayLine, type RelayEndpoint } from "./relay-line";
import { RelayLink, probeRelay } from "./relay-link";
import { VaultStore, type VaultPort } from "./vault";

/** The bounded authenticated payload shared by both handshakes. */
const ConnectPayload = z.object({
  kind: z.literal("connect"),
  appVersion: z.string().max(128),
  protocolVersion: z.number().int(),
});
const PairPayload = z.object({
  kind: z.literal("pair"),
  pairingId: z.string().regex(/^pair_[0-9a-f]{16}$/),
  deviceName: z.string().min(1).max(64),
  model: z.string().max(64),
  appVersion: z.string().max(128),
  protocolVersion: z.number().int(),
});
type PairPayload = z.infer<typeof PairPayload>;

/** Dependencies of remote access, separate from local server startup. */
export interface RemoteOptions {
  readonly vault: VaultPort | undefined;
  readonly index: IndexFile<RemoteDocument>;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  readonly hostName: string;
  readonly send: (connectionId: string, event: RemoteUpdatedEvent) => void;
  readonly accept: (transport: ClientTransport, origin: TransportOrigin) => void;
}

/**
 * Owns remote access and implements the local-only management commands.
 * @remarks The vault is loaded lazily. Only successful writes replace trusted state; revocation
 * blocks immediately even if its write fails. Each stream has its own authenticated identity.
 * @sideEffects Reads and writes storage, connects to the relay and publishes local status.
 */
export class RemoteService implements RemoteCommands {
  readonly #options: RemoteOptions;
  readonly #store: VaultStore | null;
  readonly #pairing: PairingMachine<PhoneStream>;
  readonly #streams = new Set<PhoneStream>();
  readonly #draining = new Set<Promise<void>>();
  readonly #totals = new Map<string, { down: number; up: number }>();
  readonly #pairPhones = new Map<PhoneStream, PairPayload & { generation: number }>();
  #generation = 0;
  #probeDiagnostics: RemoteRelayDiagnostics | null = null;
  #cancelHandshakeNotice: (() => void) | null = null;
  #publishedHandshaking = false;
  readonly #blocked = new Set<string>();
  readonly #revocations = new Map<string, number>();
  #revocationSerial = 0;
  #probe: { controller: AbortController; done: Promise<"relay_unreachable" | "relay_rejected" | null> } | null = null;
  readonly #watchers = new Set<string>();
  #contents: VaultContents | null = null;
  #vault: RemoteState["vault"];
  #enabled: boolean;
  #closed = false;
  #disconnecting = 0;
  #loading: Promise<void> | null = null;
  #writes: Promise<unknown> = Promise.resolve();
  #link: RelayLink | null = null;
  #cancelTraffic: (() => void) | null = null;
  #pairHeartbeat: { stream: PhoneStream; cancel: () => void } | null = null;
  #samples: { at: number; totals: Map<string, { down: number; up: number }> }[] = [];
  readonly #traffic = new Map<string, { down: number; up: number }>();

  /** Creates an idle service. @remarks Startup never waits for the keychain. @sideEffects none */
  constructor(options: RemoteOptions) {
    this.#options = { ...options, logger: options.logger.child({ trace_id: randomBytes(16).toString("hex") }) };
    this.#store = options.vault === undefined ? null : new VaultStore(options.vault);
    this.#vault = this.#store === null ? "unavailable" : "unread";
    this.#enabled = options.index.read().enabled;
    this.#pairing = new PairingMachine({
      clock: options.clock,
      resources: options.resources,
      onChange: () => this.#changed(),
      onEnded: ({ reason, stream }) => {
        stream.sendControl({ kind: "pair_rejected", reason: reason === "declined" ? "rejected" : reason });
        stream.close("pairing_ended");
      },
    });
  }

  /** Starts a previously enabled service in the background. @remarks Local startup stays independent. @sideEffects May read the vault and connect. */
  start(): void {
    if (!this.#enabled || this.#closed) return;
    void this.#ensure()
      .then(() => this.#connect())
      .catch(() => this.#changed());
  }

  /**
   * Reads state and changes a local subscription.
   * @remarks Tokens never leave this module.
   * @sideEffects May start traffic sampling.
   * @param connectionId - Local connection.
   * @param watch - Whether to subscribe, or leave the subscription unchanged.
   */
  get(connectionId: string, watch: boolean | undefined): RemoteState {
    if (watch === true && !this.#closed) {
      this.#watchers.add(connectionId);
      this.#sampleTraffic();
    } else if (watch === false) this.unwatch(connectionId);
    const view = this.#view();
    if (watch === true && view.pairing?.handshaking === true) this.#publishedHandshaking = true;
    return view;
  }

  /**
   * Removes a local subscriber.
   * @remarks No subscribers means no traffic timers.
   * @sideEffects May cancel sampling.
   * @param connectionId - Local connection.
   */
  unwatch(connectionId: string): void {
    this.#watchers.delete(connectionId);
    if (this.#watchers.size !== 0) return;
    this.#cancelTraffic?.();
    this.#cancelTraffic = null;
    this.#cancelHandshakeNotice?.();
    this.#cancelHandshakeNotice = null;
    this.#publishedHandshaking = false;
    this.#samples = [];
    this.#totals.clear();
    this.#traffic.clear();
  }

  /**
   * Sets availability and optionally changes the relay.
   * @remarks Disable does not wait for a keychain read.
   * @sideEffects Writes storage and changes connections.
   * @param enabled - Desired switch.
   * @param relay - Optional replacement credentials.
   */
  async set(enabled: boolean, relay: string | undefined): Promise<Record<string, never>> {
    if (this.#store === null || this.#closed) throw new CommandError("remote_unavailable");
    if (relay !== undefined && parseRelayLine(relay) === null) throw new CommandError("relay_unreachable");
    this.#enabled = enabled;
    if (!enabled) await this.#disconnect();
    await this.#saveIndex();
    this.#changed();
    if (!enabled && relay === undefined) {
      this.#connect();
      return {};
    }
    await this.#ensure();
    if (relay !== undefined) {
      await this.#serialize(async () => {
        const current = this.#trusted();
        await this.#save({ ...current, relay });
        this.#pairing.cancel();
        await this.#disconnect();
      });
    }
    this.#connect();
    this.#changed();
    return {};
  }

  /** Tests relay authentication without displacing our own link. @remarks Attempts have a ten-second deadline. @sideEffects Connects to the relay. */
  async testRelay(): Promise<Record<string, never>> {
    await this.#ensure();
    const endpoint = this.#relay();
    if (endpoint === null || this.#closed) throw new CommandError("remote_unavailable");
    this.#connect();
    if (this.#link === null && this.#probe === null) {
      const controller = new AbortController();
      const generation = this.#generation;
      const done = probeRelay(endpoint, {
        ...this.#options,
        signal: controller.signal,
        onDiagnostics: (diagnostics) => {
          if (controller.signal.aborted || generation !== this.#generation || this.#closed) return;
          this.#probeDiagnostics = diagnostics;
          this.#changed();
        },
      }).finally(() => {
        if (this.#probe?.controller === controller) this.#probe = null;
        this.#connect();
      });
      this.#probe = { controller, done };
    }
    const error = this.#link === null ? await this.#probe!.done : await this.#link.retryNow();
    if (error !== null) throw new CommandError(error);
    return {};
  }

  /** Issues a one-time pairing code. @remarks Its secret is sent only to local watchers. @sideEffects Starts expiry and publishes state. */
  startPairing(): { pairingId: string } {
    const endpoint = this.#relay();
    if (!this.#enabled || this.#vault !== "ok" || endpoint === null || this.#closed)
      throw new CommandError("remote_unavailable");
    const key = keyPairFrom(fromBase64Url(this.#trusted().hostKey, 32));
    const pairingId = `pair_${randomBytes(8).toString("hex")}`;
    const psk = new Uint8Array(randomBytes(32));
    const query = Object.entries({
      v: "1",
      relay: endpoint.url,
      host: endpoint.hostId,
      key: toBase64Url(key.publicKey),
      pairing: pairingId,
      psk: toBase64Url(psk),
      name: this.#options.hostName,
    })
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("&");
    if (!this.#pairing.start({ pairingId, psk, qr: `atrium://pair?${query}` })) throw new CommandError("pairing_busy");
    return { pairingId };
  }

  /** Cancels the current code. @remarks A confirmed vault write remains authoritative. @sideEffects May close a waiting phone. */
  cancelPairing(): Record<string, never> {
    this.#pairing.cancel();
    return {};
  }

  /**
   * Confirms one phone and durably records it before granting access.
   * @remarks Re-pairing preserves device identity.
   * @sideEffects Writes the vault, sends paired and accepts the transport.
   * @param pairingId - The code being confirmed.
   * @param accept - The local user's answer.
   */
  async confirmPairing(pairingId: string, accept: boolean): Promise<Record<string, never>> {
    const claim = this.#pairing.answer(pairingId, accept);
    if (claim === null) throw new CommandError("pairing_expired");
    if (claim === "declined") return {};
    const acceptedAt = this.#revocationSerial;
    // Preserve the identity the user confirmed even if an earlier queued revoke removes its record.
    const acceptedDevice = this.#contents?.devices.find((device) => device.publicKey === claim.publicKey);
    return this.#serialize(async () => {
      // A reset invalidates queued confirmations; never fail a newer pairing on their behalf.
      if (this.#pairing.view()?.pairingId !== pairingId) throw new CommandError("pairing_expired");
      try {
        const current = this.#trusted();
        const previous = current.devices.find((device) => device.publicKey === claim.publicKey) ?? acceptedDevice;
        const device = {
          deviceId: previous?.deviceId ?? `dev_${randomBytes(8).toString("hex")}`,
          publicKey: claim.publicKey,
          reportedName: claim.deviceName,
          model: claim.model,
          name: previous?.name ?? null,
          pairedAt: this.#options.clock.now(),
        };
        const devices = current.devices.filter((one) => one.publicKey !== claim.publicKey);
        if (devices.length >= 256) throw new CommandError("remote_unavailable");
        await this.#save({ ...current, devices: [...devices, device] });
        const revokedAfterAcceptance = (this.#revocations.get(device.deviceId) ?? 0) > acceptedAt;
        if (!revokedAfterAcceptance) this.#blocked.delete(device.deviceId);
        this.#pairing.committed();
        if (revokedAfterAcceptance) claim.stream.close("revoked");
        if (!revokedAfterAcceptance && !this.#closed && this.#enabled && !claim.stream.closed) {
          claim.stream.sendControl({ kind: "paired", deviceId: device.deviceId, hostName: this.#options.hostName });
          this.#session(claim.stream, device.deviceId);
        }
        this.#changed();
        return {};
      } catch (error) {
        this.#pairing.failed();
        claim.stream.sendControl({ kind: "pair_rejected", reason: "host_error" });
        claim.stream.close("vault_failed");
        throw error;
      }
    });
  }

  /**
   * Renames a known device.
   * @remarks Empty restores the reported name.
   * @sideEffects Writes the vault and publishes state.
   * @param deviceId - Device to rename.
   * @param name - Replacement name.
   */
  renameDevice(deviceId: string, name: string): Promise<Record<string, never>> {
    return this.#serialize(async () => {
      const current = this.#trusted();
      if (!current.devices.some((device) => device.deviceId === deviceId) || this.#blocked.has(deviceId))
        throw new CommandError("device_not_found");
      await this.#save({
        ...current,
        devices: current.devices.map((device) =>
          device.deviceId === deviceId ? { ...device, name: name || null } : device,
        ),
      });
      this.#changed();
      return {};
    });
  }

  /**
   * Revokes immediately, then persists removal.
   * @remarks Failed writes remain blocked and retryable; repeated revocation also supersedes queued re-pairing.
   * @sideEffects Closes all device streams and writes the vault.
   * @param deviceId - Device to revoke.
   */
  async revokeDevice(deviceId: string): Promise<Record<string, never>> {
    if (!this.#trusted().devices.some((device) => device.deviceId === deviceId) && !this.#blocked.has(deviceId))
      throw new CommandError("device_not_found");
    this.#blocked.add(deviceId);
    this.#revocations.set(deviceId, ++this.#revocationSerial);
    for (const stream of this.#streams)
      if (stream.deviceId === deviceId) {
        stream.sendControl({ kind: "revoked" });
        stream.close("revoked");
      }
    this.#changed();
    return this.#serialize(async () => {
      const current = this.#trusted();
      await this.#save({ ...current, devices: current.devices.filter((device) => device.deviceId !== deviceId) });
      this.#changed();
      return {};
    });
  }

  /** Replaces the identity only after its durable write. @remarks Explicit recovery from a corrupt vault. @sideEffects Writes keys and revokes existing channels. */
  async resetIdentity(): Promise<Record<string, never>> {
    if (this.#store === null || this.#closed) throw new CommandError("remote_unavailable");
    try {
      await this.#ensure();
    } catch {
      if (this.#vault !== "corrupt") throw new CommandError("keychain_unavailable");
    }
    return this.#serialize(async () => {
      await this.#save({
        format: 1,
        hostKey: toBase64Url(generateKeyPair().secretKey),
        relay: this.#contents?.relay ?? null,
        devices: [],
      });
      this.#blocked.clear();
      for (const stream of this.#streams) stream.sendControl({ kind: "revoked" });
      await this.#disconnect("identity_reset");
      this.#pairing.dispose();
      this.#changed();
      this.#connect();
      return {};
    });
  }

  /** Shuts down remote resources. @remarks A pending keychain read cannot hold local shutdown hostage. @sideEffects Closes sockets and timers and flushes the index. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const watcher of this.#watchers) this.unwatch(watcher);
    await this.#disconnect();
    await this.#writes;
    await this.#options.index.flush();
  }

  /** Loads trusted storage once. @remarks Missing is distinct from malformed. @sideEffects May initialize an absent vault. */
  #ensure(): Promise<void> {
    if (this.#closed || this.#store === null) return Promise.reject(new CommandError("remote_unavailable"));
    if (this.#vault === "ok") return Promise.resolve();
    if (this.#loading !== null) return this.#loading;
    this.#vault = "waiting";
    this.#changed();
    this.#loading = this.#load().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  /** Decodes one vault response, failing closed. @remarks Never logs decrypted content. @sideEffects Reads and possibly writes storage and publishes status. */
  async #load(): Promise<void> {
    try {
      const read = await this.#store!.load();
      if (!read.ok) {
        this.#vault = read.error === "corrupt" ? "corrupt" : "keychain_unavailable";
        throw new CommandError(this.#vault === "corrupt" ? "vault_corrupt" : "keychain_unavailable");
      }
      if (this.#closed) return;
      if (read.data === null) {
        await this.#save({ format: 1, hostKey: toBase64Url(generateKeyPair().secretKey), relay: null, devices: [] });
      } else {
        const parsed = parseVault(read.data);
        if (parsed === null || (parsed.relay !== null && parseRelayLine(parsed.relay) === null)) {
          this.#vault = "corrupt";
          throw new CommandError("vault_corrupt");
        }
        this.#contents = parsed;
        this.#vault = "ok";
      }
    } catch (error) {
      if (this.#vault === "waiting") this.#vault = "keychain_unavailable";
      if (error instanceof CommandError) throw error;
      throw new CommandError("keychain_unavailable");
    } finally {
      this.#changed();
    }
  }

  /** Returns trusted in-memory content. @remarks No operation silently creates an identity. @sideEffects none */
  #trusted(): VaultContents {
    if (this.#vault !== "ok" || this.#contents === null)
      throw new CommandError(
        this.#vault === "corrupt"
          ? "vault_corrupt"
          : this.#vault === "keychain_unavailable"
            ? "keychain_unavailable"
            : "remote_unavailable",
      );
    return this.#contents;
  }

  /**
   * Saves then swaps trusted state.
   * @remarks A failed save leaves the old identity and devices intact.
   * @sideEffects Writes encrypted storage through IPC.
   * @param contents - Complete replacement.
   */
  async #save(contents: VaultContents): Promise<void> {
    if (this.#store === null) throw new CommandError("remote_unavailable");
    const result = await this.#store.save(JSON.stringify(contents));
    if (!result.ok) throw new CommandError(result.error === "corrupt" ? "vault_corrupt" : "keychain_unavailable");
    this.#contents = contents;
    this.#vault = "ok";
  }

  /**
   * Serializes read-modify-write operations.
   * @remarks One failure never poisons the next command.
   * @sideEffects Queues work.
   * @param operation - Operation to run after earlier writes.
   */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#writes.then(operation);
    this.#writes = pending.catch(() => {});
    return pending;
  }

  /** Derives the current endpoint. @remarks Credentials remain internal. @sideEffects none */
  #relay(): RelayEndpoint | null {
    return this.#contents?.relay == null ? null : parseRelayLine(this.#contents.relay);
  }

  /** Starts the control connection when all prerequisites hold. @remarks Never connects after shutdown or disable. @sideEffects Opens a relay link. */
  #connect(): void {
    if (this.#closed || this.#disconnecting > 0 || !this.#enabled || this.#vault !== "ok" || this.#link !== null)
      return;
    if (this.#probe !== null) {
      this.#probe.controller.abort();
      return;
    }
    const endpoint = this.#relay();
    if (endpoint === null) return;
    this.#generation++;
    this.#probeDiagnostics = null;
    this.#link = new RelayLink({
      ...this.#options,
      endpoint,
      onState: (state) => {
        if (state.status === "error") {
          this.#generation++;
          for (const stream of this.#streams) stream.close("relay_closed");
        }
        this.#changed();
      },
      onStream: (id) => this.#open(id, endpoint),
    });
    this.#link.start();
  }

  /**
   * Ends all remote connections.
   * @remarks Confirmed writes may still finish, but cannot restore access while off.
   * @sideEffects Cancels pairing and closes sockets.
   * @param reason - Internal close reason for this generation.
   */
  async #disconnect(reason = "remote_off"): Promise<void> {
    this.#disconnecting++;
    this.#generation++;
    this.#probeDiagnostics = null;
    const probe = this.#probe;
    probe?.controller.abort();
    const link = this.#link;
    this.#link = null;
    this.#pairing.cancel();
    for (const stream of this.#streams) stream.close(reason);
    await link?.stop();
    await probe?.done;
    await Promise.all(this.#draining);
    this.#disconnecting--;
    this.#changed();
  }

  /**
   * Admits a bounded number of unauthenticated streams.
   * @remarks A compromised relay cannot bypass the host limit.
   * @sideEffects Opens a data socket or refuses the stream.
   * @param streamId - Relay stream.
   * @param endpoint - Credentials of this connection's generation.
   */
  #open(streamId: string, endpoint: RelayEndpoint): void {
    if (this.#closed || !this.#enabled || [...this.#streams].filter((stream) => !stream.settled).length >= 4) {
      this.#link?.refuse(streamId);
      return;
    }
    const generation = this.#generation;
    const stream = new PhoneStream(streamId, endpoint, {
      ...this.#options,
      events: {
        onBytes: (phone, direction, bytes) => {
          if (this.#watchers.size === 0 || phone.deviceId === null) return;
          const count = this.#totals.get(phone.deviceId) ?? { down: 0, up: 0 };
          count[direction] += bytes;
          this.#totals.set(phone.deviceId, count);
        },
        onFirstFrame: (phone, pattern, message) => this.#handshake(phone, pattern, message, endpoint, generation),
        onControl: (phone, value) => this.#control(phone, value),
        onClosed: (phone, reason) => {
          this.#streams.delete(phone);
          this.#pairPhones.delete(phone);
          this.#stopPairHeartbeat(phone);
          this.#pairing.disconnected(phone);
          if (phone.deviceId !== null) this.#recordSeen(phone.deviceId);
          this.#options.logger.info(
            { stream_id: phone.streamId, device_id: phone.deviceId, reason },
            "remote stream closed",
          );
          if (phone.deviceId !== null) this.#changed();
          else this.#handshakeChanged();
        },
      },
    });
    this.#streams.add(stream);
    this.#draining.add(stream.done);
    void stream.done.then(() => this.#draining.delete(stream.done));
  }

  /**
   * Authenticates the first frame without trusting relay metadata.
   * @remarks A pairing is not claimed until encrypted key confirmation arrives.
   * @sideEffects Sends handshake two and may accept or close the stream.
   * @param stream - Data stream.
   * @param pattern - Requested Noise mode.
   * @param message - First Noise message.
   * @param endpoint - Relay binding for this stream.
   * @param generation - Connection generation that admitted this stream.
   */
  #handshake(
    stream: PhoneStream,
    pattern: Pattern,
    message: Uint8Array,
    endpoint: RelayEndpoint,
    generation: number,
  ): void {
    if (generation !== this.#generation) {
      stream.close("stale_generation");
      return;
    }
    try {
      const current = this.#trusted();
      const pairing = this.#pairing.view();
      const handshake = HandshakeState.responder({
        pattern,
        prologue: prologue(endpoint.hostId),
        staticKey: keyPairFrom(fromBase64Url(current.hostKey, 32)),
        ...(pattern === "IKpsk2"
          ? {
              psk:
                (pairing === null ? null : this.#pairing.pskOf(pairing.pairingId)) ?? new Uint8Array(randomBytes(32)),
            }
          : {}),
      });
      const payload: unknown = JSON.parse(fromUtf8(handshake.readMessage(message)));
      let answer: Record<string, unknown>;
      let deviceId: string | null = null;
      if (pattern === "IKpsk2") {
        const request = PairPayload.parse(payload);
        if (pairing === null || request.pairingId !== pairing.pairingId) {
          stream.close("pairing_not_found");
          return;
        }
        const check = this.#pairing.check();
        answer =
          request.protocolVersion !== PROTOCOL_VERSION
            ? { ok: false, reason: "version_mismatch", hostProtocol: PROTOCOL_VERSION }
            : check !== "ok"
              ? { ok: false, reason: check }
              : { ok: true };
        if (answer.ok === true) this.#pairPhones.set(stream, { ...request, generation });
      } else {
        const request = ConnectPayload.parse(payload);
        const publicKey = toBase64Url(handshake.remoteStatic!);
        const device = current.devices.find((one) => one.publicKey === publicKey && !this.#blocked.has(one.deviceId));
        answer =
          device === undefined
            ? { ok: false, reason: "device_unknown" }
            : request.protocolVersion !== PROTOCOL_VERSION
              ? { ok: false, reason: "version_mismatch", hostProtocol: PROTOCOL_VERSION }
              : { ok: true, deviceId: device.deviceId };
        if (answer.ok === true && device !== undefined) deviceId = device.deviceId;
      }
      stream.sendRaw(handshake.writeMessage(utf8(JSON.stringify(answer))));
      if (answer.ok !== true) {
        stream.close("handshake_rejected");
        return;
      }
      stream.secure(handshake.finish());
      if (deviceId !== null) this.#session(stream, deviceId);
      else this.#handshakeChanged();
    } catch (error) {
      stream.close(reasonOf(error));
    }
  }

  /**
   * Applies authenticated pairing confirmation.
   * @remarks Other controls from a phone are invalid.
   * @sideEffects Claims a pairing or rejects and closes.
   * @param stream - Authenticated data stream.
   * @param value - Decrypted control.
   */
  #control(stream: PhoneStream, value: ControlMessage): void {
    const request = this.#pairPhones.get(stream);
    if (
      value.kind !== "pair_confirm" ||
      request === undefined ||
      request.generation !== this.#generation ||
      stream.remoteStatic === null ||
      stream.handshakeHash === null
    ) {
      stream.close("unexpected_control");
      return;
    }
    this.#pairPhones.delete(stream);
    const result = this.#pairing.claim(request.pairingId, {
      stream,
      deviceName: request.deviceName,
      model: request.model,
      publicKey: toBase64Url(stream.remoteStatic),
      sas: sas(stream.handshakeHash),
    });
    if (result === "ok") {
      stream.settle();
      this.#keepPairingAlive(stream);
    } else {
      stream.sendControl({ kind: "pair_rejected", reason: result });
      stream.close(result);
    }
  }

  /**
   * Probes the claimant while no server connection owns its heartbeat yet.
   * @remarks Approval can take two minutes, but a silent channel must still close after thirty seconds.
   * @sideEffects Schedules a tracked probe; may close the stream and reject its pending pairing.
   * @param stream - The current pairing claimant.
   */
  #keepPairingAlive(stream: PhoneStream): void {
    this.#pairHeartbeat = {
      stream,
      cancel: trackedTimeout(
        this.#options.clock,
        this.#options.resources,
        () => {
          this.#pairHeartbeat = null;
          if (!stream.closed && stream.deviceId === null && stream.transport().checkAlive())
            this.#keepPairingAlive(stream);
        },
        SILENCE_MS / 2,
      ),
    };
  }

  /**
   * Releases the claimant's heartbeat before close or transfer to the server.
   * @remarks Other unclaimed streams cannot cancel this phone's probe.
   * @sideEffects Cancels one tracked timer.
   * @param stream - The stream leaving the pairing phase.
   */
  #stopPairHeartbeat(stream: PhoneStream): void {
    if (this.#pairHeartbeat?.stream !== stream) return;
    this.#pairHeartbeat.cancel();
    this.#pairHeartbeat = null;
  }

  /**
   * Hands an authenticated device to the common server.
   * @remarks Newest channels evict the oldest beyond two.
   * @sideEffects Updates last-seen, accepts transport, may close an older stream.
   * @param stream - Authenticated data stream.
   * @param deviceId - Device found by its Noise key.
   */
  #session(stream: PhoneStream, deviceId: string): void {
    const others = [...this.#streams].filter((one) => one.deviceId === deviceId);
    while (others.length >= 2) others.shift()?.close("replaced");
    stream.deviceId = deviceId;
    this.#stopPairHeartbeat(stream);
    this.#recordSeen(deviceId);
    stream.settle();
    this.#options.accept(stream.transport(), { origin: "remote", deviceId });
    this.#changed();
  }

  /**
   * Remembers a device's latest connection transition.
   * @remarks This nonsecret index is independent of the vault.
   * @sideEffects Saves last-seen and logs write failures without paths.
   * @param deviceId - Device whose online state changed.
   */
  #recordSeen(deviceId: string): void {
    const document = this.#options.index.read();
    this.#options.index
      .save({ ...document, lastSeen: { ...document.lastSeen, [deviceId]: this.#options.clock.now() } })
      .catch(() => this.#options.logger.warn({ device_id: deviceId }, "remote last seen not saved"));
  }

  /** Persists the nonsecret switch. @remarks Merges current last-seen values. @sideEffects Writes the index. */
  #saveIndex(): Promise<void> {
    return this.#options.index.save({ ...this.#options.index.read(), enabled: this.#enabled });
  }

  /** Projects trusted state for a local page. @remarks Blocked devices and secrets are omitted. @sideEffects none */
  #view(): RemoteState {
    const endpoint = this.#relay();
    return {
      enabled: this.#enabled,
      vault: this.#vault,
      relay:
        endpoint === null
          ? null
          : {
              url: endpoint.url,
              hostId: endpoint.hostId,
              diagnostics: this.#link?.diagnostics ?? this.#probeDiagnostics,
              ...(this.#link?.state ?? { status: "off" as const, error: null, lastConnectedAt: null }),
            },
      hostFingerprint:
        this.#contents === null
          ? null
          : createHash("sha256")
              .update(keyPairFrom(fromBase64Url(this.#contents.hostKey, 32)).publicKey)
              .digest("hex")
              .slice(0, 16),
      devices: (this.#contents?.devices ?? [])
        .filter((device) => !this.#blocked.has(device.deviceId))
        .map((device) => ({
          deviceId: device.deviceId,
          name: nameOf(device),
          model: device.model.trim() || null,
          pairedAt: device.pairedAt,
          lastSeenAt: this.#options.index.read().lastSeen[device.deviceId] ?? null,
          online: [...this.#streams].some((stream) => stream.deviceId === device.deviceId),
          traffic: this.#traffic.get(device.deviceId) ?? { down: 0, up: 0 },
        })),
      pairing: this.#pairingView(),
    };
  }

  /** Projects current candidate activity without exposing unconfirmed identities. @remarks Old QR codes and connection generations cannot animate the current pairing. @sideEffects none */
  #pairingView(): RemoteState["pairing"] {
    const pairing = this.#pairing.view();
    if (pairing === null) return null;
    return {
      ...pairing,
      handshaking:
        pairing.state === "available" &&
        [...this.#pairPhones].some(
          ([stream, request]) =>
            !stream.closed && request.pairingId === pairing.pairingId && request.generation === this.#generation,
        ),
    };
  }

  /** Coalesces candidate starts and immediately clears published activity. @remarks Unauthenticated churn must not publish full business-state events or prolong activity after its end. @sideEffects May schedule one tracked notification or send a local update. */
  #handshakeChanged(): void {
    const active = this.#pairingView()?.handshaking === true;
    if (!active) {
      this.#cancelHandshakeNotice?.();
      this.#cancelHandshakeNotice = null;
      if (this.#publishedHandshaking) this.#changed();
      return;
    }
    if (this.#closed || this.#watchers.size === 0 || this.#publishedHandshaking || this.#cancelHandshakeNotice !== null)
      return;
    this.#cancelHandshakeNotice = trackedTimeout(
      this.#options.clock,
      this.#options.resources,
      () => {
        this.#cancelHandshakeNotice = null;
        this.#changed();
      },
      100,
    );
  }

  /** Publishes a complete state to local watchers only. @remarks Traffic-only changes are sampled separately. @sideEffects Sends local events. */
  #changed(): void {
    this.#cancelHandshakeNotice?.();
    this.#cancelHandshakeNotice = null;
    if (this.#closed || this.#watchers.size === 0) return;
    const event: RemoteUpdatedEvent = { type: "remote_updated", remote: this.#view() };
    this.#publishedHandshaking = event.remote.pairing?.handshaking === true;
    for (const id of this.#watchers) this.#options.send(id, event);
  }

  /** Samples ciphertext counters only while watched. @remarks Two seconds of deltas are averaged; unchanged rates do not notify watchers. @sideEffects Schedules one tracked timer and updates sampled rates. @returns Whether rates of a visible device changed. */
  #sampleTraffic(): boolean {
    if (this.#cancelTraffic !== null || this.#watchers.size === 0 || this.#closed) return false;
    const at = this.#options.clock.now();
    const totals = new Map([...this.#totals].map(([id, count]) => [id, { ...count }]));
    const previous = this.#samples[0];
    let changed = false;
    if (previous !== undefined && at > previous.at)
      for (const [id, count] of totals) {
        const before = previous.totals.get(id) ?? { down: 0, up: 0 };
        const seconds = (at - previous.at) / 1000;
        const rate = {
          down: Math.max(0, count.down - before.down) / seconds,
          up: Math.max(0, count.up - before.up) / seconds,
        };
        const current = this.#traffic.get(id);
        if (
          (rate.down !== (current?.down ?? 0) || rate.up !== (current?.up ?? 0)) &&
          !this.#blocked.has(id) &&
          this.#contents?.devices.some((device) => device.deviceId === id)
        )
          changed = true;
        this.#traffic.set(id, rate);
      }
    this.#samples.push({ at, totals });
    this.#samples = this.#samples.filter((sample) => sample.at > at - 2000);
    this.#cancelTraffic = trackedTimeout(
      this.#options.clock,
      this.#options.resources,
      () => {
        this.#cancelTraffic = null;
        if (this.#sampleTraffic()) this.#changed();
      },
      1000,
    );
    return changed;
  }
}
