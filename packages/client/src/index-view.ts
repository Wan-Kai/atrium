import type { ContainerId, ContainerTabs, IndexSnapshotEvent, Preferences } from "@atrium/protocol";

/** The list as the client holds it: the latest snapshot, with this client's own changes on top. */
export interface IndexView extends Omit<IndexSnapshotEvent, "type"> {
  /** A snapshot has arrived. */
  readonly ready: boolean;
}

/**
 * The list before the first snapshot.
 *
 * @remarks
 * Empty, with the default preferences, so the UI renders before the host answers.
 *
 * @sideEffects none
 * @returns The empty view.
 */
export function emptyIndex(): IndexView {
  return {
    ready: false,
    generation: "",
    seq: 0,
    projects: [],
    workspaces: [],
    sessions: [],
    layout: { container: null, tabs: {} },
    preferences: { appearance: "system", displayMode: "summary", lastModel: null, thinkingByModel: {}, statusBar: {} },
    resets: [],
  };
}

/**
 * Takes in a snapshot unless an older one of the same host instance.
 *
 * @remarks
 * A snapshot replaces everything, this client's own changes included: the host has them by then
 * (SPEC-0001, "项目、工作区与会话").
 *
 * @sideEffects none
 * @param view - The view.
 * @param event - The snapshot.
 * @returns The new view, or the same one for a stale snapshot.
 */
export function applyIndexSnapshot(view: IndexView, event: IndexSnapshotEvent): IndexView {
  if (view.ready && view.generation === event.generation && event.seq <= view.seq) return view;
  const { type: _type, ...rest } = event;
  return { ready: true, ...rest };
}

/**
 * Opens a session as the active tab of its container and goes there, as the host will.
 *
 * @remarks
 * Shown at once, before the host's snapshot confirms it, so switching tabs never waits. A session
 * the list does not know is left to the host.
 *
 * @sideEffects none
 * @param view - The view.
 * @param sessionId - The session.
 * @returns The new view.
 */
export function withTabOpen(view: IndexView, sessionId: string): IndexView {
  const containerId = view.sessions.find((session) => session.sessionId === sessionId)?.containerId;
  if (containerId === undefined) return view;
  const tabs = view.layout.tabs[containerId] ?? { open: [], active: null };
  const open = tabs.open.includes(sessionId) ? tabs.open : [...tabs.open, sessionId];
  return {
    ...view,
    layout: { container: containerId, tabs: { ...view.layout.tabs, [containerId]: { open, active: sessionId } } },
  };
}

/**
 * Closes this client's tab of a session, as the host will.
 *
 * @remarks
 * The tab to its right becomes active, else the one to its left (same rule as the host's
 * layouts).
 *
 * @sideEffects none
 * @param view - The view.
 * @param sessionId - The session.
 * @returns The new view.
 */
export function withTabClosed(view: IndexView, sessionId: string): IndexView {
  const tabs: Record<string, ContainerTabs> = {};
  for (const [id, { open, active }] of Object.entries(view.layout.tabs)) {
    const index = open.indexOf(sessionId);
    const rest = open.filter((candidate) => candidate !== sessionId);
    tabs[id] = { open: rest, active: active === sessionId ? (rest[index] ?? rest[index - 1] ?? null) : active };
  }
  return { ...view, layout: { ...view.layout, tabs } };
}

/**
 * Goes to a container, or nowhere, as the host will.
 *
 * @remarks
 * See `withTabOpen`.
 *
 * @sideEffects none
 * @param view - The view.
 * @param containerId - The container.
 * @returns The new view.
 */
export function withContainer(view: IndexView, containerId: ContainerId | null): IndexView {
  return { ...view, layout: { ...view.layout, container: containerId } };
}

/**
 * Changes preferences, as the host will.
 *
 * @remarks
 * Ctrl+O must switch the display mode at once.
 *
 * @sideEffects none
 * @param view - The view.
 * @param changes - The preferences to change.
 * @returns The new view.
 */
export function withPreferences(view: IndexView, changes: Partial<Preferences>): IndexView {
  return { ...view, preferences: { ...view.preferences, ...changes } };
}
