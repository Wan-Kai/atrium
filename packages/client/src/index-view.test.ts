import type { IndexChangesEvent, IndexSnapshotEvent } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  applyIndexChanges,
  applyIndexSnapshot,
  cursorOf,
  emptyIndex,
  withContainer,
  withPreferences,
  withTabClosed,
  withTabOpen,
} from "./index-view";

const A = "wks_000000000000000a";
const C = "cht_c";

/** A chat without a name. */
const chat = (id: string) => ({ id, dir: `/home/chats/${id}`, alias: null, firstSessionId: null });

/** A session of `containerId`. */
const session = (sessionId: string, containerId: string) => ({
  sessionId,
  containerId,
  name: null,
  prompt: null,
  file: null,
  state: "persisted" as const,
  updatedAt: 0,
  archived: false,
  running: false,
  attention: null,
  asking: null,
  handedOff: false,
});

/** A view whose list has sessions s1–s3 in workspace A and c1 in chat C, with `tabs` open in A. */
function viewWith(open: string[], active: string | null) {
  return {
    ...emptyIndex(),
    ready: true,
    sessions: [session("s1", A), session("s2", A), session("s3", A), session("c1", C)],
    layout: { container: A, tabs: { [A]: { open, active } } },
  };
}

describe("emptyIndex", () => {
  it("is an empty list, not ready, with the default preferences", () => {
    expect(emptyIndex()).toStrictEqual({
      ready: false,
      generation: "",
      seq: 0,
      projects: [],
      workspaces: [],
      chats: [],
      sessions: [],
      layout: { container: null, tabs: {} },
      preferences: {
        setupDone: false,
        appearance: "system",
        displayMode: "summary",
        lastModel: null,
        thinkingByModel: {},
        lastFast: false,
        statusBar: {},
        titleModel: null,
        proxy: null,
      },
      resets: [],
    });
  });
});

describe("applyIndexSnapshot", () => {
  it("takes every snapshot whole, whatever its number", () => {
    const { ready: _ready, ...fields } = emptyIndex();
    const event: IndexSnapshotEvent = {
      type: "index_snapshot",
      ...fields,
      generation: "h1",
      seq: 0,
      reason: "cursor_expired",
    };

    expect(applyIndexSnapshot(viewWith(["s1"], "s1"), event)).toStrictEqual({
      ...fields,
      ready: true,
      generation: "h1",
      seq: 0,
    });
  });
});

describe("applyIndexChanges", () => {
  /** Changes of host `h1` at `seq` 5 that change nothing. */
  const nothing: IndexChangesEvent = {
    type: "index_changes",
    generation: "h1",
    seq: 5,
    projects: { upsert: [], remove: [] },
    workspaces: { upsert: [], remove: [] },
    chats: { upsert: [], remove: [] },
    sessions: { upsert: [], remove: [] },
    layout: null,
    preferences: null,
  };
  const project = { id: "prj_0000000000000001", path: "/work/app", name: "app", mainBranch: null };

  it("replaces changed items where they are, adds new ones at the end and drops removed ones", () => {
    const view = { ...viewWith(["s1"], "s1"), generation: "h1", seq: 4, projects: [project] };

    const next = applyIndexChanges(view, {
      ...nothing,
      projects: { upsert: [{ ...project, name: "renamed" }], remove: [] },
      sessions: { upsert: [{ ...session("s4", A) }, { ...session("s2", A), running: true }], remove: ["s1", "s9"] },
    });

    expect(next).toStrictEqual({
      ...view,
      seq: 5,
      projects: [{ ...project, name: "renamed" }],
      sessions: [{ ...session("s2", A), running: true }, session("s3", A), session("c1", C), session("s4", A)],
    });
  });

  it("tells projects, workspaces and chats apart by their ids", () => {
    const second = { id: "prj_0000000000000002", path: "/work/lib", name: "lib", mainBranch: "trunk" };
    /** A local workspace of the first project. */
    const workspace = (id: string, dir: string) => ({
      id,
      projectId: project.id,
      kind: "local" as const,
      dir,
      alias: null,
      branch: null,
      head: null,
      external: false,
      createdAt: null,
      merge: null,
      archivedAt: null,
    });
    const [w1, w2, w3] = [
      workspace("wks_0000000000000001", "/work/app"),
      workspace("wks_0000000000000002", "/work/app-2"),
      workspace("wks_0000000000000003", "/work/app-3"),
    ];
    const [c1, c2, c3] = [chat("cht_1"), chat("cht_2"), chat("cht_3")];
    const view = {
      ...viewWith([], null),
      generation: "h1",
      seq: 4,
      projects: [project, second],
      workspaces: [w1, w2],
      chats: [c1, c2],
    };

    const next = applyIndexChanges(view, {
      ...nothing,
      projects: { upsert: [{ ...second, name: "renamed" }], remove: [] },
      workspaces: { upsert: [w3, { ...w2, alias: "two" }], remove: [w1.id] },
      chats: { upsert: [c3, { ...c1, alias: "周报" }], remove: [c2.id] },
    });

    expect([next.projects, next.workspaces, next.chats]).toStrictEqual([
      [project, { ...second, name: "renamed" }],
      [{ ...w2, alias: "two" }, w3],
      [{ ...c1, alias: "周报" }, c3],
    ]);
  });

  it("takes the layout and preferences when they come, and keeps its own otherwise", () => {
    const view = { ...viewWith(["s1"], "s1"), generation: "h1", seq: 4 };
    const layout = { container: null, tabs: {} };
    const preferences = { ...view.preferences, appearance: "dark" as const };

    expect(applyIndexChanges(view, { ...nothing, layout, preferences })).toStrictEqual({
      ...view,
      seq: 5,
      layout,
      preferences,
    });
    expect(applyIndexChanges(view, nothing)).toStrictEqual({ ...view, seq: 5 });
  });

  it("ignores changes before the first snapshot or from another host", () => {
    const view = { ...viewWith(["s1"], "s1"), generation: "h1", seq: 4 };
    const changes = { ...nothing, sessions: { upsert: [], remove: ["s1"] } };

    expect(applyIndexChanges(emptyIndex(), changes)).toStrictEqual(emptyIndex());
    expect(applyIndexChanges(view, { ...changes, generation: "h2" })).toBe(view);
  });
});

