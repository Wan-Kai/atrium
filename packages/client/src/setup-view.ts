import type { SetupState } from "@atrium/protocol";

/** What first launch checks, as far as the client has asked (SPEC-0001, "首次启动"). */
export interface SetupView {
  /** `idle` before the first ask; `loading` while asking, with the last answer still shown. */
  readonly status: "idle" | "loading" | "ready" | "failed";
  /** The host's last answer, with the latest pi it reported since. */
  readonly state: SetupState | null;
  /** Why the last ask failed. */
  readonly error: Error | null;
}

/** The setup before the client has asked for it. */
export const UNASKED_SETUP: SetupView = { status: "idle", state: null, error: null };
