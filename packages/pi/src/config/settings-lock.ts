import lockfile from "proper-lockfile";

/** Holds pi's cooperative settings-file lock until explicitly released. */
export interface PiSettingsLock {
  /** Rejects a write if another process compromised the lock. */
  check(): void;
  /** Removes the lock and stops its heartbeat. */
  release(): Promise<void>;
}

/** Acquires the same settings.json lock used by pi's FileSettingsStorage.
 * @remarks realpath:false also supports missing settings files; no retries keeps a busy editor responsive.
 * Compromise is reported at the write boundary rather than thrown from a background timer.
 * @sideEffects Creates a .lock directory and heartbeat timer until release.
 * @param path - Canonical settings file path whose parent already exists.
 */
export async function acquirePiSettingsLock(path: string): Promise<PiSettingsLock> {
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: 0,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  return {
    check: () => {
      if (compromised !== undefined) throw compromised;
    },
    release: async () => {
      if (compromised === undefined) await release();
    },
  };
}
