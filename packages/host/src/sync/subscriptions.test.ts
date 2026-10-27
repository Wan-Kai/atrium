import type { LoginUpdatedEvent, SessionEvent, SessionSnapshotEvent, Turn } from "@atrium/protocol";
import { IDLE_CONTROL, UNKNOWN_METRICS } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { ResourceTracker } from "../platform/resources";
import { type EventSink, SubscriptionRegistry } from "./subscriptions";

/** An event of a session. */
function eventOf(sessionId: string, seq: number): SessionEvent {
  return { type: "step_delta", sessionId, epoch: 1, seq, traceId: null, turnId: "t1", stepId: "0", delta: "x" };
}

/** A registry with two connections whose deliveries are recorded. */
function twoConnections() {
  const resources = new ResourceTracker();
  const registry = new SubscriptionRegistry(resources);
  const received: Record<string, Parameters<EventSink>[0][]> = { a: [], b: [] };
  registry.connect("a", (event) => received["a"]?.push(event), "client-a");
  registry.connect("b", (event) => received["b"]?.push(event), "client-b");
  return { registry, received, resources };
}

describe("SubscriptionRegistry", () => {
  it("replaces a connection's subscriptions, counting each, and reports which sessions are new to it", () => {
    const { registry, resources } = twoConnections();

    expect(registry.subscribe("a", ["s1", "s2"])).toStrictEqual(["s1", "s2"]);
    expect(registry.subscribe("a", ["s2", "s3", "s3"])).toStrictEqual(["s3"]);
    expect(registry.subscribe("b", ["s2"])).toStrictEqual(["s2"]);

    expect(registry.viewers("s1")).toStrictEqual([]);
    expect(registry.viewers("s2")).toStrictEqual(["a", "b"]);
    expect(registry.viewers("s3")).toStrictEqual(["a"]);
    expect(resources.snapshot()["sync.subscription"]).toBe(3);
    registry.subscribe("a", []);
    expect(resources.snapshot()["sync.subscription"]).toBe(1);
  });

  it("delivers a session's events only to its viewers, and a snapshot only where it is sent", () => {
    const { registry, received } = twoConnections();
    registry.subscribe("a", ["s1"]);
    registry.subscribe("b", ["s1", "s2"]);

    registry.publish(eventOf("s1", 1));
    registry.publish(eventOf("s2", 1));
    registry.sendTo("a", eventOf("s9", 0));

    expect(received).toStrictEqual({
      a: [eventOf("s1", 1), eventOf("s9", 0)],
      b: [eventOf("s1", 1), eventOf("s2", 1)],
    });
  });

  it("forgets a connection and its subscriptions when it disconnects, releasing its count once", () => {
    const { registry, received, resources } = twoConnections();
    registry.subscribe("a", ["s1"]);
    expect(resources.snapshot()).toStrictEqual({ "sync.connection": 2, "sync.subscription": 1 });

    registry.disconnect("a");
    registry.disconnect("a");
    registry.disconnect("never-connected");
    expect(resources.snapshot()).toStrictEqual({ "sync.connection": 1, "sync.subscription": 0 });
    registry.publish(eventOf("s1", 1));
    registry.sendTo("a", eventOf("s1", 2));

    expect(registry.viewers("s1")).toStrictEqual([]);
    expect(registry.subscribe("a", ["s1"])).toStrictEqual([]);
    expect(received["a"]).toStrictEqual([]);
  });
});

describe("SubscriptionRegistry.broadcast", () => {
  it("delivers to every connection, watching anything or not, until it disconnects", () => {
    const { registry, received } = twoConnections();
    registry.subscribe("a", ["s1"]);
    const login: LoginUpdatedEvent = {
      type: "login_updated",
      loginId: "l1",
      providerId: "acme",
      method: "oauth",
      state: "running",
      authUrl: null,
      deviceCode: null,
      questions: [],
      progress: null,
      error: null,
    };

    registry.broadcast(login);
    registry.disconnect("b");
    registry.broadcast({ ...login, state: "ok" });

    expect(received).toStrictEqual({ a: [login, { ...login, state: "ok" }], b: [login] });
  });
});

describe("SubscriptionRegistry list subscribers", () => {
  it("records which connections watch the list, with their clients, until they disconnect", () => {
    const { registry } = twoConnections();

    expect(registry.subscribeIndex("b")).toStrictEqual({ connectionId: "b", clientId: "client-b" });
    expect(registry.subscribeIndex("a")).toStrictEqual({ connectionId: "a", clientId: "client-a" });
    expect(registry.subscribeIndex("b")).toStrictEqual({ connectionId: "b", clientId: "client-b" });
    expect(registry.subscribeIndex("never-connected")).toBeUndefined();
    expect(registry.indexSubscribers()).toStrictEqual([
      { connectionId: "b", clientId: "client-b" },
      { connectionId: "a", clientId: "client-a" },
    ]);

    registry.disconnect("b");
    expect(registry.indexSubscribers()).toStrictEqual([{ connectionId: "a", clientId: "client-a" }]);
  });
});

/** A finished turn without steps. */
function turn(id: string): Turn {
  return {
    kind: "turn",
    id,
    source: null,
    user: { text: "q", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 1 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 1,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

/** A snapshot of a session with three turns. */
function snapshotOf(sessionId: string): SessionSnapshotEvent {
  return {
    type: "session_snapshot",
    sessionId,
    epoch: 1,
    seq: 0,
    traceId: null,
    stream: "st-1",
    items: [turn("t1"), turn("t2"), turn("t3")],
    hasOlder: false,
    run: null,
    exited: false,
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
  };
}

describe("SubscriptionRegistry: snapshot budgets", () => {
  it("cuts the snapshots each connection gets to the budget of its latest subscription", () => {
    const { registry, received } = twoConnections();
    registry.subscribe("a", ["s1"], { turns: 1, bytes: 65_536 });
    registry.subscribe("b", ["s1"]);

    registry.publish(snapshotOf("s1"));
    registry.sendTo("a", snapshotOf("s1"));

    const cut = { ...snapshotOf("s1"), items: snapshotOf("s1").items.slice(2), hasOlder: true };
    expect(received).toStrictEqual({ a: [cut, cut], b: [snapshotOf("s1")] });
  });

  it("goes back to the default when a subscription comes without a budget, and leaves other events alone", () => {
    const { registry, received } = twoConnections();
    registry.subscribe("a", ["s1"], { turns: 1, bytes: 65_536 });
    registry.publish(eventOf("s1", 1));
    registry.subscribe("a", ["s1"]);
    registry.publish(snapshotOf("s1"));

    expect(received["a"]).toStrictEqual([eventOf("s1", 1), snapshotOf("s1")]);
  });

  it("cuts a snapshot it is handed for a connection, and forgets the budget when the connection goes", () => {
    const { registry } = twoConnections();
    registry.subscribe("a", ["s1"], { turns: 2, bytes: 65_536 });

    expect(registry.budgeted("a", snapshotOf("s1")).items.map((item) => item.id)).toStrictEqual(["t2", "t3"]);
    expect(registry.budgeted("b", snapshotOf("s1"))).toStrictEqual(snapshotOf("s1"));
    registry.disconnect("a");
    expect(registry.budgeted("a", snapshotOf("s1"))).toStrictEqual(snapshotOf("s1"));
  });
});
