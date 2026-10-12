import type { ContainerId, ContainerTabs, IndexChangesEvent, IndexSnapshotEvent, Preferences } from "@atrium/protocol";

/** The list as the client holds it: the latest snapshot and changes, with this client's own on top. */
export interface IndexView extends Omit<IndexSnapshotEvent, "type" | "reason"> {
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
    chats: [],
    sessions: [],
    layout: { container: null, tabs: {} },
    preferences: {
      setupDone: false,
      appearance: "system",
      displayMode: "summary",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
    },
    resets: [],
  };
}

/**
 * Takes in a snapshot.
 *
 * @remarks
 * A snapshot replaces everything, this client's own changes included: the host has them by then
 * (SPEC-0001, "项目、工作区与会话"). The host sends one only in answer to a subscription, after
 * which a connection's events come in order, so none is stale.
 *
 * @sideEffects none
 * @param view - The view.
 * @param event - The snapshot.
 * @returns The new view.
 */
export function applyIndexSnapshot(view: IndexView, event: IndexSnapshotEvent): IndexView {
  const { type: _type, reason: _reason, ...rest } = event;
  return { ready: true, ...rest };
}

/**
 * Applies one collection's changes.
 *
 * @remarks
 * A changed item stays where it is and a new one goes at the end, as on the host, so the list
 * keeps its order without one.
 *
 * @sideEffects none
 * @param items - The collection.
 * @param changes - Its changes.
 * @param idOf - An item's id.
 * @returns The new collection.
 */
function withChanges<T>(
  items: readonly T[],
  changes: { readonly upsert: readonly T[]; readonly remove: readonly string[] },
  idOf: (item: T) => string,
): T[] {
  const upserts = new Map(changes.upsert.map((item) => [idOf(item), item]));
  const removed = new Set(changes.remove);
  const kept = items
    .filter((item) => !removed.has(idOf(item)))
    .map((item) => {
      const changed = upserts.get(idOf(item));
      upserts.delete(idOf(item));
      return changed ?? item;
    });
  return [...kept, ...upserts.values()];
}

/**
 * Applies a batch of list changes.
 *
 * @remarks
 * SPEC-0001 ("列表的增量"): the layout and preferences come whole when they changed and as `null`
 * otherwise. Changes before the first snapshot, or of another host instance, have nothing to apply
 * to; the snapshot that answers the next subscription sets things right.
 *
 * @sideEffects none
 * @param view - The view.
 * @param event - The changes.
 * @returns The new view, or the same one when the changes do not apply.
 */
export function applyIndexChanges(view: IndexView, event: IndexChangesEvent): IndexView {
  if (!view.ready || view.generation !== event.generation) return view;
  return {
    ...view,
    seq: event.seq,
    projects: withChanges(view.projects, event.projects, (project) => project.id),
    workspaces: withChanges(view.workspaces, event.workspaces, (workspace) => workspace.id),
    chats: withChanges(view.chats, event.chats, (chat) => chat.id),
    sessions: withChanges(view.sessions, event.sessions, (session) => session.sessionId),
    layout: event.layout ?? view.layout,
    preferences: event.preferences ?? view.preferences,
  };
}

/**
 * Where the client is in the list, to subscribe again from.
 *
 * @remarks
 * Before the first snapshot there is nothing to come back to.
 *
 * @sideEffects none
 * @param view - The view.
 * @returns The cursor, or `undefined` before the first snapshot.
 */
export function cursorOf(view: IndexView): { generation: string; seq: number } | undefined {
  return view.ready ? { generation: view.generation, seq: view.seq } : undefined;
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
