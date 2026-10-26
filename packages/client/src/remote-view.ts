import type { RemoteState } from "@atrium/protocol";

/** Remote state watched by the settings window, for its Phone page and category indicators. */
export interface RemoteView {
  /** `idle` while not watched; `loading` while asking, with the last state still shown. */
  readonly status: "idle" | "loading" | "ready" | "failed";
  /** The host's last answer or push; `null` before the first. */
  readonly state: RemoteState | null;
  /** Why the last ask failed. */
  readonly error: Error | null;
}

/** The remote state while no settings window watches it. */
export const UNWATCHED_REMOTE: RemoteView = { status: "idle", state: null, error: null };
