import type { DiffFile } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { fakeClient } from "../test/fake-client";
import { ChangesPanel } from "./changes-panel";

const W = "wks_0000000000000001";

/** A modified file with one hunk, a rename, a binary file and one too large. */
const FILES: DiffFile[] = [
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
          { kind: "add", oldNumber: null, newNumber: 4, text: "fresh();" },
        ],
      },
    ],
  },
  { path: "docs/new.md", oldPath: "docs/old.md", status: "renamed", added: 0, removed: 0, content: "text", hunks: [] },
  { path: "logo.png", oldPath: null, status: "added", added: 0, removed: 0, content: "binary", hunks: [] },
  { path: "big.json", oldPath: null, status: "deleted", added: 0, removed: 1500, content: "too_large", hunks: [] },
];

/**
 * A panel on workspace W over a fake client, its tree dirty or not.
 *
 * @remarks
 * In a frame 600 px high unless told otherwise, so the panel scrolls.
 *
 * @sideEffects Renders.
 * @param changes - What the workspace's changes say.
 * @returns The screen, the client, what it was asked and how the panel was closed.
 */
async function panel(changes: { dirty: boolean; ahead?: number } = { dirty: true }, height = 600) {
  const { client, changeCalls } = fakeClient();
  client.changes(W).setState({
    stat: { added: 1, removed: 1 },
    dirty: changes.dirty,
    ahead: changes.ahead ?? 0,
    branch: "feat",
    base: "origin/main",
  });
  const onClose = vi.fn<() => void>();
  const screen = await render(
    <div style={{ display: "flex", height }}>
      <ChangesPanel client={client} workspaceId={W} onClose={onClose} />
    </div>,
  );
  return { screen, client, changeCalls, onClose };
}

/** The host's answer for the panel's target. */
function answer(
  client: ReturnType<typeof fakeClient>["client"],
  fields: Partial<{ files: DiffFile[]; tooLarge: boolean; error: "not_git" | "failed" | null }> = {},
) {
  const { target } = client.diff.getState();
  client.diff.setState({ target, status: "ready", files: FILES, tooLarge: false, error: null, ...fields });
}

/** Whether an element's top shows within a scrolled frame. */
function topShows(element: Element, frame: Element): boolean {
  const top = element.getBoundingClientRect().top;
  const { top: frameTop, bottom } = frame.getBoundingClientRect();
  return top >= frameTop && top < bottom;
}

