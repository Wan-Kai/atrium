import type { Chat, Layout, Preferences, Project, SessionSummary, Workspace } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { ResourceTracker } from "../platform/resources";
import {
  INDEX_PUSH_DELAY_MS,
  INDEX_REMOVALS_KEPT,
  INDEX_CHANGES_LIMIT,
  type IndexContent,
  createIndexFeed,
} from "./index-feed";
import { type EventSink, SubscriptionRegistry } from "./subscriptions";

const PREFERENCES: Preferences = {
  setupDone: false,
  appearance: "system",
  lastModel: null,
  thinkingByModel: {},
  lastFast: false,
  statusBar: {},
  titleModel: null,
  proxy: null,
  inbox: true,
};

/**
 * A project with an id made from a number.
 *
 * @remarks
 * Ids must look like `prj_` and 16 hex digits.
 *
 * @sideEffects none
 * @param n - The number.
 * @param name - Its name.
 * @returns The project.
 */
function project(n: number, name = `p${n}`): Project {
  return { id: `prj_${n.toString(16).padStart(16, "0")}`, path: `/work/${n}`, name, mainBranch: null };
}

/**
 * A workspace of project 1.
 *
 * @remarks
 * See `project`.
 *
 * @sideEffects none
 * @param n - The number in its id.
 * @returns The workspace.
 */
function workspace(n: number): Workspace {
  return {
    id: `wks_${n.toString(16).padStart(16, "0")}`,
    projectId: project(1).id,
    kind: "local",
    dir: `/work/${n}`,
    alias: null,
    branch: "main",
    head: null,
    external: false,
    createdAt: null,
    merge: null,
    archivedAt: null,
  };
}

/** The chat the tests' sessions are in. */
const CHAT = "cht_a";

/**
 * A chat, as the list holds it.
 *
 * @remarks
 * Named or not, so a test can change it.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param alias - Its name.
 * @returns The chat.
 */
function chat(id: string, alias: string | null = null): Chat {
  return { id, dir: `/home/.atrium/chats/${id}`, alias, firstSessionId: null, archivedAt: null };
}

/**
 * A session in a chat.
 *
 * @remarks
 * Running or not, so a test can change it.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param running - Whether a run is in progress.
 * @returns The summary.
 */
function session(id: string, running = false): SessionSummary {
  return {
    sessionId: id,
    containerId: CHAT,
    name: null,
    prompt: id,
    file: null,
    state: "draft",
    updatedAt: 1,
    archived: false,
    running,
    attention: null,
    asking: null,
    handedOff: false,
  };
}

/**
 * A feed over two connected clients whose deliveries are recorded.
 *
 * @remarks
 * The content and each client's layout are plain values the test changes before calling
 * `changed`.
 *
 * @sideEffects none
 * @param limits - Smaller limits than the host's, so a test need not make thousands of changes.
 * @returns The feed, the deliveries, the content, the layouts, the clock, the registry and the
 * resource tracker.
 */
function feed(limits: { readonly removalsKept?: number; readonly changesLimit?: number } = {}) {
  const resources = new ResourceTracker();
  const registry = new SubscriptionRegistry(resources);
  const received: Record<string, Parameters<EventSink>[0][]> = { a: [], b: [] };
  registry.connect("a", (event) => received["a"]?.push(event), "client-a");
  registry.connect("b", (event) => received["b"]?.push(event), "client-b");
  const clock = new FakeClock();
  const content: { -readonly [K in keyof IndexContent]: IndexContent[K] } = {
    projects: [project(1)],
    workspaces: [workspace(1)],
    chats: [chat(CHAT)],
    sessions: [session("s1")],
    preferences: PREFERENCES,
    resets: ["layouts"],
  };
  const layouts: Record<string, Layout> = {};
  const layoutOf = (clientId: string): Layout => layouts[clientId] ?? { container: null, tabs: {} };
  const built = { count: 0 };
  const index = createIndexFeed({
    registry,
    generation: "h1",
    build: () => {
      built.count += 1;
      return content;
    },
    layoutOf,
    clock,
    resources,
    ...limits,
  });
  /** Lets the merged push go out. */
  const push = () => {
    index.changed();
    clock.advance(INDEX_PUSH_DELAY_MS);
  };
  return { index, received, content, layouts, clock, resources, registry, push, built };
}

