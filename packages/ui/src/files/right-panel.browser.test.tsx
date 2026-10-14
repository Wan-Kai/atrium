import type { ChangesView } from "@atrium/client";
import type { CommandResult, DiffFile, DirEntry } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { StoreApi } from "zustand";
import "../styles.css";
import { memoryStorage } from "../state/panes";
import { type WorkspaceViews, createWorkspaceViews, viewOf } from "../state/workspace-views";
import { fakeClient, session, workspace } from "../test/fake-client";
import { RightPanel } from "./right-panel";
import { useDiffWatch } from "./use-diff";

const W = "wks_0000000000000001";
const DIRTY = { stat: { added: 4, removed: 1501 }, dirty: true, ahead: 0, branch: "feat", base: "origin/main" };

/** Two edited files under one directory chain, a rename, and a deleted file too large to show. */
const FILES: DiffFile[] = [
  { path: "src/chat/a.ts", oldPath: null, status: "modified", added: 1, removed: 1, content: "text", hunks: [] },
  { path: "src/chat/b.ts", oldPath: null, status: "added", added: 3, removed: 0, content: "text", hunks: [] },
  { path: "docs/new.md", oldPath: "docs/old.md", status: "renamed", added: 0, removed: 0, content: "text", hunks: [] },
  { path: "big.json", oldPath: null, status: "deleted", added: 0, removed: 1500, content: "too_large", hunks: [] },
];

/** The workspace's directories, as the host lists them: unsorted. */
const DIRS: Readonly<Record<string, readonly DirEntry[]>> = {
  "": [
    { name: "b.ts", kind: "file" },
    { name: "src", kind: "dir" },
    { name: "a10.md", kind: "file" },
    { name: "a9.md", kind: "file" },
    { name: ".github", kind: "dir" },
    { name: "link", kind: "link" },
  ],
  src: [{ name: "chat", kind: "dir" }],
  "src/chat": [
    { name: "b.ts", kind: "file" },
    { name: "a.ts", kind: "file" },
  ],
  ".github": [],
};

/**
 * Watches the diff as the conversation area does while the panel is open.
 *
 * @sideEffects Sends `watch_diff`; writes the views.
 * @param props - The client and the views.
 * @returns Nothing.
 */
function Watcher({
  client,
  views,
}: {
  client: ReturnType<typeof fakeClient>["client"];
  views: StoreApi<WorkspaceViews>;
}) {
  useDiffWatch(client, views, W, true);
  return null;
}

/**
 * The panel on workspace W, its diff watched, over a fake client listing `DIRS`.
 *
 * @sideEffects Renders.
 * @param options - What the workspace's changes say, the storage, and how to list a directory.
 * @returns The screen, the client, its calls, the views, how the panel was closed, and how to draw it afresh.
 */
async function panel({
  changes = DIRTY,
  storage = memoryStorage(),
  listDir = async (_id: string, path: string): Promise<CommandResult<"list_dir">> => ({
    entries: [...(DIRS[path] ?? [])],
    truncated: false,
  }),
}: {
  changes?: ChangesView;
  storage?: ReturnType<typeof memoryStorage>;
  listDir?: (id: string, path: string) => Promise<CommandResult<"list_dir">>;
} = {}) {
  const { client, calls, changeCalls, index } = fakeClient(
    // A session running in the workspace, so a run can end.
    {
      workspaces: [workspace({ id: W, dir: "/work/atrium" })],
      sessions: [session({ sessionId: "s1", containerId: W, running: true })],
    },
    { listDir },
  );
  client.changes(W).setState(changes);
  const views = createWorkspaceViews(storage);
  const onClose = vi.fn<() => void>();
  const drawn = () => (
    <div style={{ display: "flex", height: 600, width: 320 }}>
      <Watcher client={client} views={views} />
      <RightPanel client={client} workspaceId={W} views={views} onClose={onClose} />
    </div>
  );
  const screen = await render(drawn());
  return { screen, client, calls, changeCalls, index, views, onClose, storage, drawn };
}

/**
 * The host's answer for the diff watched.
 *
 * @sideEffects Sets the client's diff.
 * @param client - The client.
 * @param fields - What differs from `FILES`, ready.
 */
function answer(
  client: ReturnType<typeof fakeClient>["client"],
  fields: Partial<{ files: DiffFile[]; tooLarge: boolean; error: "not_git" | "failed" | null }> = {},
): void {
  const { target } = client.diff.getState();
  client.diff.setState({ target, status: "ready", files: FILES, tooLarge: false, error: null, ...fields });
}

