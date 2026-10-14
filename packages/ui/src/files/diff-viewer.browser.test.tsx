import type { DiffFile, DiffHunk, DiffMode } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { type PaneStorage, memoryStorage } from "../state/panes";
import { createWorkspaceViews, openDiff, viewOf } from "../state/workspace-views";
import { fakeClient } from "../test/fake-client";
import { DiffViewer } from "./diff-viewer";

const W = "wks_0000000000000001";

/**
 * A hunk of as many added lines as given, from line 1.
 *
 * @sideEffects none
 * @param count - How many lines.
 * @returns The hunk.
 */
function added(count: number): DiffHunk {
  return {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: count,
    lines: Array.from({ length: count }, (_, at) => ({
      kind: "add" as const,
      oldNumber: null,
      newNumber: at + 1,
      text: `line ${at + 1}`,
    })),
  };
}

/** An edited file, a rename, a binary file, one too large, and a long new one, out of the tree's order. */
const FILES: DiffFile[] = [
  { path: "z.json", oldPath: null, status: "deleted", added: 0, removed: 1500, content: "too_large", hunks: [] },
  {
    path: "src/chat/a.ts",
    oldPath: null,
    status: "modified",
    added: 1,
    removed: 1,
    content: "text",
    hunks: [
      {
        oldStart: 3,
        oldCount: 2,
        newStart: 3,
        newCount: 2,
        lines: [
          { kind: "context", oldNumber: 3, newNumber: 3, text: "keep();" },
          { kind: "del", oldNumber: 4, newNumber: null, text: "old();" },
          { kind: "add", oldNumber: null, newNumber: 4, text: "const fresh = 1;" },
        ],
      },
    ],
  },
  { path: "docs/new.md", oldPath: "docs/old.md", status: "renamed", added: 0, removed: 0, content: "text", hunks: [] },
  { path: "logo.png", oldPath: null, status: "added", added: 0, removed: 0, content: "binary", hunks: [] },
  { path: "src/long.ts", oldPath: null, status: "added", added: 40, removed: 0, content: "text", hunks: [added(40)] },
];

/**
 * The 改动 tab on workspace W in a frame 300px high, the host having sent the files given.
 *
 * @sideEffects Renders.
 * @param options - The files, the mode, and the storage.
 * @returns The screen, the views, the storage, how to show another mode, and the tab's scroll area.
 */
async function viewer({
  files = FILES,
  mode = "uncommitted",
  storage = memoryStorage(),
}: { files?: DiffFile[]; mode?: DiffMode; storage?: PaneStorage } = {}) {
  const { client } = fakeClient();
  client.changes(W).setState({ stat: { added: 1, removed: 1 }, dirty: true, ahead: 0, branch: "feat", base: "main" });
  client.diff.setState({ target: { workspaceId: W, mode }, status: "ready", files, tooLarge: false, error: null });
  const views = createWorkspaceViews(storage);
  const drawn = (shown: DiffMode) => (
    <div style={{ display: "flex", height: 300, width: 500 }}>
      <DiffViewer client={client} workspaceId={W} views={views} mode={shown} />
    </div>
  );
  const screen = await render(drawn(mode));
  /**
   * Shows another mode, the host having sent the same files for it.
   *
   * @sideEffects Sets the client's diff; renders.
   * @param shown - The mode.
   */
  const switchTo = async (shown: DiffMode): Promise<void> => {
    client.diff.setState({
      target: { workspaceId: W, mode: shown },
      status: "ready",
      files,
      tooLarge: false,
      error: null,
    });
    await screen.rerender(drawn(shown));
  };
  return { screen, views, storage, switchTo, body: screen.getByTestId("viewer-body").element() };
}

/**
 * Where an element's top is, from the top of a scroll area.
 *
 * @sideEffects none
 * @param element - The element.
 * @param body - The scroll area.
 * @returns The distance in pixels, rounded.
 */
function topIn(element: Element, body: Element): number {
  return Math.round(element.getBoundingClientRect().top - body.getBoundingClientRect().top);
}