/**
 * A snapshot's reason, `seq` and number of sessions; any other event whole.
 *
 * @remarks
 * Tests of when the feed sends a snapshot need not spell out the list.
 *
 * @sideEffects none
 * @param event - An event sent.
 * @returns Its gist.
 */
function gist(event: Parameters<EventSink>[0]): unknown {
  if (event.type !== "index_snapshot") return event;
  return [event.reason, event.seq, event.sessions.length];
}

/** No change to one collection. */
const none = { upsert: [], remove: [] };

describe("IndexFeed", () => {
  it("sends a subscriber without a cursor the whole list at once, with its own layout", () => {
    const { index, received, layouts } = feed();
    layouts["client-b"] = { container: CHAT, tabs: { [CHAT]: { open: ["s1"], active: "s1" } } };

    index.subscribe("b");
    index.subscribe("nobody");

    expect(received["b"]).toStrictEqual([
      {
        type: "index_snapshot",
        generation: "h1",
        seq: 1,
        reason: "no_cursor",
        projects: [project(1)],
        workspaces: [workspace(1)],
        chats: [chat(CHAT)],
        sessions: [session("s1")],
        layout: { container: CHAT, tabs: { [CHAT]: { open: ["s1"], active: "s1" } } },
        preferences: PREFERENCES,
        resets: ["layouts"],
      },
    ]);
    expect(received["a"]).toStrictEqual([]);
  });

  it("sends every subscriber only what changed, changes close together merged into one batch", () => {
    const { index, received, content, clock, resources, push } = feed();
    index.subscribe("a");
    index.subscribe("b");

    content.sessions = [session("s1", true), session("s2")];
    content.workspaces = [];
    content.chats = [chat(CHAT, "合并原理"), chat("cht_b")];
    index.changed();
    content.projects = [project(1, "renamed"), project(2)];
    index.changed();
    clock.advance(INDEX_PUSH_DELAY_MS - 1);
    expect(received["a"]).toHaveLength(1);
    expect(resources.snapshot()["timer"]).toBe(1);
    clock.advance(1);

    const changes = {
      type: "index_changes",
      generation: "h1",
      seq: 2,
      projects: { upsert: [project(1, "renamed"), project(2)], remove: [] },
      workspaces: { upsert: [], remove: [workspace(1).id] },
      chats: { upsert: [chat(CHAT, "合并原理"), chat("cht_b")], remove: [] },
      sessions: { upsert: [session("s1", true), session("s2")], remove: [] },
      layout: null,
      preferences: null,
    };
    expect(received["a"]?.slice(1)).toStrictEqual([changes]);
    expect(received["b"]?.slice(1)).toStrictEqual([changes]);
    expect(resources.snapshot()["timer"]).toBe(0);
    push();
    expect(received["a"]).toHaveLength(2);
  });

  it("sends a client's own layout only to it, with no new seq, and the preferences to all", () => {
    const { index, received, layouts, content, push } = feed();
    index.subscribe("a");
    index.subscribe("b");

    layouts["client-a"] = { container: CHAT, tabs: {} };
    push();
    content.preferences = { ...PREFERENCES, appearance: "dark" };
    push();

    expect(received["a"]?.slice(1)).toStrictEqual([
      {
        type: "index_changes",
        generation: "h1",
        seq: 1,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: none,
        layout: { container: CHAT, tabs: {} },
        preferences: null,
      },
      {
        type: "index_changes",
        generation: "h1",
        seq: 2,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: none,
        layout: null,
        preferences: { ...PREFERENCES, appearance: "dark" },
      },
    ]);
    expect(received["b"]?.slice(1)).toStrictEqual([
      {
        type: "index_changes",
        generation: "h1",
        seq: 2,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: none,
        layout: null,
        preferences: { ...PREFERENCES, appearance: "dark" },
      },
    ]);
  });

  it("sends a connection its waiting batch at once when flushed, and the others when the batch is due", () => {
    const { index, received, layouts, content, clock } = feed();
    index.subscribe("a");
    index.subscribe("b");
    index.flush("a");

    layouts["client-a"] = { container: CHAT, tabs: {} };
    content.sessions = [session("s1"), session("s2")];
    index.changed();
    index.flush("a");
    index.flush("c");
    const flushed = { a: received["a"]?.slice(1), b: received["b"]?.slice(1) };
    clock.advance(INDEX_PUSH_DELAY_MS);

    const batch = {
      type: "index_changes",
      generation: "h1",
      seq: 2,
      projects: none,
      workspaces: none,
      chats: none,
      sessions: { upsert: [session("s2")], remove: [] },
      preferences: null,
    };
    expect(flushed).toStrictEqual({ a: [{ ...batch, layout: { container: CHAT, tabs: {} } }], b: [] });
    expect(received["a"]?.slice(1)).toStrictEqual([{ ...batch, layout: { container: CHAT, tabs: {} } }]);
    expect(received["b"]?.slice(1)).toStrictEqual([{ ...batch, layout: null }]);
  });

  it("answers a cursor of this host with what changed after it, its layout and the preferences whole", () => {
    const { index, received, content, layouts, push, registry } = feed();
    index.subscribe("a");
    content.sessions = [session("s1", true)];
    push();
    content.sessions = [session("s2")];
    content.projects = [project(1), project(2)];
    push();
    layouts["client-b"] = { container: CHAT, tabs: {} };

    registry.disconnect("b");
    registry.connect("b2", (event) => received["b"]?.push(event), "client-b");
    index.subscribe("b2", { generation: "h1", seq: 2 });
    index.subscribe("b2", { generation: "h1", seq: 3 });

    expect(received["b"]).toStrictEqual([
      {
        type: "index_changes",
        generation: "h1",
        seq: 3,
        projects: { upsert: [project(2)], remove: [] },
        workspaces: none,
        chats: none,
        sessions: { upsert: [session("s2")], remove: ["s1"] },
        layout: { container: CHAT, tabs: {} },
        preferences: PREFERENCES,
      },
      {
        type: "index_changes",
        generation: "h1",
        seq: 3,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: none,
        layout: { container: CHAT, tabs: {} },
        preferences: PREFERENCES,
      },
    ]);
  });

  it.each([
    ["generation_changed", { generation: "h0", seq: 1 }],
    ["cursor_expired", { generation: "h1", seq: 2 }],
  ] as const)("sends the whole list for a cursor it cannot serve: %s", (reason, cursor) => {
    const { index, received } = feed();

    index.subscribe("a", cursor);

    expect(received["a"]?.map(gist)).toStrictEqual([[reason, 1, 1]]);
  });

  it("sends only the connection flushed its waiting batch, and builds nothing when no batch waits", () => {
    const { index, received, content, built } = feed();
    index.subscribe("a");
    index.subscribe("b");
    const builds = built.count;
    index.flush("b");
    expect(built.count).toBe(builds);

    content.sessions = [session("s1"), session("s2")];
    index.changed();
    index.flush("b");

    expect([received["a"]?.length, received["b"]?.slice(1)]).toStrictEqual([
      1,
      [
        {
          type: "index_changes",
          generation: "h1",
          seq: 2,
          projects: none,
          workspaces: none,
          chats: none,
          sessions: { upsert: [session("s2")], remove: [] },
          layout: null,
          preferences: null,
        },
      ],
    ]);
  });

  it("has the limits SPEC-0001 sets: a thousand removals kept, two hundred changes served", () => {
    expect([INDEX_REMOVALS_KEPT, INDEX_CHANGES_LIMIT]).toStrictEqual([1000, 200]);
  });

  it("sends the whole list to a subscriber whose batch removed more than it keeps", () => {
    const { index, received, content, push } = feed({ removalsKept: 3 });
    index.subscribe("a");
    content.sessions = [session("t0"), session("t1"), session("t2"), session("t3")];
    push();

    content.sessions = [];
    push();
    content.sessions = [session("t4")];
    push();

    expect(received["a"]?.slice(2).map(gist)).toStrictEqual([
      ["cursor_expired", 3, 0],
      {
        type: "index_changes",
        generation: "h1",
        seq: 4,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: { upsert: [session("t4")], remove: [] },
        layout: null,
        preferences: null,
      },
    ]);
  });

  it("forgets the oldest removals past the limit, and sends the whole list to a cursor before them", () => {
    const { index, received, content, push } = feed({ removalsKept: 3 });
    index.subscribe("a");
    for (const id of ["t0", "t1", "t2", "t3"]) {
      content.sessions = [session(id)];
      push();
    }

    // The removal of s1 at seq 2 is forgotten; the one of t0 at seq 3 is kept.
    index.subscribe("b", { generation: "h1", seq: 1 });
    index.subscribe("b", { generation: "h1", seq: 2 });

    expect(received["b"]?.map(gist)).toStrictEqual([
      ["cursor_expired", 5, 1],
      {
        type: "index_changes",
        generation: "h1",
        seq: 5,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: { upsert: [session("t3")], remove: ["t0", "t1", "t2"] },
        layout: { container: null, tabs: {} },
        preferences: PREFERENCES,
      },
    ]);
  });

  it("sends the whole list rather than more changes than the limit", () => {
    const { index, received, content, push } = feed({ changesLimit: 2 });
    index.subscribe("a");
    content.sessions = [session("s1"), session("s2"), session("s3")];
    push();
    content.sessions = [session("s1"), session("s2"), session("s3"), session("s4")];
    push();

    index.subscribe("b", { generation: "h1", seq: 2 });
    index.subscribe("b", { generation: "h1", seq: 1 });

    expect(received["b"]?.map(gist)).toStrictEqual([
      {
        type: "index_changes",
        generation: "h1",
        seq: 3,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: { upsert: [session("s4")], remove: [] },
        layout: { container: null, tabs: {} },
        preferences: PREFERENCES,
      },
      ["too_many_changes", 3, 4],
    ]);
  });

  it("counts removals among the changes, and serves as many changes as the limit", () => {
    const { index, received, content, push } = feed({ changesLimit: 2 });
    index.subscribe("a");
    content.sessions = [session("s2")];
    push();
    index.subscribe("b", { generation: "h1", seq: 1 });
    content.sessions = [session("s3")];
    push();
    index.subscribe("b", { generation: "h1", seq: 1 });

    expect(received["b"]?.map(gist)).toStrictEqual([
      {
        type: "index_changes",
        generation: "h1",
        seq: 2,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: { upsert: [session("s2")], remove: ["s1"] },
        layout: { container: null, tabs: {} },
        preferences: PREFERENCES,
      },
      {
        type: "index_changes",
        generation: "h1",
        seq: 3,
        projects: none,
        workspaces: none,
        chats: none,
        sessions: { upsert: [session("s3")], remove: ["s2"] },
        layout: null,
        preferences: null,
      },
      ["too_many_changes", 3, 1],
    ]);
  });

  it("stops sending to a connection that disconnected, and drops a pending push and later changes when closed", () => {
    const { index, received, clock, registry, resources, content, push } = feed();
    index.subscribe("a");
    index.subscribe("b");
    registry.disconnect("a");

    content.sessions = [];
    push();
    content.sessions = [session("s9")];
    index.changed();
    index.close();
    index.close();
    index.changed();
    clock.advance(INDEX_PUSH_DELAY_MS);

    expect(received["a"]).toHaveLength(1);
    expect(received["b"]).toHaveLength(2);
    expect(resources.snapshot()["timer"]).toBe(0);
  });
});
