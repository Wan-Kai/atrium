import type { RemoteState } from "@atrium/protocol";

/** The remote state the desktop's "手机" page shows, while it watches it (SPEC-0005, "宿主 · 给本机界面的命令和事件"). */
export interface RemoteView {
  /** `idle` while not watched; `loading` while asking, with the last state still shown. */
  readonly status: "idle" | "loading" | "ready" | "failed";
  /** The host's last answer or push; `null` before the first. */
  readonly state: RemoteState | null;
  /** Why the last ask failed. */
  readonly error: Error | null;
}

/** The remote state while no page watches it. */
export const UNWATCHED_REMOTE: RemoteView = { status: "idle", state: null, error: null };