/**
 * The text of each row of a tree.
 *
 * @sideEffects none
 * @param tree - The tree's body.
 * @returns The rows' text.
 */
function rowsOf(tree: Element): (string | null)[] {
  return [...tree.querySelectorAll("button")].map((row) => row.textContent);
}

/**
 * Lists `DIRS`, holding one directory's listing until let go.
 *
 * @sideEffects none
 * @param held - The directory held.
 * @returns How to list, and how to let the held listing go.
 */
function holding(held: string) {
  const gate = Promise.withResolvers<void>();
  return {
    listDir: async (_id: string, path: string): Promise<CommandResult<"list_dir">> => {
      await (path === held ? gate.promise : undefined);
      return { entries: [...(DIRS[path] ?? [])], truncated: false };
    },
    release: () => gate.resolve(),
  };
}

/**
 * The colour of a row's changed dot.
 *
 * @sideEffects none
 * @param row - The row.
 * @returns The colour, or `null` for no dot.
 */
function dotOf(row: Element): string | null {
  return row.querySelector<HTMLElement>("[data-testid=changed-dot]")?.style.backgroundColor ?? null;
}

describe("RightPanel's tabs", () => {
  it("opens at 更改 with the number of files changed, at 文件 where nothing changed", async () => {
    const changed = await panel();
    answer(changed.client);

    await expect.element(changed.screen.getByRole("tab", { name: /更改/ })).toHaveTextContent("更改4");
    await expect.element(changed.screen.getByRole("tab", { name: /更改/ })).toHaveAttribute("aria-selected", "true");
    await changed.screen.unmount();
    const clean = await panel({ changes: null });

    await expect.element(clean.screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    await expect.element(clean.screen.getByRole("tab", { name: "更改" })).toHaveTextContent("更改");
  });

  it("stays at the tab it opened at while changes come and go", async () => {
    const { screen, client } = await panel({ changes: { ...DIRTY, stat: null, dirty: false } });
    const files = screen.getByRole("tab", { name: "文件" });
    await expect.element(files).toHaveAttribute("aria-selected", "true");

    client.changes(W).setState(DIRTY);
    await vi.waitFor(() => expect(client.diff.getState().target?.mode).toBe("uncommitted"));
    answer(client);

    await expect.element(screen.getByRole("tab", { name: /更改/ })).toHaveTextContent("更改4");
    expect(files.element().getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the tab chosen for the workspace", async () => {
    const first = await panel();
    await first.screen.getByRole("tab", { name: "文件" }).click();
    await first.screen.unmount();

    const again = await panel({ storage: first.storage });

    await expect.element(again.screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    expect(first.storage.getItem(`atrium.panelTab:${W}`)).toBe("files");
  });

  it("closes from its button, and on Esc inside it but only the menu while that is open", async () => {
    const { screen, client, onClose } = await panel();
    answer(client);
    await screen.getByRole("button", { name: "关闭右栏" }).click();
    await screen.getByRole("button", { name: "比较" }).click();
    await expect.element(screen.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("RightPanel's 更改", () => {
  it("shows the changed files as a tree: directories first, a lone chain on one row, with counts", async () => {
    const { screen, client } = await panel();
    await expect.element(screen.getByText("正在检查仓库…")).toBeVisible();
    answer(client);

    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("未提交");
    const tree = screen.getByTestId("changes-tree");
    await expect
      .poll(() => rowsOf(tree.element()))
      .toStrictEqual(["docs+0−0", "new.md+0−0", "src/chat+4−1", "a.ts+1−1", "b.ts+3−0", "big.json+0−1.5k"]);
    expect([
      tree
        .getByRole("button", { name: /new\.md/ })
        .element()
        .getAttribute("title"),
      tree
        .getByRole("button", { name: /big\.json/ })
        .element()
        .querySelector(".line-through")?.textContent,
      screen.getByRole("button", { name: "刷新" }).element().parentElement?.textContent,
    ]).toStrictEqual(["docs/old.md → docs/new.md", "big.json", "未提交+4−1.5k"]);
  });

  it("folds a directory, and keeps it folded for the workspace and mode", async () => {
    const first = await panel();
    answer(first.client);
    await first.screen.getByRole("button", { name: /src\/chat/ }).click();
    await expect.element(first.screen.getByRole("button", { name: /a\.ts/ })).not.toBeInTheDocument();
    await first.screen.unmount();

    const again = await panel({ storage: first.storage });
    answer(again.client);

    await expect.element(again.screen.getByRole("button", { name: /big\.json/ })).toBeVisible();
    expect([
      again.screen.getByRole("button", { name: /a\.ts/ }).query(),
      again.screen
        .getByRole("button", { name: /src\/chat/ })
        .element()
        .getAttribute("aria-expanded"),
    ]).toStrictEqual([null, "false"]);
  });

  it("opens the 改动 tab at a file from its row, which shows selected", async () => {
    const { screen, client, views } = await panel();
    answer(client);

    await screen.getByRole("button", { name: /a\.ts/ }).click();

    await expect.element(screen.getByRole("button", { name: /a\.ts/ })).toHaveAttribute("aria-current", "true");
    expect([viewOf(views.getState(), W).active, viewOf(views.getState(), W).reveal?.path]).toStrictEqual([
      "diff",
      "src/chat/a.ts",
    ]);
  });

  it("switches to the branch's commits from its menu, saying what it compares", async () => {
    const { screen, client, changeCalls } = await panel();
    answer(client);

    await screen.getByRole("button", { name: "比较" }).click();
    const committed = screen.getByRole("menuitemradio", { name: /已提交/ });
    await expect.element(committed).toHaveTextContent("已提交feat → origin/main");
    await committed.click();

    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("已提交");
    await expect.element(screen.getByText("正在检查仓库…")).toBeVisible();
    expect(changeCalls).toStrictEqual([`watchDiff ${W} uncommitted`, `watchDiff ${W} base`]);
  });

  it("goes back to the default once the tree's dirtiness changes after a choice", async () => {
    const { screen, client, changeCalls } = await panel();
    await screen.getByRole("button", { name: "比较" }).click();
    await screen.getByRole("menuitemradio", { name: /已提交/ }).click();

    client.changes(W).setState({ ...DIRTY, stat: null, dirty: false });
    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("已提交");
    client.changes(W).setState(DIRTY);

    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("未提交");
    expect(changeCalls).toStrictEqual([
      `watchDiff ${W} uncommitted`,
      `watchDiff ${W} base`,
      `watchDiff ${W} uncommitted`,
    ]);
  });

  it("says when there are no changes, offering the other mode when it has some", async () => {
    const { screen, client } = await panel({ changes: { ...DIRTY, ahead: 2 } });
    answer(client, { files: [] });

    await screen.getByRole("button", { name: "看已提交的改动" }).click();

    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("已提交");
    answer(client, { files: [] });
    await expect.element(screen.getByText("没有改动")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "看未提交的改动" })).toBeVisible();
  });

  it.each([
    ["not a repository", { error: "not_git" as const, files: [] }, "不是 git 仓库"],
    ["git failing", { error: "failed" as const, files: [] }, "读不到改动，稍后再试"],
    ["a diff too large", { tooLarge: true, files: [] }, "改动太大，无法在这里预览"],
  ])("says so for %s", async (_case, fields, text) => {
    const { screen, client } = await panel();

    answer(client, fields);

    await expect.element(screen.getByText(text)).toBeVisible();
  });

  it("asks for the same diff again to refresh, keeping the files shown", async () => {
    const { screen, client, changeCalls } = await panel();
    answer(client);

    await screen.getByRole("button", { name: "刷新" }).click();

    await expect.element(screen.getByRole("button", { name: /a\.ts/ })).toBeVisible();
    expect(changeCalls).toStrictEqual([`watchDiff ${W} uncommitted`, `watchDiff ${W} uncommitted`]);
  });
});

describe("RightPanel's 文件", () => {
  it("lists the workspace's files, directories first and numbers by size, under its directory's name", async () => {
    const { screen, client } = await panel({ changes: null });
    answer(client, { files: [] });

    const tree = screen.getByTestId("files-tree");
    await expect
      .poll(() => rowsOf(tree.element()))
      .toStrictEqual([".github", "src", "a9.md", "a10.md", "b.ts", "link"]);
    expect(screen.getByRole("button", { name: "全部收起" }).element().parentElement?.textContent).toBe("atrium");
  });

  it("reads a directory as it first expands, a spinner meanwhile, and keeps what is expanded", async () => {
    const { listDir, release } = holding("src");
    const first = await panel({ changes: null, listDir });
    const src = first.screen.getByRole("button", { name: "src" });

    await src.click();
    await expect.poll(() => src.element().querySelector(".animate-spin")).not.toBeNull();
    release();
    await first.screen.getByRole("button", { name: "chat" }).click();
    await expect.element(first.screen.getByRole("button", { name: "a.ts" })).toBeVisible();
    await first.screen.unmount();
    const again = await panel({ changes: null, storage: first.storage });

    await expect.element(again.screen.getByRole("button", { name: "a.ts" })).toBeVisible();
    expect(first.calls.filter((call) => call.startsWith("listDir"))).toStrictEqual([
      `listDir ${W} `,
      `listDir ${W} src`,
      `listDir ${W} src/chat`,
    ]);
    expect(again.calls.filter((call) => call.startsWith("listDir")).toSorted()).toStrictEqual([
      `listDir ${W} `,
      `listDir ${W} src`,
      `listDir ${W} src/chat`,
    ]);
  });

  it("restores what was expanded five levels down at most", async () => {
    const storage = memoryStorage();
    storage.setItem(`atrium.openDirs:${W}`, JSON.stringify(["a/b/c/d/e", "a/b/c/d/e/f"]));

    const { calls } = await panel({ changes: null, storage });

    await expect
      .poll(() => calls.filter((call) => call.startsWith("listDir")).toSorted())
      .toStrictEqual([`listDir ${W} `, `listDir ${W} a/b/c/d/e`]);
  });

  it("folds every directory at once", async () => {
    const { screen } = await panel({ changes: null });
    await screen.getByRole("button", { name: "src" }).click();
    await expect.element(screen.getByRole("button", { name: "chat" })).toBeVisible();

    await screen.getByRole("button", { name: "全部收起" }).click();

    await expect.element(screen.getByRole("button", { name: "chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" }).element().getAttribute("aria-expanded")).toBe("false");
  });

  it("marks changed files with a dot, green for new ones, none on directories", async () => {
    const { screen, client } = await panel();
    await screen.getByRole("tab", { name: "文件" }).click();
    answer(client);
    await screen.getByRole("button", { name: "src" }).click();
    await screen.getByRole("button", { name: "chat" }).click();

    await expect.element(screen.getByRole("button", { name: "b.ts" }).nth(0)).toBeVisible();
    const dots = [...screen.getByTestId("files-tree").element().querySelectorAll("button")].map((row) => [
      row.textContent,
      dotOf(row),
    ]);
    expect(dots).toStrictEqual([
      [".github", null],
      ["src", null],
      ["chat", null],
      ["a.ts", "var(--attn)"],
      ["b.ts", "var(--ok)"],
      ["a9.md", null],
      ["a10.md", null],
      ["b.ts", null],
      ["link", null],
    ]);
  });

  it("opens a file in the preview tab on a click, pinned on a double click, and shows it selected", async () => {
    const { screen, views } = await panel({ changes: null });

    await screen.getByRole("button", { name: "a9.md" }).click();
    await expect.element(screen.getByRole("button", { name: "a9.md" })).toHaveAttribute("aria-current", "true");
    await screen.getByRole("button", { name: "a10.md" }).dblClick();

    expect(viewOf(views.getState(), W)).toMatchObject({
      tabs: [{ kind: "file", path: "a10.md", preview: false }],
      active: "file:a10.md",
    });
  });

  it("says when a directory has more than it lists, and when the workspace cannot be read", async () => {
    const truncated = await panel({
      changes: null,
      listDir: async () => ({ entries: [{ name: "x.ts", kind: "file" }], truncated: true }),
    });
    await expect.element(truncated.screen.getByText("还有更多，没有列出")).toBeVisible();
    await truncated.screen.unmount();

    const failed = await panel({
      changes: null,
      listDir: async () => Promise.reject(new Error("no")),
    });

    await expect.element(failed.screen.getByText("读不了这个工作区的文件")).toBeVisible();
  });

  it("reads every expanded directory again on refresh, at a run's end and when the diff comes again", async () => {
    const { screen, client, calls, index } = await panel({ changes: null });
    answer(client, { files: [] });
    await screen.getByRole("button", { name: "src" }).click();
    await expect.element(screen.getByRole("button", { name: "chat" })).toBeVisible();
    const reads = () => calls.filter((call) => call.startsWith("listDir")).length;

    await screen.getByRole("button", { name: "刷新" }).click();
    await expect.poll(reads).toBe(4);
    index.setState({ sessions: [session({ sessionId: "s1", containerId: W, running: false })] });
    await expect.poll(reads).toBe(6);
    answer(client);

    await expect.poll(reads).toBe(8);
  });
});