describe("DiffViewer", () => {
  it("shows every file in the tree's order under its header, with the mode, the count and the totals", async () => {
    const { screen } = await viewer();

    await expect.element(screen.getByRole("region", { name: "src/chat/a.ts" })).toBeVisible();
    expect([
      screen.getByRole("region", { name: "改动" }).element().querySelector("header")?.textContent,
      [...screen.getByTestId("viewer-body").element().querySelectorAll("section")].map((file) =>
        file.getAttribute("aria-label"),
      ),
    ]).toStrictEqual(["未提交5 个文件+41−1.5k", ["docs/new.md", "src/chat/a.ts", "src/long.ts", "logo.png", "z.json"]]);
  });

  it("shows each file's diff: numbered lines, the hunk's header, a rename, binary and large files", async () => {
    const { screen } = await viewer();

    const edited = screen.getByRole("region", { name: "src/chat/a.ts" });
    await expect.element(edited.getByRole("button")).toHaveTextContent("a.tssrc/chat/+1−1");
    expect([
      edited.getByText("@@ -3,2 +3,2 @@").query() !== null,
      [...edited.element().querySelectorAll("[data-kind]")].map((line) => line.textContent),
      screen.getByRole("region", { name: "docs/new.md" }).getByRole("button").element().textContent,
      screen.getByRole("region", { name: "docs/new.md" }).getByRole("button").element().getAttribute("title"),
      screen.getByRole("region", { name: "logo.png" }).element().textContent,
      screen.getByRole("region", { name: "z.json" }).element().textContent,
    ]).toStrictEqual([
      true,
      ["3keep();", "4old();", "4const fresh = 1;"],
      "docs/old.md → new.mddocs/+0−0",
      "docs/old.md → docs/new.md",
      "logo.png+0−0二进制文件",
      "z.json+0−1.5k改动太大，不显示",
    ]);
  });

  it("keeps a file's header at the top while its diff scrolls under it", async () => {
    const { screen, body } = await viewer();
    const header = screen.getByRole("region", { name: "src/long.ts" }).getByRole("button");
    await expect.element(header).toBeVisible();

    body.scrollTop = topIn(header.element(), body) + 200;

    await expect.poll(() => topIn(header.element(), body)).toBe(0);
  });

  it("colours the lines by their language", async () => {
    const { screen } = await viewer();
    const line = screen.getByText("const fresh = 1;").element();

    await expect
      .poll(() => [...line.querySelectorAll("span[style]")].map((token) => getComputedStyle(token).color).at(0))
      .toBe("rgb(215, 58, 73)");
  });

  it("folds a file from its header and all from the top row, keeping what is folded for the mode", async () => {
    const first = await viewer();
    const header = first.screen.getByRole("region", { name: "src/chat/a.ts" }).getByRole("button");
    await header.click();
    await expect.element(first.screen.getByText("keep();")).not.toBeInTheDocument();
    await first.screen.unmount();

    const again = await viewer({ storage: first.storage });
    await expect.element(again.screen.getByText("line 1", { exact: true })).toBeVisible();
    const folded = [
      again.screen.getByText("keep();").query(),
      again.screen.getByText("line 1", { exact: true }).query(),
    ];
    await again.screen.getByRole("button", { name: "全部折叠" }).click();
    await expect.element(again.screen.getByText("line 1", { exact: true })).not.toBeInTheDocument();
    await again.screen.unmount();
    const otherMode = await viewer({ storage: first.storage, mode: "base" });

    await expect.element(otherMode.screen.getByText("keep();")).toBeVisible();
    expect([folded[0], folded[1] !== null]).toStrictEqual([null, true]);
  });

  it("shows each mode's folds as it switches", async () => {
    const { screen, switchTo } = await viewer();
    await screen.getByRole("region", { name: "src/chat/a.ts" }).getByRole("button").click();
    await expect.element(screen.getByText("keep();")).not.toBeInTheDocument();

    await switchTo("base");
    await expect.element(screen.getByText("keep();")).toBeVisible();
    await switchTo("uncommitted");

    await expect.element(screen.getByText("keep();")).not.toBeInTheDocument();
  });

  it("unfolds them all again once all are folded", async () => {
    const { screen } = await viewer();
    await screen.getByRole("button", { name: "全部折叠" }).click();

    await screen.getByRole("button", { name: "全部展开" }).click();

    await expect.element(screen.getByText("keep();")).toBeVisible();
  });

  it("goes to the file asked for once, unfolding it, its header flashing, even the last", async () => {
    const storage = memoryStorage();
    storage.setItem(`atrium.foldedFiles:${W}:uncommitted`, JSON.stringify(["z.json"]));
    const { screen, views, body } = await viewer({ storage });
    await expect.element(screen.getByRole("region", { name: "z.json" })).toBeInTheDocument();
    const header = screen.getByRole("region", { name: "z.json" }).getByRole("button");

    openDiff(views, W, "z.json");

    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => topIn(header.element(), body)).toBe(0);
    expect([
      header
        .element()
        .getAnimations()
        .map((animation) =>
          (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame["backgroundColor"]),
        ),
      viewOf(views.getState(), W).reveal?.done,
    ]).toStrictEqual([[["var(--selected)", "var(--main)"]], true]);
  });

  it("stops the header's flash when it goes, so it does not keep the tab alive", async () => {
    const { screen, views } = await viewer();
    const header = screen.getByRole("region", { name: "z.json" }).getByRole("button");
    openDiff(views, W, "z.json");
    await expect.poll(() => header.element().getAnimations().length).toBe(1);
    const flash = header.element().getAnimations()[0];

    await screen.unmount();

    expect(flash?.playState).toBe("idle");
  });

  it("wraps long lines only when asked", async () => {
    const line = { kind: "add" as const, oldNumber: null, newNumber: 1, text: "x".repeat(400) };
    const hunk = { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [line] };
    const { screen, body } = await viewer({
      files: [
        { path: "src/wide.ts", oldPath: null, status: "added", added: 1, removed: 0, content: "text", hunks: [hunk] },
      ],
    });
    await expect.element(screen.getByRole("region", { name: "src/wide.ts" })).toBeVisible();
    // A group is laid out once it shows, a frame after it is added.
    await expect.poll(() => body.scrollWidth > body.clientWidth).toBe(true);

    await screen.getByRole("button", { name: "换行" }).click();

    await expect.poll(() => body.scrollWidth > body.clientWidth).toBe(false);
  });

  it("names the branch's commits as its mode, and says when there are no changes", async () => {
    const { screen } = await viewer({ files: [], mode: "base" });

    await expect.element(screen.getByText("没有改动")).toBeVisible();
    expect(screen.getByRole("region", { name: "改动" }).element().querySelector("header")?.textContent).toBe("已提交");
  });
});
