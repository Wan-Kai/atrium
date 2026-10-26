import type { PairingEndReason, PairingState, RemotePairing } from "@atrium/protocol";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";

/** A QR code is valid this long (SPEC-0005, "配对流程" step 1). */
export const PAIRING_TTL_MS = 5 * 60_000;
/** The Mac has this long to answer a phone that asked (SPEC-0005, "配对流程" step 6). */
export const CONFIRM_TIMEOUT_MS = 2 * 60_000;

/** The phone that claimed a pairing with a valid key confirmation. */
export interface PairingClaim<Stream> {
  readonly deviceName: string;
  readonly model: string;
  readonly sas: string;
  /** Its static public key, base64url. */
  readonly publicKey: string;
  /** The channel it came on; the only one `paired` may go to. */
  readonly stream: Stream;
}

/** What a phone's handshake message 1 finds of a pairing. */
export type PairingCheck = "ok" | "pairing_expired" | "pairing_busy";

/** One pairing under way, or the last one. */
interface Pairing<Stream> {
  readonly pairingId: string;
  readonly psk: Uint8Array;
  readonly qr: string;
  readonly expiresAt: number;
  state: PairingState;
  reason: PairingEndReason | null;
  claim: PairingClaim<Stream> | null;
  refused: number;
  /** Set once the Mac confirmed and the vault is being written; nothing interrupts it then. */
  confirming: boolean;
  cancelTimer: () => void;
}

/** How a pairing that was waiting on a phone ended, for the phone's `pair_rejected`. */
export interface PairingEnded<Stream> {
  readonly reason: PairingEndReason;
  readonly stream: Stream;
}

/**
 * The one pairing under way and its states (SPEC-0005, "配对流程").
 *
 * @remarks
 * `available → awaiting_confirmation → committed | rejected`, and `available → expired | rejected`.
 * Every change happens inside one synchronous call, never across an `await`, so two phones that
 * race see one winner. Once the Mac confirmed, the vault write decides: cancel, disconnect and the
 * timeout no longer change the pairing (SPEC-0005, "MP3a 定的细节"). Its timers count as resources.
 *
 * @sideEffects Holds the pairing in memory; schedules its timers.
 */
export class PairingMachine<Stream> {
  readonly #clock: Clock;
  readonly #resources: ResourceTracker;
  readonly #onChange: () => void;
  readonly #onEnded: (ended: PairingEnded<Stream>) => void;
  #pairing: Pairing<Stream> | null = null;

  /**
   * Makes a machine with no pairing.
   *
   * @remarks
   * `onEnded` hears of an end that a phone waits on, to tell it `pair_rejected`.
   *
   * @sideEffects none
   * @param options - Clock, resources, and whom to tell of changes and ends.
   */
  constructor(options: {
    readonly clock: Clock;
    readonly resources: ResourceTracker;
    readonly onChange: () => void;
    readonly onEnded: (ended: PairingEnded<Stream>) => void;
  }) {
    this.#clock = options.clock;
    this.#resources = options.resources;
    this.#onChange = options.onChange;
    this.#onEnded = options.onEnded;
  }

  /**
   * The pairing as the "手机" page shows it.
   *
   * @remarks
   * The claim's channel and key stay here.
   *
   * @sideEffects none
   * @returns The pairing, or `null`.
   */
  view(): RemotePairing | null {
    const pairing = this.#pairing;
    if (pairing === null) return null;
    return {
      pairingId: pairing.pairingId,
      qr: pairing.qr,
      expiresAt: pairing.expiresAt,
      state: pairing.state,
      reason: pairing.reason,
      request:
        pairing.claim === null
          ? null
          : { deviceName: pairing.claim.deviceName, model: pairing.claim.model, sas: pairing.claim.sas },
      refused: pairing.refused,
    };
  }

