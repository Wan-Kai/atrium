import type { Layout } from "@atrium/protocol";
import type { Clock } from "../platform/clock";
import type { IndexFile } from "../store/index-file";
import type { ClientLayout, LayoutsDocument, TabsRecord } from "../store/index-schema";

/** How many clients' layouts are kept; the least recently seen go first. */
export const KEPT_CLIENTS = 10;

/** Every client's layout. */
export interface Layouts {
  /** A client's layout; empty for one never seen. */
  of(clientId: string): Layout;
  /** Opens a session as the active tab of its container, and goes there unless `go` is false. */
  open(clientId: string, containerId: string, sessionId: string, go?: boolean): Promise<void>;
  /** Closes a client's tab of a session; the tab to its right, else its left, becomes active. */
  close(clientId: string, sessionId: string): Promise<void>;
  /** Goes to a container, or nowhere. */
  select(clientId: string, containerId: string | null): Promise<void>;
  /** Closes every client's tabs of these sessions. */
  forgetSessions(sessionIds: readonly string[]): Promise<void>;
  /** Drops every client's tabs of these containers, and leaves them if a client is there. */
  forgetContainers(containerIds: readonly string[]): Promise<void>;
  /** Whether any client has a tab of the session open. */
  isOpen(sessionId: string): boolean;
}

/**
 * Removes a session from a container's tabs.
 *
 * @remarks
 * When it was the active tab, the one to its right takes over, else the one to its left, as in a
 * browser.
 *
 * @sideEffects none
 * @param tabs - The container's tabs.
 * @param sessionId - The session.
 * @returns The tabs without it.
 */
function withoutTab(tabs: TabsRecord, sessionId: string): TabsRecord {
  const index = tabs.open.indexOf(sessionId);
  if (index === -1) return tabs;
  const open = tabs.open.filter((id) => id !== sessionId);
  const active = tabs.active === sessionId ? (open[index] ?? open[index - 1] ?? null) : tabs.active;
  return { ...tabs, open, active };
}

/**
 * Creates the layouts over `layouts.json`.
 *
 * @remarks
 * Layouts are per client, so one client closing a tab does not touch another's (domain-model,
 * "已决定 4"). Only the `KEPT_CLIENTS` clients seen most recently are kept. Each change is written
 * before the call returns.
 *
 * @sideEffects none until a change; then writes `layouts.json`.
 * @param options - The loaded file and the clock.
 * @returns The layouts.
 */
export function createLayouts(options: { readonly file: IndexFile<LayoutsDocument>; readonly clock: Clock }): Layouts {
  /**
   * Changes one client's layout and writes the file.
   *
   * @remarks
   * Stamps the client as seen and drops the clients seen longest ago beyond `KEPT_CLIENTS`.
   *
   * @sideEffects Writes `layouts.json`.
   * @param clientId - The client.
   * @param change - The change.
   */
  async function update(clientId: string, change: (layout: ClientLayout) => ClientLayout): Promise<void> {
    const document = options.file.read();
    const current = document.clients.find((client) => client.clientId === clientId) ?? {
      clientId,
      seenAt: 0,
      container: null,
      tabs: {},
    };
    const changed = { ...change(current), seenAt: options.clock.now() };
    const clients = [changed, ...document.clients.filter((client) => client.clientId !== clientId)]
      .toSorted((a, b) => b.seenAt - a.seenAt)
      .slice(0, KEPT_CLIENTS);
    await options.file.save({ ...document, clients });
  }

  /**
   * Changes every client's layout and writes the file if any changed.
   *
   * @remarks
   * For sessions or containers that went away.
   *
   * @sideEffects Writes `layouts.json`.
   * @param change - The change.
   */
  async function updateAll(change: (layout: ClientLayout) => ClientLayout): Promise<void> {
    const document = options.file.read();
    const clients = document.clients.map(change);
    if (JSON.stringify(clients) === JSON.stringify(document.clients)) return;
    await options.file.save({ ...document, clients });
  }

  return {
    of(clientId) {
      const found = options.file.read().clients.find((client) => client.clientId === clientId);
      if (found === undefined) return { container: null, tabs: {} };
      const tabs = Object.fromEntries(
        Object.entries(found.tabs).map(([id, { open, active }]) => [id, { open: [...open], active }]),
      );
      return { container: found.container, tabs };
    },
    open: (clientId, containerId, sessionId, go = true) =>
      update(clientId, (layout) => {
        const tabs = layout.tabs[containerId] ?? { open: [], active: null };
        const open = tabs.open.includes(sessionId) ? tabs.open : [...tabs.open, sessionId];
        return {
          ...layout,
          container: go ? containerId : layout.container,
          tabs: { ...layout.tabs, [containerId]: { ...tabs, open, active: sessionId } },
        };
      }),
    close: (clientId, sessionId) =>
      update(clientId, (layout) => ({
        ...layout,
        tabs: Object.fromEntries(Object.entries(layout.tabs).map(([id, tabs]) => [id, withoutTab(tabs, sessionId)])),
      })),
    select: (clientId, containerId) => update(clientId, (layout) => ({ ...layout, container: containerId })),
    forgetSessions: (sessionIds) =>
      updateAll((layout) => ({
        ...layout,
        tabs: Object.fromEntries(
          Object.entries(layout.tabs).map(([id, tabs]) => [id, sessionIds.reduce(withoutTab, tabs)]),
        ),
      })),
    forgetContainers: (containerIds) =>
      updateAll((layout) => ({
        ...layout,
        container: layout.container !== null && containerIds.includes(layout.container) ? null : layout.container,
        tabs: Object.fromEntries(Object.entries(layout.tabs).filter(([id]) => !containerIds.includes(id))),
      })),
    isOpen: (sessionId) =>
      options.file
        .read()
        .clients.some((client) => Object.values(client.tabs).some((tabs) => tabs.open.includes(sessionId))),
  };
}
