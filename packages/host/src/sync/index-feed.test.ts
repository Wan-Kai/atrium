import type { IndexSnapshotEvent, SessionEvent } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { ResourceTracker } from "../platform/resources";
import { INDEX_PUSH_DELAY_MS, type IndexContent, createIndexFeed } from "./index-feed";
import { SubscriptionRegistry } from "./subscriptions";

/**
 * A feed over two connected clients whose deliveries are recorded.
 *
 * @remarks
 * The content names the client it was built for, so tests can see each got its own.
 *
 * @sideEffects none
 * @returns The feed, the deliveries, the clock and the resource tracker.
 */
function feed() {
  const resources = new ResourceTracker();
  const registry = new SubscriptionRegistry(resources);
  const received: Record<string, (SessionEvent | IndexSnapshotEvent)[]> = { a: [], b: [] };
  registry.connect("a", (event) => received["a"]?.push(event), "client-a");
  registry.connect("b", (event) => received["b"]?.push(event), "client-b");
  const clock = new FakeClock();
  let version = 0;
  const build = (clientId: string): IndexContent => ({
    projects: [],
    workspaces: [],
    sessions: [],
    layout: {
      container: null,
      tabs: { [`wks_${String(version).padStart(16, "0")}`]: { open: [clientId], active: null } },
    },
    preferences: { appearance: "system", displayMode: "summary" },
    resets: [],
  });
  const index = createIndexFeed({ registry, generation: "h1", build, clock, resources });
  return { index, received, clock, resources, registry, bump: () => (version += 1) };
}

/** The client and version a snapshot was built for, with its seq. */
function summary(event: SessionEvent | IndexSnapshotEvent) {
  if (event.type !== "index_snapshot") return event.type;
  const [container = "", tabs] = Object.entries(event.layout.tabs)[0] ?? [];
  return [event.generation, event.seq, Number(container.slice(4)), tabs?.open[0]];
}

describe("IndexFeed", () => {
  it("sends a subscriber its own snapshot at once", () => {
    const { index, received } = feed();

    index.subscribe("b");
    index.subscribe("nobody");

    expect(received["b"]?.map(summary)).toStrictEqual([["h1", 1, 0, "client-b"]]);
    expect(received["a"]).toStrictEqual([]);
  });

  it("merges changes made close together into one snapshot for every subscriber", () => {
    const { index, received, clock, bump, resources } = feed();
    index.subscribe("a");
    index.subscribe("b");

    bump();
    index.changed();
    index.changed();
    clock.advance(INDEX_PUSH_DELAY_MS - 1);
    expect(received["a"]).toHaveLength(1);
    expect(resources.snapshot()["timer"]).toBe(1);
    clock.advance(1);

    expect(received["a"]?.map(summary)).toStrictEqual([
      ["h1", 1, 0, "client-a"],
      ["h1", 3, 1, "client-a"],
    ]);
    expect(received["b"]?.map(summary)).toStrictEqual([
      ["h1", 2, 0, "client-b"],
      ["h1", 4, 1, "client-b"],
    ]);
    expect(resources.snapshot()["timer"]).toBe(0);
    index.changed();
    clock.advance(INDEX_PUSH_DELAY_MS);
    expect(received["a"]).toHaveLength(3);
  });

  it("stops sending to a connection that disconnected, and drops a pending push when closed", () => {
    const { index, received, clock, registry, resources } = feed();
    index.subscribe("a");
    index.subscribe("b");
    registry.disconnect("a");

    index.changed();
    clock.advance(INDEX_PUSH_DELAY_MS);
    index.changed();
    index.close();
    index.close();
    clock.advance(INDEX_PUSH_DELAY_MS);

    expect(received["a"]).toHaveLength(1);
    expect(received["b"]).toHaveLength(2);
    expect(resources.snapshot()["timer"]).toBe(0);
  });
});
