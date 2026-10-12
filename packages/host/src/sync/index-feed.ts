import type { IndexChangesEvent, IndexSnapshotEvent, Layout, SnapshotReason } from "@atrium/protocol";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";
import type { SubscriptionRegistry } from "./subscriptions";

/** What the list holds for every client: all but the envelope and each client's own layout. */
export type IndexContent = Omit<IndexSnapshotEvent, "type" | "generation" | "seq" | "reason" | "layout">;

/** How long changes are gathered before one batch goes out. */
export const INDEX_PUSH_DELAY_MS = 30;

/** How many removals the feed remembers for clients coming back with a cursor. */
export const INDEX_REMOVALS_KEPT = 1000;

/** The most items a batch of changes after a cursor may hold; more go as a snapshot. */
export const INDEX_CHANGES_LIMIT = 200;

/** A client's position in the list. */
export interface IndexCursor {
  readonly generation: string;
  readonly seq: number;
}

/** Pushes the list to the clients that subscribed to it. */
export interface IndexFeed {
  /** Subscribes a connection and sends it what it lacks at once: changes after its cursor, or a snapshot. */
  subscribe(connectionId: string, cursor?: IndexCursor): void;
  /** Something in the list changed; the changes go to every subscriber shortly. */
  changed(): void;
  /** Sends one connection the batch waiting to go out, at once, if there is one. */
  flush(connectionId: string): void;
  /** Cancels a pending push and ignores later changes. */
  close(): void;
}

/** The collections the list holds, each item named by its id. */
const COLLECTIONS = ["projects", "workspaces", "chats", "sessions"] as const;
type CollectionName = (typeof COLLECTIONS)[number];
type Item<C extends CollectionName> = IndexContent[C][number];

/** One item as the feed last saw it. */
interface Known {
  readonly json: string;
  /** The batch it last changed in. */
  readonly seq: number;
}

/** What the feed last sent a subscriber. */
interface Sent {
  seq: number;
  layout: string;
}

/**
 * An item's id.
 *
 * @remarks
 * Sessions are named by `sessionId`, the rest by `id`.
 *
 * @sideEffects none
 * @param item - The item.
 * @returns Its id.
 */
function idOf(item: Item<CollectionName>): string {
  return "sessionId" in item ? item.sessionId : item.id;
}

/**
 * Creates the list feed.
 *
 * @remarks
 * SPEC-0001 ("并行、同步与关注"): business modules only say something changed; the feed builds
 * the whole list again and compares it with the last one item by item, by id, so they need not
 * report what. Every batch with a change gets the next `seq`, shared by all subscribers. The feed
 * remembers each item's last change and the last `removalsKept` removals, so a client coming back
 * with a cursor gets just what changed after it; a cursor of another host, older than the
 * removals remembered, or behind more than `changesLimit` changes gets a snapshot. A client's
 * layout is its own: a change to it goes only to that client and takes no `seq`, and a cursor's
 * answer always carries the layout and preferences whole. Changes within `INDEX_PUSH_DELAY_MS`
 * merge into one batch; `flush` sends one connection the waiting batch before the host answers its
 * command, so the answer finds the list already changed by it (SPEC-0001, "先读到自己的写"). The
 * content comes from `build` and `layoutOf`, so this module needs no
 * business module (overview.md, "宿主内部的依赖").
 *
 * @sideEffects none until a call; then sends events and schedules a tracked timer.
 * @param options - The registry, the generation, how to build the list and a client's layout, the
 * clock, the resource tracker, and limits smaller than the host's for tests.
 * @returns The feed.
 */
