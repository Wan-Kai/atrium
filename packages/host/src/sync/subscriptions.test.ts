import type { SessionEvent } from "@atrium/protocol";
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
  it("replaces a connection's subscriptions and reports which sessions are new to it", () => {
    const { registry } = twoConnections();

    expect(registry.subscribe("a", ["s1", "s2"])).toStrictEqual(["s1", "s2"]);
    expect(registry.subscribe("a", ["s2", "s3", "s3"])).toStrictEqual(["s3"]);
    expect(registry.subscribe("b", ["s2"])).toStrictEqual(["s2"]);

    expect(registry.viewers("s1")).toStrictEqual([]);
    expect(registry.viewers("s2")).toStrictEqual(["a", "b"]);
    expect(registry.viewers("s3")).toStrictEqual(["a"]);
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
    expect(resources.snapshot()).toStrictEqual({ "sync.connection": 2 });

    registry.disconnect("a");
    registry.disconnect("a");
    registry.disconnect("never-connected");
    expect(resources.snapshot()).toStrictEqual({ "sync.connection": 1 });
    registry.publish(eventOf("s1", 1));
    registry.sendTo("a", eventOf("s1", 2));

    expect(registry.viewers("s1")).toStrictEqual([]);
    expect(registry.subscribe("a", ["s1"])).toStrictEqual([]);
    expect(received["a"]).toStrictEqual([]);
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
