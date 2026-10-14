import { describe, expect, it } from "vitest";
import { memoryStorage } from "./panes";
import {
  NO_VIEW,
  chooseDiff,
  choosePanelTab,
  closeViewer,
  createWorkspaceViews,
  currentTab,
  keepPaths,
  keptPaths,
  keptPathsKey,
  openDiff,
  openFile,
  holdPanelDefault,
  keepPlace,
  panelTabOf,
  placeOf,
  pinViewer,
  revealed,
  showViewer,
  tabOrder,
  viewOf,
} from "./workspace-views";

const W = "wks_0000000000000001";

/**
 * Views with nothing open, and how to read a container's.
 *
 * @sideEffects none
 * @returns The store, its storage, and the container's view now.
 */
function views() {
  const storage = memoryStorage();
  const store = createWorkspaceViews(storage);
  return { store, storage, view: () => viewOf(store.getState(), W) };
}

describe("viewer tabs", () => {
  it("opens a file as a preview, which the next preview takes the place of, in place", () => {
    const { store, view } = views();

    openFile(store, W, "a.ts", true);
    openFile(store, W, "b.ts", false);
    openFile(store, W, "c.ts", false);

    expect(view()).toStrictEqual({
      ...NO_VIEW,
      tabs: [
        { kind: "file", path: "a.ts", preview: false },
        { kind: "file", path: "c.ts", preview: true },
      ],
      active: "file:c.ts",
    });
  });

  it("opens a pinned file after the preview, keeping it, and shows a file already open without moving it", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", false);
    openFile(store, W, "b.ts", true);

    openFile(store, W, "a.ts", false);
    const shown = view();
    openFile(store, W, "b.ts", false);

    expect([shown, view().active, view().tabs]).toStrictEqual([
      {
        ...NO_VIEW,
        tabs: [
          { kind: "file", path: "a.ts", preview: true },
          { kind: "file", path: "b.ts", preview: false },
        ],
        active: "file:a.ts",
      },
      "file:b.ts",
      shown.tabs,
    ]);
  });

  it("pins a file open as a preview when opened pinned or pinned on its tab, so the next preview opens beside it, and only that one", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", false);
    openFile(store, W, "a.ts", true);
    openFile(store, W, "b.ts", false);
    openFile(store, W, "b.ts", true);
    openDiff(store, W, null);
    pinViewer(store, W, "diff");

    openFile(store, W, "c.ts", false);
    pinViewer(store, W, "file:a.ts");

    expect(view().tabs).toStrictEqual([
      { kind: "file", path: "a.ts", preview: false },
      { kind: "file", path: "b.ts", preview: false },
      { kind: "diff" },
      { kind: "file", path: "c.ts", preview: true },
    ]);
  });

  it("opens one 改动 tab last, going to a file in it again each time asked, and keeps it where it is otherwise", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", true);
    openDiff(store, W, null);
    const opened = view();

    openDiff(store, W, "src/b.ts");
    openDiff(store, W, "src/b.ts");
    openFile(store, W, "c.ts", false);
    openDiff(store, W, null);

    expect([opened.reveal, view()]).toStrictEqual([
      null,
      {
        ...NO_VIEW,
        tabs: [
          { kind: "file", path: "a.ts", preview: false },
          { kind: "diff" },
          { kind: "file", path: "c.ts", preview: true },
        ],
        active: "diff",
        reveal: { path: "src/b.ts", count: 2, done: false },
      },
    ]);
  });

  it("shows a viewer tab or the session, the session for a tab not open", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", false);
    openDiff(store, W, null);

    showViewer(store, W, "file:a.ts");
    const file = view().active;
    showViewer(store, W, null);
    const session = view().active;
    showViewer(store, W, "file:gone.ts");

    expect([file, session, view().active]).toStrictEqual(["file:a.ts", null, null]);
  });

  it("keeps each container's tabs apart", () => {
    const { store } = views();
    openFile(store, W, "a.ts", false);

    expect(viewOf(store.getState(), "wks_0000000000000002")).toBe(NO_VIEW);
  });
});

