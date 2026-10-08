import type { IndexSnapshotEvent } from "@atrium/protocol";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";
import type { SubscriptionRegistry } from "./subscriptions";

/** What a list snapshot holds, apart from its envelope. */
export type IndexContent = Omit<IndexSnapshotEvent, "type" | "generation" | "seq">;

/** How long changes are gathered before one snapshot goes out. */
export const INDEX_PUSH_DELAY_MS = 30;

/** Pushes the list to the clients that subscribed to it. */
export interface IndexFeed {
  /** Subscribes a connection and sends it a snapshot at once. */
  subscribe(connectionId: string): void;
  /** Something in the list changed; a snapshot goes to every subscriber shortly. */
  changed(): void;
  /** Cancels a pending push and ignores later changes. */
  close(): void;
}

/**
 * Creates the list feed.
 *
 * @remarks
 * M1.5 sends only whole snapshots (domain-model, "已决定 11"): a subscriber gets one at once, and
 * after changes all subscribers get one, changes within `INDEX_PUSH_DELAY_MS` merged into one.
 * Each snapshot carries the layout of the subscriber's own client, so it is built per
 * subscriber. `generation` is the host instance; `seq` counts snapshots in it. The content comes
 * from `build`, so this module needs no business module (overview.md, "宿主内部的依赖").
 *
 * @sideEffects none until a call; then sends events and schedules a tracked timer.
 * @param options - The registry, the generation, how to build a client's content, the clock and
 * the resource tracker.
 * @returns The feed.
 */
export function createIndexFeed(options: {
  readonly registry: SubscriptionRegistry;
  readonly generation: string;
  readonly build: (clientId: string) => IndexContent;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
}): IndexFeed {
  let seq = 0;
  let cancel: (() => void) | null = null;
  let closed = false;

  /**
   * Sends one connection a snapshot.
   *
   * @remarks
   * Numbered in the order snapshots go out.
   *
   * @sideEffects Sends an event.
   * @param connectionId - The connection.
   * @param clientId - Its client.
   */
  function send(connectionId: string, clientId: string): void {
    seq += 1;
    options.registry.sendTo(connectionId, {
      type: "index_snapshot",
      generation: options.generation,
      seq,
      ...options.build(clientId),
    });
  }

  return {
    subscribe(connectionId) {
      const subscriber = options.registry.subscribeIndex(connectionId);
      if (subscriber !== undefined) send(subscriber.connectionId, subscriber.clientId);
    },
    changed() {
      // Sessions stopping while the host closes still report changes; nobody is left to tell.
      if (closed) return;
      cancel ??= trackedTimeout(
        options.clock,
        options.resources,
        () => {
          cancel = null;
          for (const { connectionId, clientId } of options.registry.indexSubscribers()) send(connectionId, clientId);
        },
        INDEX_PUSH_DELAY_MS,
      );
    },
    close() {
      closed = true;
      cancel?.();
      cancel = null;
    },
  };
}
