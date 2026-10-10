import type { ChangesUpdatedEvent, DiffFile, DiffTarget, DiffUpdatedEvent } from "@atrium/protocol";

/** A workspace's git changes as the host last sent them; `null` before it has (SPEC-0001, "工作区改动"). */
export type ChangesView = Omit<ChangesUpdatedEvent, "type" | "workspaceId"> | null;

/** What the changes panel shows. */
export interface DiffView {
  /** What it looks at; `null` while closed. */
  readonly target: DiffTarget | null;
  /** `loading` until the host sends the target's files. */
  readonly status: "idle" | "loading" | "ready";
  readonly files: readonly DiffFile[];
  readonly tooLarge: boolean;
  readonly error: DiffUpdatedEvent["error"];
}

/**
 * The panel closed, or about to show `target`.
 *
 * @remarks
 * Opening shows nothing until the host sends the target's files, so another target's never show.
 *
 * @sideEffects none
 * @param target - What the panel looks at, or `null`.
 * @returns The view.
 */
export function diffViewOf(target: DiffTarget | null): DiffView {
  return { target, status: target === null ? "idle" : "loading", files: [], tooLarge: false, error: null };
}
