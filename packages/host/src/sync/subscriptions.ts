import type {
  ChangesUpdatedEvent,
  CredentialsChangedEvent,
  DiffUpdatedEvent,
  IndexChangesEvent,
  IndexSnapshotEvent,
  InstallOutputEvent,
  InstallUpdatedEvent,
  LoginUpdatedEvent,
  PiLatestEvent,
  PlansUpdatedEvent,
  RemoteUpdatedEvent,
  SessionEvent,
  SessionSnapshotEvent,
  TaskUpdatedEvent,
  TasksUpdatedEvent,
  ResumePoint,
  SnapshotBudget,
} from "@atrium/protocol";
import type { ResourceTracker } from "../platform/resources";
import type { EventRing } from "./event-ring";
import { withinBudget } from "./snapshot-budget";

/** Delivers events to one connection. */
export type EventSink = (event: SinkEvent) => void;

/** What the host sends a connection besides responses. */
type SinkEvent =
  | SessionEvent
  | IndexSnapshotEvent
  | IndexChangesEvent
  | ChangesUpdatedEvent
  | DiffUpdatedEvent
  | RemoteUpdatedEvent
  | TasksUpdatedEvent
  | TaskUpdatedEvent
  | BroadcastEvent;

/** What goes to every connection, whatever it watches. */
type BroadcastEvent =
  | LoginUpdatedEvent
  | InstallUpdatedEvent
  | InstallOutputEvent
  | PiLatestEvent
  | CredentialsChangedEvent
  | PlansUpdatedEvent;

/** A connection that subscribed to the list, and the client behind it. */
export interface IndexSubscriber {
  readonly connectionId: string;
  readonly clientId: string;
}

/**
 * Who is watching which session, and the way to reach each watcher.
 *
 * @remarks
 * Keyed by an opaque connection id, so business modules can publish to a session's viewers
 * without depending on `server/` (domain-model §6; overview.md, "宿主内部的依赖"). The host pushes
 * live session events only to subscribers (domain-model §7). Each registered connection counts as
 * a `sync.connection` resource, and each session it watches as a `sync.subscription`, so one never
 * let go of shows up in the leak tests.
 *
 * @sideEffects none
 */
export class SubscriptionRegistry {
  readonly #resources: ResourceTracker;
  readonly #ring: EventRing | undefined;
  readonly #sinks = new Map<
    string,
    { readonly sink: EventSink; readonly clientId: string; readonly remote: boolean; readonly release: () => void }
  >();
  /** Each connection's sessions, each with the release of its count. */
  readonly #subscriptions = new Map<string, Map<string, () => void>>();
  readonly #indexSubscribers = new Set<string>();
  /** Each connection's snapshot budget, as its latest subscription set it; `undefined` for the default. */
  readonly #budgets = new Map<string, SnapshotBudget | undefined>();

  /**
   * Creates an empty registry.
   *
   * @remarks
   * Keeps the tracker registered connections are counted in, and the ring that keeps what phones
   * watch for them to continue from (SPEC-0005, "MP4c 定的细节").
   *
   * @sideEffects none
   * @param resources - Where connections are counted.
   * @param ring - The phones' event ring; without it nothing is kept.
   */
  constructor(resources: ResourceTracker, ring?: EventRing) {
    this.#resources = resources;
    this.#ring = ring;
  }