export function createIndexFeed(options: {
  readonly registry: SubscriptionRegistry;
  readonly generation: string;
  readonly build: () => IndexContent;
  readonly layoutOf: (clientId: string) => Layout;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly removalsKept?: number;
  readonly changesLimit?: number;
}): IndexFeed {
  const removalsKept = options.removalsKept ?? INDEX_REMOVALS_KEPT;
  const changesLimit = options.changesLimit ?? INDEX_CHANGES_LIMIT;
  let seq = 0;
  const known: Record<CollectionName, Map<string, Known>> = {
    projects: new Map(),
    workspaces: new Map(),
    chats: new Map(),
    sessions: new Map(),
  };
  // Stryker disable next-line ObjectLiteral,StringLiteral: no JSON of the preferences is empty, so the first build always records them.
  let preferences: Known = { json: "", seq: 0 };
  // Stryker disable next-line ArrayDeclaration: an entry that is no removal matches no collection and, dropped first, moves nothing.
  const removals: { readonly collection: CollectionName; readonly id: string; readonly seq: number }[] = [];
  /** Cursors older than this may have missed a removal no longer remembered. */
  let forgottenUpTo = 0;
  const sent = new Map<string, Sent>();
  let cancel: (() => void) | null = null;
  let closed = false;

  /**
   * Builds the list again and records what changed since the last time.
   *
   * @remarks
   * Any change takes the next `seq`.
   *
   * @sideEffects Updates the feed's record of the list.
   * @returns The list.
   */
  function refresh(): IndexContent {
    const next = options.build();
    const at = seq + 1;
    let changed = false;
    for (const collection of COLLECTIONS) {
      const seen = new Set<string>();
      for (const item of next[collection]) {
        const id = idOf(item);
        seen.add(id);
        const json = JSON.stringify(item);
        if (known[collection].get(id)?.json === json) continue;
        known[collection].set(id, { json, seq: at });
        changed = true;
      }
      for (const id of known[collection].keys()) {
        if (seen.has(id)) continue;
        known[collection].delete(id);
        removals.push({ collection, id, seq: at });
        changed = true;
      }
    }
    const json = JSON.stringify(next.preferences);
    if (json !== preferences.json) {
      preferences = { json, seq: at };
      changed = true;
    }
    // Stryker disable next-line OptionalChaining: the loop only shifts while there is an entry.
    while (removals.length > removalsKept) forgottenUpTo = removals.shift()?.seq ?? forgottenUpTo;
    if (changed) seq = at;
    return next;
  }

  /**
   * The items that changed after a position, and those removed since.
   *
   * @remarks
   * In the list's order, so new items land at the end as they do on the host.
   *
   * @sideEffects none
   * @param list - The list.
   * @param after - The position.
   * @returns The changes, and how many items they hold.
   */
  function changesAfter(list: IndexContent, after: number) {
    let size = 0;
    /**
     * One collection's changes.
     *
     * @remarks
     * See `changesAfter`.
     *
     * @sideEffects Adds to `size`.
     * @param collection - The collection.
     * @returns Its upserts and removals.
     */
    const of = <C extends CollectionName>(collection: C) => {
      const items: readonly Item<C>[] = list[collection];
      // Stryker disable next-line OptionalChaining: the list was just built, so every item in it is known.
      const upsert = items.filter((item) => (known[collection].get(idOf(item))?.seq ?? 0) > after);
      const remove = removals
        .filter((removal) => removal.collection === collection && removal.seq > after)
        .map((removal) => removal.id);
      size += upsert.length + remove.length;
      return { upsert, remove };
    };
    // Stryker disable next-line ObjectLiteral: each collection is checked by the tests' whole events.
    const changes = {
      projects: of("projects"),
      workspaces: of("workspaces"),
      chats: of("chats"),
      sessions: of("sessions"),
    };
    return { changes, size };
  }

  /**
   * Sends one connection the whole list.
   *
   * @remarks
   * See `createIndexFeed`.
   *
   * @sideEffects Sends an event.
   * @param connectionId - The connection.
   * @param list - The list.
   * @param layout - The client's layout.
   * @param reason - Why the whole list.
   */
  function sendSnapshot(connectionId: string, list: IndexContent, layout: Layout, reason: SnapshotReason): void {
    options.registry.sendTo(connectionId, {
      type: "index_snapshot",
      generation: options.generation,
      seq,
      reason,
      ...list,
      layout,
    });
  }

  /**
   * Sends one connection a batch of changes.
   *
   * @remarks
   * See `createIndexFeed`.
   *
   * @sideEffects Sends an event.
   * @param connectionId - The connection.
   * @param changes - The collections' changes.
   * @param layout - The client's layout, or `null` when unchanged.
   * @param withPreferences - Whether the preferences go along.
   * @param list - The list.
   */
  function sendChanges(
    connectionId: string,
    changes: Pick<IndexChangesEvent, CollectionName>,
    layout: Layout | null,
    withPreferences: boolean,
    list: IndexContent,
  ): void {
    options.registry.sendTo(connectionId, {
      type: "index_changes",
      generation: options.generation,
      seq,
      ...changes,
      layout,
      preferences: withPreferences ? list.preferences : null,
    });
  }

  /**
   * Why a cursor cannot be served with changes, if it cannot.
   *
   * @remarks
   * See `createIndexFeed`. A cursor ahead of the feed cannot come from this host's list either.
   *
   * @sideEffects none
   * @param cursor - The client's cursor.
   * @returns The reason, or `null` when changes will do.
   */
  function unservable(cursor: IndexCursor): SnapshotReason | null {
    if (cursor.generation !== options.generation) return "generation_changed";
    return cursor.seq > seq || cursor.seq < forgottenUpTo ? "cursor_expired" : null;
  }

  /**
   * Sends every subscriber what changed since it was last sent anything.
   *
   * @remarks
   * Subscribers that went away are forgotten.
   *
   * @sideEffects Sends events; updates what was sent.
   */
  function push(): void {
    const list = refresh();
    const subscribers = options.registry.indexSubscribers();
    const live = new Set(subscribers.map((subscriber) => subscriber.connectionId));
    // Stryker disable next-line ConditionalExpression,CallExpression: only memory; a connection subscribes anew, and is sent its first answer, before it is sent changes.
    for (const connectionId of sent.keys()) if (!live.has(connectionId)) sent.delete(connectionId);
    for (const subscriber of subscribers) deliver(subscriber, list);
  }

  /**
   * Sends one subscriber what changed since it was last sent anything, if anything did.
   *
   * @remarks
   * Its own layout counts as a change; another client's does not. A subscriber last sent
   * something before removals already forgotten, as when one batch removed more than are kept,
   * gets the whole list (SPEC-0001, "列表的增量").
   *
   * @sideEffects Sends an event; updates what was sent.
   * @param subscriber - The connection and its client.
   * @param list - The list as it is now.
   */
  function deliver(subscriber: { readonly connectionId: string; readonly clientId: string }, list: IndexContent): void {
    const { connectionId, clientId } = subscriber;
    const last = sent.get(connectionId);
    // Stryker disable next-line ConditionalExpression: a subscriber is always sent its first answer before any push.
    if (last === undefined) return;
    const layout = options.layoutOf(clientId);
    const layoutJson = JSON.stringify(layout);
    const layoutChanged = layoutJson !== last.layout;
    if (last.seq === seq && !layoutChanged) return;
    sent.set(connectionId, { seq, layout: layoutJson });
    if (last.seq < forgottenUpTo) {
      sendSnapshot(connectionId, list, layout, "cursor_expired");
      return;
    }
    const { changes } = changesAfter(list, last.seq);
    sendChanges(connectionId, changes, layoutChanged ? layout : null, preferences.seq > last.seq, list);
  }

  return {
    subscribe(connectionId, cursor) {
      const subscriber = options.registry.subscribeIndex(connectionId);
      if (subscriber === undefined) return;
      const list = refresh();
      const layout = options.layoutOf(subscriber.clientId);
      sent.set(connectionId, { seq, layout: JSON.stringify(layout) });
      if (cursor === undefined) {
        sendSnapshot(connectionId, list, layout, "no_cursor");
        return;
      }
      const reason = unservable(cursor);
      if (reason !== null) {
        sendSnapshot(connectionId, list, layout, reason);
        return;
      }
      const { changes, size } = changesAfter(list, cursor.seq);
      if (size > changesLimit) {
        sendSnapshot(connectionId, list, layout, "too_many_changes");
        return;
      }
      sendChanges(connectionId, changes, layout, true, list);
    },
    changed() {
      // Sessions stopping while the host closes still report changes; nobody is left to tell.
      if (closed) return;
      cancel ??= trackedTimeout(
        options.clock,
        options.resources,
        () => {
          cancel = null;
          push();
        },
        INDEX_PUSH_DELAY_MS,
      );
    },
    flush(connectionId) {
      // Nothing changed since the last batch went out.
      if (cancel === null) return;
      const subscriber = options.registry.indexSubscribers().find((one) => one.connectionId === connectionId);
      if (subscriber !== undefined) deliver(subscriber, refresh());
    },
    close() {
      closed = true;
      cancel?.();
      cancel = null;
    },
  };
}
