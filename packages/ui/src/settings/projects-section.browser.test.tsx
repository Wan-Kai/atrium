import { CommandError } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { PROJECT, fakeClient } from "../test/fake-client";
import { SettingsPanel } from "./settings-panel";

/**
 * Renders the settings on the projects part, over a fake client.
 *
 * @remarks
 * Through the panel, as the user reaches it.
 *
 * @sideEffects Renders.
 * @param initial - The list.
 * @param answers - How some commands answer.
 * @returns The screen and the fake.
 */
async function projects(
  initial: Parameters<typeof fakeClient>[0] = { projects: [PROJECT] },
  answers: Parameters<typeof fakeClient>[1] = {},
) {
  // The size of the app's window, which the settings sit in.
  await page.viewport(1280, 820);
  const fake = fakeClient(initial, answers);
  const screen = await render(
    <SettingsPanel
      client={fake.client}
      section="projects"
      onSection={() => undefined}
      onClose={() => undefined}
      openUrl={() => undefined}
      reveal={undefined}
    />,
  );
  return { screen, ...fake };
}

describe("Settings · projects", () => {
  it("chooses a project's main branch from origin's, marking origin/HEAD, and goes back to automatic", async () => {
    const { screen, calls } = await projects(
      { projects: [PROJECT] },
      { branches: async () => ({ branches: ["develop", "main"], head: "main" }) },
    );
    const menu = screen.getByRole("button", { name: "atrium 的主干分支" });

    await expect.element(menu).toHaveTextContent("自动origin/HEAD：main");
    await expect.element(screen.getByText("/work/atrium")).toBeVisible();
    await menu.click();
    const items = screen.getByRole("menuitemradio");
    await expect.element(items.nth(0)).toHaveTextContent("自动跟随 origin/HEAD，现在是 main");
    await expect.element(items.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect.element(items.nth(1)).toHaveTextContent("develop");
    await expect.element(items.nth(2)).toHaveTextContent("mainorigin/HEAD");
    expect(items.elements()).toHaveLength(3);
    await items.nth(1).click();

    await expect.element(menu).toHaveTextContent("develop");
    await screen.getByRole("button", { name: "恢复自动" }).click();
    await expect.element(menu).toHaveTextContent("自动origin/HEAD：main");
    expect(calls).toStrictEqual([
      `listBranches ${PROJECT.id}`,
      `setMainBranch ${PROJECT.id} develop`,
      `setMainBranch ${PROJECT.id} null`,
    ]);
  });

  it("sends nothing when the branch chosen is the one set", async () => {
    const { screen, calls } = await projects({ projects: [{ ...PROJECT, mainBranch: "main" }] });
    const menu = screen.getByRole("button", { name: "atrium 的主干分支" });

    await menu.click();
    await screen.getByRole("menuitemradio", { name: /^main/ }).click();
    await menu.click();
    await expect.element(screen.getByRole("menuitemradio", { name: /^main/ })).toHaveAttribute("aria-checked", "true");

    expect(calls).toStrictEqual([`listBranches ${PROJECT.id}`]);
  });

  it("sends nothing when automatic is chosen again", async () => {
    const { screen, calls } = await projects();

    await screen.getByRole("button", { name: "atrium 的主干分支" }).click();
    await screen.getByRole("menuitemradio", { name: /^自动/ }).click();

    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    expect(calls).toStrictEqual([`listBranches ${PROJECT.id}`]);
  });

  it("warns that merge states are unknown while there is no main branch", async () => {
    const { screen } = await projects(
      { projects: [PROJECT] },
      { branches: async () => ({ branches: [], head: null }) },
    );

    await expect.element(screen.getByText("找不到主干，worktree 的合并状态显示为未知")).toBeVisible();
    const menu = screen.getByRole("button", { name: "atrium 的主干分支" });
    await expect.element(menu).toHaveTextContent("自动没有 origin/HEAD");
    await menu.click();
    await expect.element(screen.getByText("origin 上没有分支")).toBeVisible();
    await expect.element(screen.getByText("这个仓库没有 origin/HEAD")).toBeVisible();
  });

  it("says why a branch could not be chosen", async () => {
    const { screen } = await projects(
      { projects: [PROJECT] },
      {
        branches: async () => ({ branches: ["develop"], head: null }),
        setMainBranch: () => Promise.reject(new CommandError("branch_not_found")),
      },
    );

    await screen.getByRole("button", { name: "atrium 的主干分支" }).click();
    await screen.getByRole("menuitemradio", { name: "develop" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("origin 上没有 develop 这个分支了");
    await expect.element(screen.getByText("找不到主干，worktree 的合并状态显示为未知")).toBeVisible();
  });

  it("says when origin's branches cannot be read", async () => {
    const { screen } = await projects({ projects: [PROJECT] }, { branches: () => Promise.reject(new Error("git")) });
    const menu = screen.getByRole("button", { name: "atrium 的主干分支" });

    await expect.element(menu).toHaveTextContent("自动读不到分支");
    await menu.click();
    await expect.element(screen.getByText("读不到 origin 上的分支")).toBeVisible();
    await expect.element(screen.getByText("找不到主干，worktree 的合并状态显示为未知")).not.toBeInTheDocument();
  });

  it("points to the sidebar while there are no projects", async () => {
    const { screen, calls } = await projects({ projects: [] });

    await expect.element(screen.getByText("还没有项目，在侧栏里添加。")).toBeVisible();
    expect(calls).toStrictEqual([]);
  });
});