  /**
   * Registers a connection and how to deliver events to it.
   *
   * @remarks
   * Called by the server once the client is authenticated; it starts with no subscriptions.
   *
   * @sideEffects Stores the sink; counts the connection as a resource.
   * @param connectionId - The connection's opaque id.
   * @param sink - Sends one event over the connection.
   * @param clientId - The client behind it, whose layout its list carries.
   * @param remote - Whether it is a phone's, whose sessions' events the ring keeps.
   */
  connect(connectionId: string, sink: EventSink, clientId: string, remote = false): void {
    this.#sinks.set(connectionId, {
      sink,
      clientId,
      remote,
      release: this.#resources.acquire("sync.connection"),
    });
    this.#subscriptions.set(connectionId, new Map());
  }

  /**
   * Forgets a connection and everything it subscribed to.
   *
   * @remarks
   * Called when the socket closes; a reconnecting client subscribes again on its new connection.
   *
   * @sideEffects Removes the sink and the subscriptions; releases the connection's resource count.
   * @param connectionId - The connection's id.
   */
  disconnect(connectionId: string): void {
    if (this.#sinks.get(connectionId)?.remote === true) {
      for (const sessionId of this.#subscriptions.get(connectionId)?.keys() ?? []) this.#ring?.watch(sessionId, -1);
    }
    this.#sinks.get(connectionId)?.release();
    this.#sinks.delete(connectionId);
    for (const release of this.#subscriptions.get(connectionId)?.values() ?? []) release();
    this.#subscriptions.delete(connectionId);
    this.#indexSubscribers.delete(connectionId);
    this.#budgets.delete(connectionId);
  }

  /**
   * Subscribes a connection to the list.
   *
   * @remarks
   * Until it disconnects (SPEC-0001, "项目、工作区与会话").
   *
   * @sideEffects Records the subscription.
   * @param connectionId - The connection.
   * @returns The subscriber, or `undefined` for an unknown connection.
   */
  subscribeIndex(connectionId: string): IndexSubscriber | undefined {
    const found = this.#sinks.get(connectionId);
    if (found === undefined) return undefined;
    this.#indexSubscribers.add(connectionId);
    return { connectionId, clientId: found.clientId };
  }

  /**
   * Lists the connections subscribed to the list.
   *
   * @remarks
   * In subscription order.
   *
   * @sideEffects none
   * @returns The subscribers.
   */
  indexSubscribers(): IndexSubscriber[] {
    return [...this.#indexSubscribers].flatMap((connectionId) => {
      const found = this.#sinks.get(connectionId);
      return found === undefined ? [] : [{ connectionId, clientId: found.clientId }];
    });
  }

  /**
   * Replaces the set of sessions a connection watches.
   *
   * @remarks
   * The caller sends a snapshot of each newly added session before any later event, so the
   * client always starts from a snapshot (domain-model §7).
   *
   * Each subscription also sets the budget of the snapshots the connection gets from then on, or
   * goes back to the default without one (SPEC-0005, "MP4a 定的细节").
   *
   * @sideEffects Updates the connection's subscriptions, their resource counts and its budget.
   * @param connectionId - The connection's id.
   * @param sessionIds - Every session it now watches.
   * @param budget - How much its snapshots may carry; `undefined` for the default.
   * @returns The sessions it did not watch before, in the given order; empty for an unknown connection.
   */
  subscribe(connectionId: string, sessionIds: readonly string[], budget?: SnapshotBudget): string[] {
    const watched = this.#subscriptions.get(connectionId);
    if (watched === undefined) return [];
    this.#budgets.set(connectionId, budget);
    const after = new Set(sessionIds);
    const remote = this.#sinks.get(connectionId)?.remote === true;
    for (const [sessionId, release] of watched) {
      if (after.has(sessionId)) continue;
      release();
      watched.delete(sessionId);
      if (remote) this.#ring?.watch(sessionId, -1);
    }
    const added = [...after].filter((sessionId) => !watched.has(sessionId));
    for (const sessionId of added) {
      watched.set(sessionId, this.#resources.acquire("sync.subscription"));
      if (remote) this.#ring?.watch(sessionId, 1);
    }
    return added;
  }

  /**
   * Lists the connections watching a session.
   *
   * @remarks
   * In connection order, so delivery order is stable.
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @returns The ids of the connections that subscribed to it.
   */
  viewers(sessionId: string): string[] {
    return [...this.#subscriptions]
      .filter(([, sessions]) => sessions.has(sessionId))
      .map(([connectionId]) => connectionId);
  }

  /**
   * Delivers an event to every connection watching its session.
   *
   * @remarks
   * The event's `sessionId` decides who gets it.
   *
   * @sideEffects Calls the viewers' sinks.
   * @param event - The event.
   */
  publish(event: SessionEvent): void {
    this.#ring?.record(event);
    for (const connectionId of this.viewers(event.sessionId)) this.sendTo(connectionId, event);
  }

  /**
   * The events a phone missed after its resume point, if the ring has them all.
   *
   * @remarks
   * See `EventRing.resume`; `null` means the phone gets a snapshot.
   *
   * @sideEffects Marks the session's kept events as used.
   * @param point - Where the phone's copy ends.
   * @param newest - The session's latest seq.
   * @returns The events to send before `session_resumed`, or `null`.
   */
  resume(point: ResumePoint, newest: number): SessionEvent[] | null {
    return this.#ring?.resume(point, newest) ?? null;
  }

  /**
   * Forgets the kept events of a session whose controller went.
   *
   * @remarks
   * A new controller starts a new stream, so they could not be resumed from anyway.
   *
   * @sideEffects Drops the session's kept events.
   * @param sessionId - The session.
   */
  forget(sessionId: string): void {
    this.#ring?.drop(sessionId);
  }

  /**
   * Delivers an event to one connection, if it is still registered.
   *
   * @remarks
   * Used for snapshots, which only the subscribing connection needs. Every snapshot, sent here or
   * published, is cut to the connection's budget on the way.
   *
   * @sideEffects Calls the connection's sink.
   * @param connectionId - The connection.
   * @param event - The event.
   */
  sendTo(connectionId: string, event: SinkEvent): void {
    const found = this.#sinks.get(connectionId);
    if (found === undefined) return;
    if (event.type !== "session_snapshot") {
      found.sink(event);
      return;
    }
    // A snapshot is where the ring starts keeping the session's events; it keeps none no phone watches.
    this.#ring?.start(event);
    found.sink(this.budgeted(connectionId, event));
  }

  /**
   * Cuts a snapshot to a connection's budget.
   *
   * @remarks
   * For a snapshot that goes out some other way, as in place of an event too large for a phone
   * (SPEC-0005, "Noise 通道 · 大小").
   *
   * @sideEffects none
   * @param connectionId - The connection.
   * @param snapshot - The default snapshot.
   * @returns The snapshot as the connection may get it.
   */
  budgeted(connectionId: string, snapshot: SessionSnapshotEvent): SessionSnapshotEvent {
    return withinBudget(snapshot, this.#budgets.get(connectionId));
  }

  /**
   * Delivers an event to every connection.
   *
   * @remarks
   * For what every window shows whatever it watches, as a login or an install job under way
   * (SPEC-0001, "首次启动 · 接口").
   *
   * @sideEffects Calls every connection's sink.
   * @param event - The event.
   */
  broadcast(event: BroadcastEvent): void {
    for (const { sink } of this.#sinks.values()) sink(event);
  }
}