describe("tab order", () => {
  it("counts the sessions' tabs, then the viewers', and finds the one shown", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", false);
    openDiff(store, W, null);
    const order = tabOrder(["s1", "s2"], view());
    const onDiff = currentTab(order, view(), "s2");
    showViewer(store, W, null);

    expect([order, onDiff, currentTab(order, view(), "s2"), currentTab(order, view(), null)]).toStrictEqual([
      [
        { kind: "session", id: "s1" },
        { kind: "session", id: "s2" },
        { kind: "viewer", key: "file:a.ts" },
        { kind: "viewer", key: "diff" },
      ],
      3,
      1,
      -1,
    ]);
  });
});

describe("closeViewer", () => {
  it("goes to the viewer tab left of the one shown when it closes", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", true);
    openFile(store, W, "b.ts", true);
    openFile(store, W, "c.ts", true);

    const session = closeViewer(store, W, "file:c.ts", ["s1"]);

    expect([session, view().active, view().tabs]).toStrictEqual([
      null,
      "file:b.ts",
      [
        { kind: "file", path: "a.ts", preview: false },
        { kind: "file", path: "b.ts", preview: false },
      ],
    ]);
  });

  it("goes to the session left of it, which the caller opens", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", true);

    expect([closeViewer(store, W, "file:a.ts", ["s1", "s2"]), view()]).toStrictEqual(["s2", NO_VIEW]);
  });

  it("goes right when nothing is left of it, and to the session when nothing is open", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", true);
    openFile(store, W, "b.ts", true);
    showViewer(store, W, "file:a.ts");

    const first = closeViewer(store, W, "file:a.ts", []);
    const shown = view().active;
    const last = closeViewer(store, W, "file:b.ts", []);

    expect([first, shown, last, view().active]).toStrictEqual([null, "file:b.ts", null, null]);
  });

  it("leaves what shows as it is when a tab not shown closes", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", true);
    openFile(store, W, "b.ts", true);
    showViewer(store, W, null);

    const fromSession = closeViewer(store, W, "file:a.ts", ["s1"]);
    openFile(store, W, "c.ts", true);
    const fromViewer = closeViewer(store, W, "file:b.ts", ["s1"]);

    expect([fromSession, fromViewer, view().active, view().tabs]).toStrictEqual([
      null,
      null,
      "file:c.ts",
      [{ kind: "file", path: "c.ts", preview: false }],
    ]);
  });
});

describe("viewer places", () => {
  it("keeps where each open tab was left, from the top and not wrapping at first", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", true);
    openDiff(store, W, null);
    const first = placeOf(view(), "file:a.ts");

    keepPlace(store, W, "file:a.ts", { scrollTop: 120 });
    keepPlace(store, W, "file:a.ts", { wrap: true });
    keepPlace(store, W, "diff", { wrap: true });

    expect([first, placeOf(view(), "file:a.ts"), placeOf(view(), "diff"), placeOf(view(), "toString")]).toStrictEqual([
      { scrollTop: 0, wrap: false },
      { scrollTop: 120, wrap: true },
      { scrollTop: 0, wrap: true },
      { scrollTop: 0, wrap: false },
    ]);
  });

  it("forgets a tab's place as it closes or another preview takes its place, keeping none for a tab not open", () => {
    const { store, view } = views();
    openFile(store, W, "a.ts", false);
    openFile(store, W, "b.ts", true);
    keepPlace(store, W, "file:a.ts", { scrollTop: 120 });
    keepPlace(store, W, "file:b.ts", { scrollTop: 80 });

    openFile(store, W, "c.ts", false);
    const replaced = view().places;
    closeViewer(store, W, "file:b.ts", []);
    keepPlace(store, W, "file:b.ts", { scrollTop: 40 });

    expect([replaced, view().places]).toStrictEqual([{ "file:b.ts": { scrollTop: 80, wrap: false } }, {}]);
  });
});