  /**
   * The current pairing's one-time key, for reading a phone's message 1 with.
   *
   * @remarks
   * Message 1 reads the same with any PSK; only message 2 and the key confirmation need the right
   * one (SPEC-0005, "配对流程").
   *
   * @sideEffects none
   * @param pairingId - The pairing the phone named.
   * @returns The PSK, or `null` when it is not the current pairing.
   */
  pskOf(pairingId: string): Uint8Array | null {
    return this.#pairing?.pairingId === pairingId ? this.#pairing.psk : null;
  }

  /**
   * Starts a pairing, ending one no phone has claimed.
   *
   * @remarks
   * Refused while a phone waits for the Mac or the vault is being written.
   *
   * @sideEffects Ends the earlier pairing; schedules the 5-minute expiry; reports the change.
   * @param pairing - Its id, key and QR text.
   * @returns `false` when a phone is being confirmed.
   */
  start(pairing: { readonly pairingId: string; readonly psk: Uint8Array; readonly qr: string }): boolean {
    const current = this.#pairing;
    if (current !== null && (current.state === "awaiting_confirmation" || current.confirming)) return false;
    if (current?.state === "available") this.#end(current, "rejected", "cancelled");
    const next: Pairing<Stream> = {
      ...pairing,
      expiresAt: this.#clock.now() + PAIRING_TTL_MS,
      state: "available",
      reason: null,
      claim: null,
      refused: 0,
      confirming: false,
      cancelTimer: () => {},
    };
    next.cancelTimer = trackedTimeout(
      this.#clock,
      this.#resources,
      () => {
        if (next.state === "available") this.#end(next, "expired", null);
      },
      PAIRING_TTL_MS,
    );
    this.#pairing = next;
    this.#onChange();
    return true;
  }

  /**
   * Cancels the pairing under way, or clears the last one's result.
   *
   * @remarks
   * A pairing the Mac confirmed finishes with its vault write.
   *
   * @sideEffects Ends or forgets the pairing; reports the change.
   */
  cancel(): void {
    const pairing = this.#pairing;
    if (pairing === null || pairing.confirming) return;
    if (pairing.state === "available" || pairing.state === "awaiting_confirmation") {
      this.#end(pairing, "rejected", "cancelled");
    }
    this.#pairing = null;
    this.#onChange();
  }

