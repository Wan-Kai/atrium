import { type AtriumClient, CommandError } from "@atrium/client";
import type { RemoteState } from "@atrium/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { remoteError, KEYCHAIN_HELP } from "./remote-words";

/** One failed revoke retained only by the open settings window. */
interface PendingRevocation {
  readonly deviceId: string;
  readonly name: string;
  readonly error: string;
  readonly pending: boolean;
}

/** The settings window's specific revoke-retry state, not a command queue. */
export interface PendingRevocations {
  readonly entries: readonly PendingRevocation[];
  /** Executes only on explicit user action; rejects after retaining a current-scope failure. */
  readonly revoke: (deviceId: string, name: string) => Promise<void>;
  /** Captures a scope-safe callback to call only after an explicit identity reset succeeds. */
  readonly beginIdentityChange: () => () => void;
}

/**
 * Identifies the public host/relay scope without retaining the QR or relay credential.
 * @remarks Token-only saves are deliberately outside this scope: they do not persist failed revocations.
 * Only public fingerprint/URL/hostId changes invalidate targets; the UI never compares credentials.
 * @sideEffects none
 * @param state - The latest authoritative snapshot, or no snapshot.
 * @returns The public identity key.
 */
function identityOf(state: RemoteState | null): string {
  return JSON.stringify([state?.hostFingerprint ?? null, state?.relay?.url ?? null, state?.relay?.hostId ?? null]);
}

/**
 * Retains failed revocations independently of Phone's generic feedback for this settings window.
 * @remarks Targets survive category changes, never window closure. A generation and per-device
 * attempt token prevent old completions from recreating targets after public identity changes or reset.
 * No device is reinserted in the host list and no command is retried automatically.
 * @sideEffects Observes the existing local store, sends explicit revoke commands and updates retry rows;
 * clears references and the subscription on unmount. Opens no connection and stores nothing on disk.
 * @param client - The window's client.
 * @returns Failed targets, explicit revoke and the successful-identity-change invalidator.
 */
export function usePendingRevocations(client: AtriumClient): PendingRevocations {
  const [entries, setEntries] = useState<readonly PendingRevocation[]>([]);
  const held = useRef({
    active: false,
    generation: 0,
    identity: identityOf(client.remote.getState().state),
    failures: new Map<string, PendingRevocation>(),
    attempts: new Map<string, symbol>(),
  });
  /** Publishes current retry rows. @remarks Never publishes from a closed window. @sideEffects Updates local React state. */
  const publish = useCallback((): void => {
    if (held.current.active) setEntries([...held.current.failures.values()]);
  }, []);
  /** Invalidates every old target and completion. @remarks A new identity must never inherit old revocation actions. @sideEffects Clears in-memory targets and updates visible rows. */
  const clear = useCallback((): void => {
    held.current.generation += 1;
    held.current.failures.clear();
    held.current.attempts.clear();
    publish();
  }, [publish]);
  useEffect(() => {
    const state = held.current;
    state.active = true;
    state.identity = identityOf(client.remote.getState().state);
    clear();
    const stop = client.remote.subscribe((view) => {
      const identity = identityOf(view.state);
      if (identity === state.identity) return;
      state.identity = identity;
      clear();
    });
    return () => {
      stop();
      state.active = false;
      clear();
    };
  }, [client, clear]);

  /**
   * Revokes one exact device and retains a failure for explicit retry.
   * @remarks Other device failures and general action feedback remain untouched.
   * @sideEffects Sends revoke_device; updates the matching row if its identity scope is still current.
   * @param deviceId - The exact paired identity, even after the host hides it.
   * @param name - Its last known display name, never used as its identity.
   * @throws When the command fails, is already pending, or its window/identity scope was replaced.
   */
  const revoke = useCallback(
    async (deviceId: string, name: string): Promise<void> => {
      const state = held.current;
      if (!state.active || state.attempts.has(deviceId)) throw new Error("revocation_not_available");
      const generation = state.generation;
      const attempt = Symbol();
      state.attempts.set(deviceId, attempt);
      const previous = state.failures.get(deviceId);
      if (previous !== undefined) {
        state.failures.set(deviceId, { ...previous, pending: true });
        publish();
      }
      try {
        await client.revokeDevice(deviceId);
        if (!state.active || generation !== state.generation || state.attempts.get(deviceId) !== attempt)
          throw new Error("revocation_scope_changed");
        state.failures.delete(deviceId);
        publish();
      } catch (error) {
        if (state.active && generation === state.generation && state.attempts.get(deviceId) === attempt) {
          const text =
            error instanceof CommandError && error.code === "keychain_unavailable"
              ? `没能写入保险箱，重启 Atrium 后它会恢复。${KEYCHAIN_HELP}授权恢复后请重试撤销。`
              : remoteError(error);
          state.failures.set(deviceId, { deviceId, name, error: text, pending: false });
          publish();
        }
        throw error;
      } finally {
        if (state.attempts.get(deviceId) === attempt) state.attempts.delete(deviceId);
      }
    },
    [client, publish],
  );

  /**
   * Captures a successful identity-reset callback for the current generation.
   * @remarks It still runs if Phone unmounts, but cannot clear failures of a newer identity/window.
   * @sideEffects The returned callback clears retry targets only if its captured scope is still current.
   * @returns The callback to invoke after reset success, never after failure or a relay save.
   */
  const beginIdentityChange = useCallback((): (() => void) => {
    const generation = held.current.generation;
    return () => {
      if (held.current.active && generation === held.current.generation) clear();
    };
  }, [clear]);
  return { entries, revoke, beginIdentityChange };
}