describe("ChangesPanel", () => {
  it("shows the uncommitted changes of a dirty tree, asking the host until it goes", async () => {
    const { screen, client, changeCalls } = await panel();

    await expect.element(screen.getByText("正在检查仓库…")).toBeVisible();
    answer(client);

    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("未提交");
    expect(
      screen
        .getByRole("list", { name: "改动的文件" })
        .getByRole("button")
        .elements()
        .map((row) => row.textContent),
    ).toStrictEqual(["src/chat/a.ts+1−1", "docs/new.md+0−0", "logo.png+0−0", "big.json+0−1.5k"]);
    expect(
      screen.getByRole("complementary", { name: "改动" }).element().querySelector("header")?.textContent,
    ).toContain("+1−1.5k");
    await screen.unmount();
    expect(changeCalls).toStrictEqual([`watchDiff ${W} uncommitted`, "watchDiff null"]);
  });

  it("shows each file's diff: numbered lines, the hunk's header, a rename, binary and large files", async () => {
    const { screen, client } = await panel();
    answer(client);

    const edited = screen.getByRole("region", { name: "src/chat/a.ts" });
    await expect.element(edited.getByRole("button", { name: /a\.ts/ })).toHaveTextContent("a.tssrc/chat/+1−1");
    await expect.element(edited.getByText("@@ -3,2 +3,2 @@")).toBeVisible();
    expect([...edited.element().querySelectorAll("[data-kind]")].map((line) => line.textContent)).toStrictEqual([
      "3keep();",
      "4old();",
      "4fresh();",
    ]);
    await expect
      .element(screen.getByRole("region", { name: "docs/new.md" }).getByRole("button"))
      .toHaveTextContent("docs/old.md → new.mddocs/+0−0");
    await expect.element(screen.getByRole("region", { name: "logo.png" }).getByText("二进制文件")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "big.json" }).getByText("改动太大，不显示")).toBeVisible();
  });

  it("folds a file from its header, and goes to a file from the list, opening it", async () => {
    const { screen, client } = await panel({ dirty: true }, 260);
    answer(client);
    const header = screen.getByRole("region", { name: "src/chat/a.ts" }).getByRole("button", { name: /a\.ts/ });
    await expect.element(screen.getByRole("region", { name: "big.json" })).toBeInTheDocument();
    const body = screen.getByTestId("changes-body").element();
    const big = screen.getByRole("region", { name: "big.json" }).element();

    await header.click();
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByText("fresh();")).not.toBeInTheDocument();
    await header.click();
    expect(topShows(big, body)).toBe(false);
    await screen
      .getByRole("list", { name: "改动的文件" })
      .getByRole("button", { name: /big\.json/ })
      .click();

    expect(topShows(big, body)).toBe(true);
  });

  it("opens a folded file it goes to from the list", async () => {
    const { screen, client } = await panel();
    answer(client);
    const header = screen.getByRole("region", { name: "src/chat/a.ts" }).getByRole("button", { name: /a\.ts/ });
    await header.click();

    await screen.getByRole("list", { name: "改动的文件" }).getByRole("button", { name: /a\.ts/ }).click();

    await expect.element(header).toHaveAttribute("aria-expanded", "true");
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
    const { screen, client, changeCalls } = await panel({ dirty: true });
    await screen.getByRole("button", { name: "比较" }).click();
    await screen.getByRole("menuitemradio", { name: /已提交/ }).click();

    client.changes(W).setState({ stat: null, dirty: false, ahead: 0, branch: "feat", base: "origin/main" });
    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("已提交");
    client.changes(W).setState({ stat: null, dirty: true, ahead: 0, branch: "feat", base: "origin/main" });

    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("未提交");
    expect(changeCalls).toStrictEqual([
      `watchDiff ${W} uncommitted`,
      `watchDiff ${W} base`,
      `watchDiff ${W} uncommitted`,
    ]);
  });

  it("says when there are no changes, offering the other mode when it has some", async () => {
    const committed = await panel({ dirty: false, ahead: 2 });
    answer(committed.client, { files: [] });
    await committed.screen.getByRole("button", { name: "比较" }).click();
    await committed.screen.getByRole("menuitemradio", { name: /未提交/ }).click();
    answer(committed.client, { files: [] });

    await expect.element(committed.screen.getByText("没有改动")).toBeVisible();
    await committed.screen.getByRole("button", { name: "看已提交的改动" }).click();
    await expect.element(committed.screen.getByRole("button", { name: "比较" })).toHaveTextContent("已提交");
    answer(committed.client, { files: [] });
    await expect.element(committed.screen.getByRole("button", { name: /看.*的改动/ })).not.toBeInTheDocument();
  });

  it("offers the uncommitted changes when the commits have none but the tree is dirty", async () => {
    const { screen, client } = await panel({ dirty: true });
    await screen.getByRole("button", { name: "比较" }).click();
    await screen.getByRole("menuitemradio", { name: /已提交/ }).click();
    answer(client, { files: [] });

    await screen.getByRole("button", { name: "看未提交的改动" }).click();

    await expect.element(screen.getByRole("button", { name: "比较" })).toHaveTextContent("未提交");
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

  it("closes only the menu on Esc while the menu is open", async () => {
    const { screen, client, onClose } = await panel();
    answer(client);

    await screen.getByRole("button", { name: "比较" }).click();
    await expect.element(screen.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks for the same target again to refresh, keeping the files shown, and closes on Esc inside it", async () => {
    const { screen, client, changeCalls, onClose } = await panel();
    answer(client);

    await screen.getByRole("button", { name: "刷新" }).click();
    await expect.element(screen.getByRole("list", { name: "改动的文件" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    expect(changeCalls).toStrictEqual([`watchDiff ${W} uncommitted`, `watchDiff ${W} uncommitted`]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