  /**
   * What a phone's message 1 finds: whether the host answers `ok`.
   *
   * @remarks
   * Does not change the pairing (SPEC-0005, "配对流程" step 2); the caller has made sure the id is
   * the current one.
   *
   * @sideEffects none
   * @returns `ok`, or why not.
   */
  check(): PairingCheck {
    const pairing = this.#pairing;
    if (
      pairing === null ||
      pairing.state === "expired" ||
      (pairing.state === "available" && this.#clock.now() >= pairing.expiresAt)
    ) {
      return "pairing_expired";
    }
    return pairing.state === "available" ? "ok" : "pairing_busy";
  }

  /**
   * A phone's key confirmation: atomically `available → awaiting_confirmation` for it.
   *
   * @remarks
   * SPEC-0005, "配对流程" step 3. A phone that comes when another is being confirmed counts in
   * `refused`; one that comes too late does not.
   *
   * @sideEffects Moves the pairing; schedules the 2-minute limit; reports the change.
   * @param pairingId - The pairing it named.
   * @param claim - The phone.
   * @returns `ok`, or why it was turned away.
   */
  claim(pairingId: string, claim: PairingClaim<Stream>): PairingCheck {
    const pairing = this.#pairing;
    if (pairing?.pairingId !== pairingId) return "pairing_expired";
    const found = this.check();
    if (found === "pairing_busy") {
      pairing.refused += 1;
      this.#onChange();
    }
    if (found !== "ok") return found;
    pairing.cancelTimer();
    pairing.claim = claim;
    pairing.state = "awaiting_confirmation";
    pairing.cancelTimer = trackedTimeout(
      this.#clock,
      this.#resources,
      () => {
        if (pairing.state === "awaiting_confirmation" && !pairing.confirming) {
          this.#end(pairing, "rejected", "timeout");
        }
      },
      CONFIRM_TIMEOUT_MS,
    );
    this.#onChange();
    return "ok";
  }

  /**
   * The Mac's answer: declines at once, or takes the claim for its vault write.
   *
   * @remarks
   * SPEC-0005, "配对流程" step 5; the caller writes the vault and then calls `committed` or `failed`.
   *
   * @sideEffects Ends the pairing, or marks it confirming; stops its timer; reports the change.
   * @param pairingId - The pairing.
   * @param accept - The answer.
   * @returns The claim to commit, `"declined"`, or `null` when no such pairing waits for an answer.
   */
  answer(pairingId: string, accept: boolean): PairingClaim<Stream> | "declined" | null {
    const pairing = this.#pairing;
    if (pairing?.pairingId !== pairingId || pairing.state !== "awaiting_confirmation" || pairing.confirming) {
      return null;
    }
    const claim = pairing.claim;
    // Stryker disable next-line ConditionalExpression: awaiting confirmation always has a claim; this narrows it.
    if (claim === null) return null;
    if (!accept) {
      this.#end(pairing, "rejected", "declined");
      return "declined";
    }
    pairing.confirming = true;
    pairing.cancelTimer();
    return claim;
  }

  /**
   * The vault holds the new device: the pairing is committed.
   *
   * @remarks
   * Called after the write, in one synchronous step.
   *
   * @sideEffects Moves the pairing; reports the change.
   */
  committed(): void {
    const pairing = this.#pairing;
    if (pairing?.confirming !== true) return;
    pairing.confirming = false;
    pairing.state = "committed";
    this.#onChange();
  }

  /**
   * The vault write failed: the pairing is rejected.
   *
   * @remarks
   * The phone hears `host_error` from the caller.
   *
   * @sideEffects Moves the pairing; reports the change.
   */
  failed(): void {
    const pairing = this.#pairing;
    if (pairing?.confirming !== true) return;
    pairing.confirming = false;
    pairing.state = "rejected";
    pairing.reason = "vault_failed";
    this.#onChange();
  }

  /**
   * A channel closed: a pairing waiting on it is rejected.
   *
   * @remarks
   * Not once the Mac confirmed (see the class).
   *
   * @sideEffects May end the pairing.
   * @param stream - The channel.
   */
  disconnected(stream: Stream): void {
    const pairing = this.#pairing;
    if (pairing?.state === "awaiting_confirmation" && !pairing.confirming && pairing.claim?.stream === stream) {
      this.#end(pairing, "rejected", "disconnected");
    }
  }

  /**
   * Drops the pairing and its timer, when remote access goes off or the host closes.
   *
   * @remarks
   * A phone waiting is told it was cancelled.
   *
   * @sideEffects Ends the pairing; stops its timer.
   */
  dispose(): void {
    const pairing = this.#pairing;
    if (pairing === null) return;
    pairing.cancelTimer();
    pairing.confirming = false;
    if (pairing.state === "available" || pairing.state === "awaiting_confirmation") {
      this.#end(pairing, "rejected", "cancelled");
    }
    this.#pairing = null;
  }

  /**
   * Ends a pairing and tells a phone that waits on it.
   *
   * @remarks
   * One place for every way a pairing ends without a device.
   *
   * @sideEffects Moves the pairing; stops its timer; reports the change and the end.
   * @param pairing - The pairing.
   * @param state - `rejected` or `expired`.
   * @param reason - Why, for a rejected one.
   */
  #end(pairing: Pairing<Stream>, state: "rejected" | "expired", reason: PairingEndReason | null): void {
    pairing.cancelTimer();
    pairing.state = state;
    pairing.reason = reason;
    this.#onChange();
    if (reason !== null && pairing.claim !== null) this.#onEnded({ reason, stream: pairing.claim.stream });
  }
}