describe("revealed", () => {
  it("marks going to the file done, keeping which file, and does nothing with none asked", () => {
    const { store, view } = views();
    revealed(store, W);
    const none = view().reveal;
    openDiff(store, W, "a.ts");

    revealed(store, W);

    expect([none, view().reveal]).toStrictEqual([null, { path: "a.ts", count: 1, done: true }]);
  });
});

describe("chooseDiff", () => {
  it("remembers the mode chosen for the container, and forgets it", () => {
    const { store, view } = views();

    chooseDiff(store, W, { mode: "base", dirty: true });
    const chosen = view().choice;
    chooseDiff(store, W, null);

    expect([chosen, view().choice]).toStrictEqual([{ mode: "base", dirty: true }, null]);
  });
});

describe("panel tab", () => {
  it("is 更改 for a workspace with changes and 文件 without, until one is chosen, which is kept", () => {
    const { store, storage } = views();
    const before = [panelTabOf(store.getState(), W, true), panelTabOf(store.getState(), W, false)];

    choosePanelTab(store, W, "files");
    const after = [panelTabOf(store.getState(), W, true), storage.getItem(`atrium.panelTab:${W}`)];
    const restarted = createWorkspaceViews(storage).getState();

    expect([before, after, panelTabOf(restarted, W, true)]).toStrictEqual([
      ["changes", "files"],
      ["files", "files"],
      "files",
    ]);
  });

  it("keeps the tab chosen while the page lives, even where the storage keeps nothing", () => {
    const store = createWorkspaceViews({ getItem: () => null, setItem: () => undefined });
    const before = panelTabOf(store.getState(), W, true);

    choosePanelTab(store, W, "files");
    const files = panelTabOf(store.getState(), W, true);
    choosePanelTab(store, W, "changes");

    expect([before, files, panelTabOf(store.getState(), W, false)]).toStrictEqual(["changes", "files", "changes"]);
  });

  it("is the one the open panel holds until it lets go, unless one is chosen, by workspace", () => {
    const { store } = views();
    holdPanelDefault(store, W, "files");
    holdPanelDefault(store, "wks_0000000000000002", "changes");
    const held = [panelTabOf(store.getState(), W, true), panelTabOf(store.getState(), "wks_0000000000000002", false)];
    choosePanelTab(store, "wks_0000000000000002", "files");
    const chosen = panelTabOf(store.getState(), "wks_0000000000000002", false);

    holdPanelDefault(store, W, null);

    expect([held, chosen, panelTabOf(store.getState(), W, true)]).toStrictEqual([
      ["files", "changes"],
      "files",
      "changes",
    ]);
    expect(store.getState().panelDefaults).toStrictEqual({ wks_0000000000000002: "changes" });
  });

  it("reads a kept value that names no tab as none", () => {
    const { store, storage } = views();
    storage.setItem(`atrium.panelTab:${W}`, "diff");

    expect(panelTabOf(store.getState(), W, false)).toBe("files");
  });
});

describe("kept paths", () => {
  it("keeps a set of paths by workspace, and by mode for folds", () => {
    const storage = memoryStorage();

    keepPaths(storage, keptPathsKey("foldedDirs", W, "base"), new Set(["src", "docs"]));

    expect([
      [...keptPaths(storage, keptPathsKey("foldedDirs", W, "base"))],
      [...keptPaths(storage, keptPathsKey("foldedDirs", W, "uncommitted"))],
      keptPathsKey("openDirs", W, null),
      keptPathsKey("foldedFiles", W, "uncommitted"),
    ]).toStrictEqual([["src", "docs"], [], `atrium.openDirs:${W}`, `atrium.foldedFiles:${W}:uncommitted`]);
  });

  it("reads anything but an array of strings as none, keeping the strings of an array", () => {
    const sets = ["{", '{"a":1}', '["a",2,null,"b"]'].map((value) => {
      const storage = memoryStorage();
      storage.setItem("k", value);
      return [...keptPaths(storage, "k")];
    });

    expect(sets).toStrictEqual([[], [], ["a", "b"]]);
  });
});
