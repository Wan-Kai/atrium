import { IDLE_CONTROL, type SessionEvent, type SessionSnapshotEvent, UNKNOWN_METRICS } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { ResourceTracker } from "../platform/resources";
import { EventRing } from "./event-ring";

/** A snapshot of `s1` at a position. */
function snapshot(epoch: number, seq: number, stream = "st-1", sessionId = "s1"): SessionSnapshotEvent {
  return {
    type: "session_snapshot",
    sessionId,
    epoch,
    seq,
    traceId: null,
    stream,
    items: [],
    hasOlder: false,
    run: null,
    exited: false,
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
  };
}

/** A small event of `s1` at a position. */
function delta(epoch: number, seq: number, text = "x", sessionId = "s1"): SessionEvent {
  return { type: "step_delta", sessionId, epoch, seq, traceId: null, turnId: "t1", stepId: "0", delta: text };
}

/** A ring with a fake clock and resource counts. */
function setUp(limits: Partial<ConstructorParameters<typeof EventRing>[2]> = {}) {
  const clock = new FakeClock(0);
  const resources = new ResourceTracker();
  const ring = new EventRing(clock, resources, {
    events: 512,
    bytes: 1024 * 1024,
    totalBytes: 32 * 1024 * 1024,
    idleMs: 600_000,
    ...limits,
  });
  return { clock, resources, ring };
}

