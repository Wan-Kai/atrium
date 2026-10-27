import type { ResumePoint, SessionEvent, SessionSnapshotEvent } from "@atrium/protocol";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";

/** How much the ring keeps (SPEC-0005, "协议改动" 3; "MP4c 定的细节"). */
export interface RingLimits {
  /** The most events kept for one session. */
  readonly events: number;
  /** The most bytes of events, encoded, kept for one session. */
  readonly bytes: number;
  /** The most bytes kept for all sessions together; the least recently used go first. */
  readonly totalBytes: number;
  /** How long a session's events are kept after the last phone stopped watching it. */
  readonly idleMs: number;
}

/** The limits SPEC-0005 sets: 512 events and 1 MiB a session, 32 MiB in all, 10 minutes. */
const RING_LIMITS: RingLimits = {
  events: 512,
  bytes: 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  idleMs: 10 * 60_000,
};

/** One session's kept events. */
interface SessionRing {
  /** How many phone connections watch the session. */
  watchers: number;
  /** Cancels the timer that forgets the session once nobody watches it. */
  cancelIdle: (() => void) | null;
  /** Releases the session's resource count. */
  readonly release: () => void;
  /** The stream and epoch the events belong to; `null` until a snapshot, or after a gap. */
  position: { readonly stream: string; readonly epoch: number } | null;
  /** The seq just before the first kept event. */
  base: number;
  /** The kept events, oldest first, with their encoded sizes. */
  events: { readonly event: SessionEvent; readonly bytes: number }[];
  bytes: number;
  /** When it was last recorded into or resumed from, for the total limit. */
  used: number;
}

/**
 * The recent events of the sessions phones watch, so a phone that reconnects can continue instead
 * of taking a snapshot.
 *
 * @remarks
 * SPEC-0005, "协议改动" 3 and "MP4c 定的细节": kept only for sessions with a phone watching, from the
 * session's latest snapshot on, while each event follows the one before; a gap or a new epoch starts
 * over at the next snapshot. Each kept session counts as a `sync.ring` resource.
 *
 * @sideEffects none until used.
 */
export class EventRing {
  readonly #clock: Clock;
  readonly #resources: ResourceTracker;
  readonly #limits: RingLimits;
  readonly #sessions = new Map<string, SessionRing>();

  /**
   * Creates an empty ring.
   *
   * @remarks
   * The limits are SPEC-0005's in the host; tests make them small.
   *
   * @sideEffects none
   * @param clock - For the idle timers and the least recently used order.
   * @param resources - Where kept sessions and timers are counted.
   * @param limits - How much to keep.
   */
  constructor(clock: Clock, resources: ResourceTracker, limits: RingLimits = RING_LIMITS) {
    this.#clock = clock;
    this.#resources = resources;
    this.#limits = limits;
  }

  /**
   * Counts a phone starting or stopping to watch a session.
   *
   * @remarks
   * The first watcher starts keeping the session; once the last one goes, it is forgotten after
   * `idleMs` unless one comes back.
   *
   * @sideEffects May create or schedule forgetting a session; counts resources.
   * @param sessionId - The session.
   * @param change - `1` when a phone starts watching, `-1` when it stops.
   */
  watch(sessionId: string, change: 1 | -1): void {
    let ring = this.#sessions.get(sessionId);
    if (ring === undefined) {
      if (change < 0) return;
      ring = {
        watchers: 0,
        cancelIdle: null,
        release: this.#resources.acquire("sync.ring"),
        position: null,
        base: 0,
        events: [],
        bytes: 0,
        used: this.#clock.now(),
      };
      this.#sessions.set(sessionId, ring);
    }
    ring.watchers = Math.max(0, ring.watchers + change);
    ring.cancelIdle?.();
    ring.cancelIdle = null;
    if (ring.watchers === 0) {
      ring.cancelIdle = trackedTimeout(
        this.#clock,
        this.#resources,
        () => {
          ring.cancelIdle = null;
          this.drop(sessionId);
        },
        this.#limits.idleMs,
      );
    }
  }

  /**
   * Starts a session's events over at a snapshot.
   *
   * @remarks
   * Ignored for a session no phone watches. A snapshot of where the kept events already end, as one
   * sent to a second phone, keeps them.
   *
   * @sideEffects Replaces the session's kept events.
   * @param snapshot - The snapshot.
   */
  start(snapshot: SessionSnapshotEvent): void {
    const ring = this.#sessions.get(snapshot.sessionId);
    if (ring === undefined) return;
    const same = ring.position?.stream === snapshot.stream && ring.position.epoch === snapshot.epoch;
    if (same && ring.base + ring.events.length === snapshot.seq) return;
    this.#clear(ring);
    ring.position = { stream: snapshot.stream, epoch: snapshot.epoch };
    ring.base = snapshot.seq;
  }

