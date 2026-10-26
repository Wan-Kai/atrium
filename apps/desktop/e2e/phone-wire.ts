import type { Page } from "@playwright/test";

/** Only non-secret command metadata may outlive a CDP callback. */
export interface PhoneCommandMark {
  readonly type: string;
  readonly requestId: string;
  readonly watch: boolean | undefined;
  ok: boolean | undefined;
}

/** Pairing identity and original deadline, never the QR, PSK or SAS. */
export interface PhonePairMark {
  readonly pairingId: string;
  readonly expiresAt: number;
  readonly available: boolean;
}

/** Scoped metadata recorder, not a second host subscription. */
export interface PhoneWire {
  readonly commands: PhoneCommandMark[];
  readonly pairing: PhonePairMark | null;
  readonly connected: boolean;
  close(): Promise<void>;
}

/** Reads a field without trusting a wire object's type. @remarks Avoids retaining arbitrary payloads. @sideEffects none */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** Parses transient JSON without logging it. @remarks CDP can observe non-JSON traffic too. @sideEffects none */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Observes the UI's actual host socket while retaining only an explicit metadata whitelist.
 * @remarks Enable before the setup reload, so socket creation and all commands are observable.
 * Does not subscribe, intercept, keep raw frames or expose a new renderer bridge.
 * @sideEffects Attaches CDP frame listeners until close; updates non-secret command/pairing metadata.
 * @param page - The isolated renderer.
 * @returns Recorder and listener cleanup.
 */
export async function observePhoneWire(page: Page): Promise<PhoneWire> {
  const cdp = await page.context().newCDPSession(page);
  const commands: PhoneCommandMark[] = [];
  const pending = new Map<string, PhoneCommandMark>();
  const allowed = new Set([
    "get_remote",
    "set_remote",
    "start_pairing",
    "cancel_pairing",
    "confirm_pairing",
    "revoke_device",
    "reset_remote_identity",
  ]);
  let socketId: string | undefined;
  let pairing: PhonePairMark | null = null;
  let connected = false;
  /** Projects only public lifecycle fields. @remarks Never retains the remote payload. @sideEffects Updates metadata. */
  const state = (remote: unknown): void => {
    connected = field(field(remote, "relay"), "status") === "connected";
    const pair = field(remote, "pairing");
    const pairingId = field(pair, "pairingId");
    const expiresAt = field(pair, "expiresAt");
    pairing =
      typeof pairingId === "string" && typeof expiresAt === "number"
        ? { pairingId, expiresAt, available: field(pair, "state") === "available" }
        : null;
  };
  /** Tracks management commands only. @remarks Relay credentials are discarded immediately. @sideEffects Adds metadata. */
  const sent = (event: { requestId: string; response: { payloadData: string } }): void => {
    const value = parse(event.response.payloadData);
    const type = field(value, "type");
    const requestId = field(value, "requestId");
    if (typeof type !== "string" || !allowed.has(type) || typeof requestId !== "string") return;
    if (socketId === undefined && type === "get_remote" && field(value, "watch") === true) socketId = event.requestId;
    if (event.requestId !== socketId) return;
    const watch = field(value, "watch");
    const mark: PhoneCommandMark = {
      type,
      requestId,
      watch: typeof watch === "boolean" ? watch : undefined,
      ok: undefined,
    };
    commands.push(mark);
    pending.set(requestId, mark);
  };
  /** Correlates real host responses. @remarks Ignores unrelated sockets and arbitrary payloads. @sideEffects Updates metadata. */
  const received = (event: { requestId: string; response: { payloadData: string } }): void => {
    if (event.requestId !== socketId) return;
    const value = parse(event.response.payloadData);
    if (field(value, "type") === "remote_updated") state(field(value, "remote"));
    const id = field(value, "requestId");
    const mark = typeof id === "string" ? pending.get(id) : undefined;
    if (field(value, "type") !== "response" || mark === undefined) return;
    mark.ok = field(value, "ok") === true;
    pending.delete(mark.requestId);
    if (mark.type === "get_remote" && mark.ok) state(field(value, "result"));
  };
  cdp.on("Network.webSocketFrameSent", sent);
  cdp.on("Network.webSocketFrameReceived", received);
  try {
    await cdp.send("Network.enable");
  } catch (error) {
    cdp.off("Network.webSocketFrameSent", sent);
    cdp.off("Network.webSocketFrameReceived", received);
    try {
      await cdp.detach();
    } catch (detachError) {
      throw new AggregateError([error, detachError], "phone wire activation and detach failed", { cause: detachError });
    }
    throw error;
  }
  return {
    commands,
    /** Returns only pairing metadata. @remarks QR material is never retained. @sideEffects none */
    get pairing() {
      return pairing;
    },
    /** Returns observed relay readiness. @remarks Taken from the actual host projection. @sideEffects none */
    get connected() {
      return connected;
    },
    /** Releases this recorder. @remarks Does not change host subscriptions. @sideEffects Removes listeners and detaches CDP. */
    async close() {
      cdp.off("Network.webSocketFrameSent", sent);
      cdp.off("Network.webSocketFrameReceived", received);
      await cdp.detach();
    },
  };
}
