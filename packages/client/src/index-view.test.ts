import type { IndexSnapshotEvent } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  applyIndexSnapshot,
  emptyIndex,
  withContainer,
  withPreferences,
  withTabClosed,
  withTabOpen,
} from "./index-view";

const A = "wks_000000000000000a";

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
  failed: false,
});

/** A view whose list has sessions s1–s3 in workspace A and c1 in the chats, with `tabs` open in A. */
function viewWith(open: string[], active: string | null) {
  return {
    ...emptyIndex(),
    ready: true,
    sessions: [session("s1", A), session("s2", A), session("s3", A), session("c1", "chats")],
    layout: { container: A, tabs: { [A]: { open, active } } },
  };
}

describe("applyIndexSnapshot", () => {
  it("takes the first snapshot whatever its number", () => {
    const { ready: _ready, ...fields } = emptyIndex();
    const event: IndexSnapshotEvent = { type: "index_snapshot", ...fields, generation: "h1", seq: 0 };

    expect(applyIndexSnapshot(emptyIndex(), event)).toStrictEqual({ ...fields, ready: true, generation: "h1", seq: 0 });
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
      container: "chats",
      tabs: { [A]: { open: ["s1"], active: "s1" }, chats: { open: ["c1"], active: "c1" } },
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
      appearance: "dark",
      displayMode: "summary",
    });
  });
});