describe("EventRing", () => {
  it("replays the events after a resume point of the same stream and epoch, up to the newest", () => {
    const { ring } = setUp();
    ring.watch("s1", 1);
    ring.start(snapshot(2, 4));
    for (const seq of [5, 6, 7]) ring.record(delta(2, seq));

    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 5 }, 7)).toStrictEqual([
      delta(2, 6),
      delta(2, 7),
    ]);
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 7 }, 7)).toStrictEqual([]);
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 4 }, 7)).toHaveLength(3);
  });

  it("cannot resume another stream or epoch, a point it does not cover, a point past the newest, or one it never kept", () => {
    const { ring } = setUp();
    ring.watch("s1", 1);
    ring.start(snapshot(2, 4));
    ring.record(delta(2, 5));

    expect(ring.resume({ sessionId: "s1", stream: "st-2", epoch: 2, seq: 4 }, 5)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 4 }, 5)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 3 }, 5)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 6 }, 5)).toBeNull();
    // The ring has not seen the newest event the controller has.
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 4 }, 6)).toBeNull();
    expect(ring.resume({ sessionId: "s9", stream: "st-1", epoch: 2, seq: 4 }, 5)).toBeNull();
  });

  it("starts again at a new snapshot, and empties on an event that does not follow on", () => {
    const { ring } = setUp();
    ring.watch("s1", 1);
    ring.start(snapshot(1, 0));
    ring.record(delta(1, 1));
    ring.record(snapshot(2, 0));
    ring.record(delta(2, 1));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 0 }, 1)).toStrictEqual([delta(2, 1)]);

    ring.record(delta(2, 3));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 1 }, 2)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 0 }, 3)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 3 }, 3)).toBeNull();
  });

  it("keeps its events when a snapshot of the same position goes to another phone", () => {
    const { ring } = setUp();
    ring.watch("s1", 1);
    ring.start(snapshot(1, 0));
    ring.record(delta(1, 1));
    ring.start(snapshot(1, 1));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 1)).toStrictEqual([delta(1, 1)]);
  });

  it("keeps the events at a snapshot of where they end, and starts over at one of another epoch or position", () => {
    const { ring } = setUp();
    ring.watch("s1", 1);
    ring.start(snapshot(1, 0));
    ring.record(delta(1, 1));
    ring.start(snapshot(1, 1));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 1)).toStrictEqual([delta(1, 1)]);

    ring.start(snapshot(2, 1));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 0 }, 1)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 1 }, 1)).toStrictEqual([]);
    ring.record(delta(2, 2));
    ring.start(snapshot(2, 5));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 1 }, 5)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 2, seq: 5 }, 5)).toStrictEqual([]);
  });

  it("keeps nothing for a watched session before its first snapshot", () => {
    const { ring } = setUp();
    ring.watch("s1", 1);
    ring.record(delta(1, 1));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 1)).toBeNull();
  });

  it("keeps nothing for a session no phone watches", () => {
    const { ring } = setUp();
    ring.start(snapshot(1, 0));
    ring.record(delta(1, 1));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 1)).toBeNull();
  });

  it("drops the oldest events past the count or the bytes, so a point before them cannot resume", () => {
    const { ring } = setUp({ events: 3 });
    ring.watch("s1", 1);
    ring.start(snapshot(1, 0));
    for (const seq of [1, 2, 3, 4]) ring.record(delta(1, seq));
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 4)).toBeNull();
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 1 }, 4)).toHaveLength(3);

    const size = Buffer.byteLength(JSON.stringify(delta(1, 1, "y".repeat(100))), "utf8");
    const small = setUp({ bytes: size * 2 }).ring;
    small.watch("s1", 1);
    small.start(snapshot(1, 0));
    for (const seq of [1, 2, 3]) small.record(delta(1, seq, "y".repeat(100)));
    expect(small.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 3)).toBeNull();
    expect(small.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 1 }, 3)).toHaveLength(2);
  });

  it("drops the least recently used session's events when all sessions together pass the total", () => {
    const size = Buffer.byteLength(JSON.stringify(delta(1, 1, "z".repeat(100))), "utf8");
    const { ring, clock } = setUp({ totalBytes: size * 3 });
    for (const id of ["a", "b", "c"]) {
      ring.watch(id, 1);
      ring.start(snapshot(1, 0, "st", id));
    }
    ring.record(delta(1, 1, "z".repeat(100), "a"));
    clock.advance(1);
    ring.record(delta(1, 1, "z".repeat(100), "c"));
    clock.advance(1);
    ring.record(delta(1, 1, "z".repeat(100), "b"));
    clock.advance(1);
    ring.record(delta(1, 2, "z".repeat(100), "b"));

    expect(ring.resume({ sessionId: "a", stream: "st", epoch: 1, seq: 0 }, 1)).toBeNull();
    expect(ring.resume({ sessionId: "c", stream: "st", epoch: 1, seq: 0 }, 1)).toHaveLength(1);
    expect(ring.resume({ sessionId: "b", stream: "st", epoch: 1, seq: 0 }, 2)).toHaveLength(2);
  });

  it("forgets a session ten minutes after the last phone stopped watching it, unless one watches again", () => {
    const { ring, clock, resources } = setUp();
    ring.watch("s1", 1);
    ring.start(snapshot(1, 0));
    ring.record(delta(1, 1));
    expect(resources.snapshot()["sync.ring"]).toBe(1);

    ring.watch("s1", -1);
    clock.advance(599_999);
    ring.watch("s1", 1);
    clock.advance(600_000);
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 1)).toHaveLength(1);

    ring.watch("s1", -1);
    clock.advance(600_000);
    expect(ring.resume({ sessionId: "s1", stream: "st-1", epoch: 1, seq: 0 }, 1)).toBeNull();
    expect(resources.snapshot()).toStrictEqual({ "sync.ring": 0, timer: 0 });
  });

  it("drops a session on request, and everything when closed", () => {
    const { ring, resources } = setUp();
    for (const id of ["a", "b"]) {
      ring.watch(id, 1);
      ring.start(snapshot(1, 0, "st", id));
      ring.watch(id, -1);
    }
    ring.watch("never-watched", -1);
    expect(resources.snapshot()["sync.ring"]).toBe(2);
    ring.drop("a");
    expect(ring.resume({ sessionId: "a", stream: "st", epoch: 1, seq: 0 }, 0)).toBeNull();
    expect(ring.resume({ sessionId: "b", stream: "st", epoch: 1, seq: 0 }, 0)).toStrictEqual([]);
    ring.close();
    expect(resources.snapshot()).toStrictEqual({ "sync.ring": 0, timer: 0 });
  });
});
