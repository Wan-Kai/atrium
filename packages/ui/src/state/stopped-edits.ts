import type { AtriumClient } from "@atrium/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { pageDrafts } from "./use-draft";

/** The transcript identity captured at entry, with a private draft and original image positions. */
export interface StoppedEdit {
  readonly epoch: number;
  readonly turnId: string;
  readonly draftKey: string;
  readonly images: readonly string[];
  readonly savedDraft: boolean;
}

/** A session's page-local editor and request status, kept while another tab is shown. */
export interface StoppedEditState {
  readonly target: StoppedEdit | null;
  readonly submitting: boolean;
  readonly error: string | null;
}

/** Each connected client's session editors; leaving the page releases the entire registry. */
const editors = new WeakMap<AtriumClient, Map<string, StoreApi<StoppedEditState>>>();

/**
 * Returns the page-local stopped-message editor of a session.
 * @remarks Switching sessions must retain both the edited text and an in-flight request's result.
 * @sideEffects Lazily keeps one store per client and session.
 * @param client - The connected client whose lifecycle owns the editors.
 * @param sessionId - The session whose editor is read.
 * @returns A stable observable editor state.
 */
export function stoppedEditStore(client: AtriumClient, sessionId: string): StoreApi<StoppedEditState> {
  const sessions = editors.get(client) ?? new Map<string, StoreApi<StoppedEditState>>();
  editors.set(client, sessions);
  const known = sessions.get(sessionId);
  if (known !== undefined) return known;
  const store = createStore<StoppedEditState>(() => ({ target: null, submitting: false, error: null }));
  sessions.set(sessionId, store);
  return store;
}

/**
 * Clears a completed or explicitly cancelled edit without touching the next-message draft.
 * @remarks An old request completing after tab closure must not clear a newer edit's context.
 * @sideEffects Drops the private draft and resets the matching editor store.
 * @param store - The session's editor state.
 * @param target - The immutable target of the completed operation.
 */
export function finishStoppedEdit(store: StoreApi<StoppedEditState>, target: StoppedEdit): void {
  if (store.getState().target !== target) return;
  pageDrafts().drop([target.draftKey]);
  store.setState({ target: null, submitting: false, error: null });
}

/**
 * Drops editors when their sessions are removed or archived, as ordinary drafts are.
 * @remarks Merely switching tabs is not deletion; the existing session-draft cleanup owns this decision.
 * @sideEffects Drops private drafts and clears their editor stores.
 * @param client - The connected client's registry.
 * @param sessionIds - Sessions whose ordinary drafts are being discarded.
 */
export function dropStoppedEdits(client: AtriumClient, sessionIds: readonly string[]): void {
  const sessions = editors.get(client);
  for (const id of sessionIds) {
    const store = sessions?.get(id);
    const target = store?.getState().target;
    // A non-null target already implies a store; the explicit check also narrows its TypeScript type.
    if (store !== undefined && target != null) finishStoppedEdit(store, target);
    sessions?.delete(id);
  }
}