  /**
   * Keeps a published event of a watched session.
   *
   * @remarks
   * A snapshot starts over; an event that does not follow on empties the session until the next
   * snapshot. Past a session's limits its oldest events go; past the total, the least recently used
   * session's.
   *
   * @sideEffects Changes the kept events.
   * @param event - The event.
   */
  record(event: SessionEvent): void {
    if (event.type === "session_snapshot") {
      this.start(event);
      return;
    }
    const ring = this.#sessions.get(event.sessionId);
    if (ring === undefined || ring.position === null) return;
    if (event.type === "session_resumed") return;
    const last = ring.base + ring.events.length;
    if (event.epoch !== ring.position.epoch || event.seq !== last + 1) {
      this.#clear(ring);
      ring.position = null;
      return;
    }
    // Stryker disable next-line StringLiteral: an empty encoding is UTF-8.
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    ring.events.push({ event, bytes });
    ring.bytes += bytes;
    ring.used = this.#clock.now();
    while (ring.events.length > this.#limits.events || ring.bytes > this.#limits.bytes) this.#dropOldest(ring);
    this.#keepTotal(ring);
  }

  /**
   * The events a phone missed after its resume point, if the ring has them all.
   *
   * @remarks
   * Only when the stream and epoch are the ring's, the ring reaches the session's newest event
   * (`newest`, the controller's seq now), and the point is not before the oldest kept event nor past
   * the newest. Otherwise `null`: the phone gets a snapshot.
   *
   * @sideEffects Marks the session as used.
   * @param point - Where the phone's copy ends.
   * @param newest - The session's latest seq.
   * @returns The events after the point, oldest first; `null` when the ring cannot serve it.
   */
  resume(point: ResumePoint, newest: number): SessionEvent[] | null {
    const ring = this.#sessions.get(point.sessionId);
    if (ring?.position == null) return null;
    if (ring.position.stream !== point.stream || ring.position.epoch !== point.epoch) return null;
    const last = ring.base + ring.events.length;
    if (last !== newest || point.seq < ring.base || point.seq > last) return null;
    ring.used = this.#clock.now();
    return ring.events.slice(point.seq - ring.base).map(({ event }) => event);
  }

  /**
   * Forgets a session's events.
   *
   * @remarks
   * When its controller is reclaimed, or nobody watched it for `idleMs`.
   *
   * @sideEffects Cancels its timer; releases its resource count.
   * @param sessionId - The session.
   */
  drop(sessionId: string): void {
    const ring = this.#sessions.get(sessionId);
    if (ring === undefined) return;
    ring.cancelIdle?.();
    ring.release();
    this.#sessions.delete(sessionId);
  }

  /**
   * Forgets everything.
   *
   * @remarks
   * When the host closes.
   *
   * @sideEffects Cancels every timer; releases every count.
   */
  close(): void {
    for (const sessionId of this.#sessions.keys()) this.drop(sessionId);
  }

  /**
   * Empties a session's events, keeping where they would continue from.
   *
   * @remarks
   * The base moves to the last seq it had.
   *
   * @sideEffects Changes the session's ring.
   * @param ring - The session's ring.
   */
  #clear(ring: SessionRing): void {
    ring.base += ring.events.length;
    ring.events = [];
    ring.bytes = 0;
  }

  /**
   * Drops a session's oldest event.
   *
   * @remarks
   * A point before it can no longer resume.
   *
   * @sideEffects Changes the session's ring.
   * @param ring - The session's ring.
   */
  #dropOldest(ring: SessionRing): void {
    const oldest = ring.events.shift();
    if (oldest === undefined) return;
    ring.base += 1;
    ring.bytes -= oldest.bytes;
  }

  /**
   * Empties the least recently used sessions until all together fit the total.
   *
   * @remarks
   * The session just recorded into goes last.
   *
   * @sideEffects Changes other sessions' rings.
   * @param current - The session just recorded into.
   */
  #keepTotal(current: SessionRing): void {
    let total = 0;
    for (const ring of this.#sessions.values()) total += ring.bytes;
    const others = [...this.#sessions.values()].filter((ring) => ring !== current).toSorted((a, b) => a.used - b.used);
    for (const ring of [...others, current]) {
      if (total <= this.#limits.totalBytes) return;
      total -= ring.bytes;
      this.#clear(ring);
      ring.position = null;
    }
  }
}