describe("cursorOf", () => {
  it("is the list's position once a snapshot arrived", () => {
    expect(cursorOf(emptyIndex())).toBeUndefined();
    expect(cursorOf({ ...viewWith([], null), generation: "h1", seq: 4 })).toStrictEqual({ generation: "h1", seq: 4 });
  });
});

describe("withTabOpen", () => {
  it("adds a tab at the end once, activates it and goes to its container", () => {
    expect(withTabOpen(viewWith(["s1"], "s1"), "s2").layout).toStrictEqual({
      container: A,
      tabs: { [A]: { open: ["s1", "s2"], active: "s2" } },
    });
    expect(withTabOpen(viewWith(["s1", "s2"], "s2"), "s1").layout.tabs[A]).toStrictEqual({
      open: ["s1", "s2"],
      active: "s1",
    });
    expect(withTabOpen(viewWith(["s1"], "s1"), "c1").layout).toStrictEqual({
      container: C,
      tabs: { [A]: { open: ["s1"], active: "s1" }, [C]: { open: ["c1"], active: "c1" } },
    });
  });

  it("leaves a session the list does not know to the host", () => {
    const view = viewWith(["s1"], "s1");

    expect(withTabOpen(view, "unknown")).toBe(view);
  });
});

describe("withTabClosed", () => {
  it("activates the tab to the right of a closed active tab, else the one to its left, else none", () => {
    expect(withTabClosed(viewWith(["s1", "s2", "s3"], "s2"), "s2").layout.tabs[A]).toStrictEqual({
      open: ["s1", "s3"],
      active: "s3",
    });
    expect(withTabClosed(viewWith(["s1", "s3"], "s3"), "s3").layout.tabs[A]).toStrictEqual({
      open: ["s1"],
      active: "s1",
    });
    expect(withTabClosed(viewWith(["s1"], "s1"), "s1").layout.tabs[A]).toStrictEqual({ open: [], active: null });
  });

  it("keeps the active tab when another closes, and changes nothing for a tab not open", () => {
    expect(withTabClosed(viewWith(["s1", "s2"], "s2"), "s1").layout.tabs[A]).toStrictEqual({
      open: ["s2"],
      active: "s2",
    });
    expect(withTabClosed(viewWith(["s1"], "s1"), "s9").layout).toStrictEqual(viewWith(["s1"], "s1").layout);
  });
});

describe("withContainer and withPreferences", () => {
  it("go to a container or nowhere, and change only the preferences given", () => {
    expect(withContainer(viewWith([], null), null).layout).toStrictEqual({
      container: null,
      tabs: { [A]: { open: [], active: null } },
    });
    expect(withPreferences(emptyIndex(), { appearance: "dark" }).preferences).toStrictEqual({
      setupDone: false,
      appearance: "dark",
      displayMode: "summary",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
    });
  });

  it("replaces the status bar's choices whole", () => {
    const chosen = withPreferences(emptyIndex(), { statusBar: { cost: true, session: false } });

    expect(withPreferences(chosen, { statusBar: { tokens: false } }).preferences.statusBar).toStrictEqual({
      tokens: false,
    });
  });
});
