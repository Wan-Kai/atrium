import { CommandError } from "@atrium/client";
import type { CommandResult } from "@atrium/protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { PROJECT, chat, fakeClient, session, workspace } from "../test/fake-client";
import { Workbench } from "./workbench";

const LOCAL = "wks_000000000000000a";
const FEATURE = "wks_000000000000000b";
const CHAT = "cht_a";

/**
 * A list with one project, its local workspace and a worktree, a chat, and a session in the
 * inbox, the client in the local workspace.
 */
function list() {
  return {
    projects: [PROJECT],
    workspaces: [
      workspace({ id: FEATURE, branch: "feat/sidebar", createdAt: 5 }),
      workspace({
        id: LOCAL,
        kind: "local",
        branch: "main",
        dir: "/work/atrium",
        createdAt: null,
        external: false,
        merge: null,
      }),
    ],
    sessions: [
      session({ sessionId: "s1", containerId: LOCAL, prompt: "重构宿主" }),
      session({
        sessionId: "s3",
        containerId: FEATURE,
        name: "实现侧栏",
        attention: { reason: "auth", at: 1, cleared: false },
      }),
      session({ sessionId: "c1", containerId: CHAT, prompt: "解释 merge-tree" }),
    ],
    chats: [chat({ id: CHAT, firstSessionId: "c1" })],
    layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1"], active: "s1" } } },
  };
}

/**
 * Renders the workbench over a fake client and opens the project's new-workspace page.
 *
 * @remarks
 * Random words are the first of each list, so a random branch is `atrium/brave-badger`.
 *
 * @sideEffects Renders; makes `Math.random` answer 0 until the test ends; hovers and clicks.
 * @param answers - How some commands answer.
 * @returns The screen and the fake.
 */
async function newWorkspacePage(answers: Parameters<typeof fakeClient>[1] = {}) {
  await page.viewport(1280, 820);
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  onTestFinished(() => {
    random.mockRestore();
    localStorage.clear();
  });
  const fake = fakeClient(list(), answers);
  const screen = await render(
    <Workbench
      client={fake.client}
      status={<span>已连接宿主</span>}
      pickDirectory={async () => null}
      setNativeAppearance={undefined}
      openUrl={() => undefined}
      reveal={undefined}
      pathForFile={undefined}
    />,
  );
  await openFrom(screen);
  return { screen, ...fake };
}

/** The screen `newWorkspacePage` renders. */
type Screen = Awaited<ReturnType<typeof render>>;

/**
 * Opens the project's new-workspace page from its row's "+".
 *
 * @sideEffects Hovers and clicks in the page.
 * @param screen - The rendered workbench.
 */
async function openFrom(screen: Screen): Promise<void> {
  const project = screen.getByTestId("project-row");
  await project.hover();
  await project.getByRole("button", { name: "在 atrium 新建工作区" }).click();
  await expect.element(screen.getByText("新建工作区", { exact: true })).toBeVisible();
}

/**
 * Whether the page has gone.
 *
 * @sideEffects none
 * @param screen - The rendered workbench.
 */
async function left(screen: Screen): Promise<void> {
  await expect.element(screen.getByText("新建工作区", { exact: true })).not.toBeInTheDocument();
}

/**
 * The timeline's steps: each one's node and words.
 *
 * @sideEffects none
 * @param screen - The rendered workbench.
 * @returns `[node, words]` per step.
 */
function steps(screen: Screen): unknown[][] {
  return screen
    .getByTestId("launch-step")
    .elements()
    .map((step) => [step.getAttribute("data-state"), step.textContent]);
}

/**
 * One of the choices above the box.
 *
 * @sideEffects none
 * @param screen - The rendered workbench.
 * @param name - Its name.
 * @returns The button.
 */
function choice(screen: Screen, name: "项目" | "工作区" | "起点" | "分支名") {
  return screen.getByRole("button", { name, exact: true });
}

/**
 * The first icon in a menu's item.
 *
 * @sideEffects none
 * @param item - The item.
 * @returns Its icon.
 * @throws When it has none.
 */
function firstIcon(item: Element): Element {
  const icon = item.querySelector("svg");
  if (icon === null) throw new Error("no icon");
  return icon;
}

/**
 * The workspaces, the worktree with changes not committed and two commits ahead.
 *
 * @sideEffects none
 * @param workspaces - The workspaces.
 * @returns Them, the worktree changed.
 */
function changedFeature<T extends { readonly id: string }>(workspaces: readonly T[]): T[] {
  return workspaces.map((one) =>
    one.id === FEATURE ? { ...one, merge: { dirty: true, ahead: 2, verdict: "pending", reason: null } } : one,
  );
}

/**
 * What describes an element.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns The element its `aria-describedby` names.
 * @throws When there is none.
 */
function describedBy(element: Element): Element {
  const hint = document.getElementById(element.getAttribute("aria-describedby") ?? "");
  if (hint === null) throw new Error("not described");
  return hint;
}

/**
 * An element's last child.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Its last child.
 * @throws When it has none.
 */
function lastChild(element: Element): Element {
  const last = element.lastElementChild;
  if (last === null) throw new Error("no child");
  return last;
}

/**
 * Sends a message from the box.
 *
 * @sideEffects Types into the page.
 * @param screen - The rendered workbench.
 * @param text - The message.
 */
async function send(screen: Screen, text: string): Promise<void> {
  await userEvent.type(screen.getByRole("textbox", { name: "消息" }), `${text}{Enter}`);
}

/**
 * Answers sending as pi busy the first time, and as started after.
 *
 * @sideEffects none
 * @returns The answer.
 */
function busyOnce() {
  let tries = 0;
  return async () => {
    tries += 1;
    if (tries === 1) throw new CommandError("session_busy");
    return { disposition: "started" as const };
  };
}

/**
 * The sessions with an error in s1 not seen yet.
 *
 * @sideEffects none
 * @param sessions - The sessions.
 * @returns The sessions changed.
 */
function failedS1<T extends { readonly sessionId: string }>(sessions: readonly T[]): T[] {
  return sessions.map((one) =>
    one.sessionId === "s1" ? { ...one, attention: { reason: "error" as const, at: 2, cleared: false } } : one,
  );
}

describe("The new-workspace page (M1.11)", () => {
  it("opens from a project's +, selecting the project's row in place of the tabs, and leaves for a workspace", async () => {
    const { screen, calls } = await newWorkspacePage();

    await expect.element(screen.getByText("新建工作区", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("发出第一条消息时，才建 worktree")).toBeVisible();
    await expect.element(screen.getByTestId("project-row")).toHaveAttribute("aria-current", "true");
    await expect.element(screen.getByTestId("workspace-row").nth(0)).toHaveAttribute("aria-current", "false");
    await expect.element(screen.getByRole("tablist")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveFocus();

    await screen.getByTestId("workspace-row").nth(0).click();

    await expect.element(screen.getByRole("tablist")).toBeVisible();
    await expect.element(screen.getByText("新建工作区", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("project-row")).toHaveAttribute("aria-current", "false");
    await expect.element(screen.getByTestId("workspace-row").nth(0)).toHaveAttribute("aria-current", "true");
    expect(calls).toContain(`selectContainer ${LOCAL}`);
    expect(calls.filter((call) => call.startsWith("listBases"))).toStrictEqual([`listBases ${PROJECT.id}`]);
  });

  it("chooses a new worktree from the main branch on a branch named for it, or another base, or a workspace there", async () => {
    const { screen, calls } = await newWorkspacePage({
      bases: async () => ({ main: "origin/main", current: "main", local: ["dev", "main"], remote: ["origin/main"] }),
    });

    await expect.element(choice(screen, "项目")).toHaveTextContent("atrium");
    await expect.element(choice(screen, "工作区")).toHaveTextContent("新建 worktree");
    await expect.element(choice(screen, "起点")).toHaveTextContent("基于 origin/main");
    await expect.element(choice(screen, "分支名")).toHaveTextContent("自动起名");
    expect(calls).toContain(`listBases ${PROJECT.id}`);

    await choice(screen, "起点").click();
    await expect.element(screen.getByRole("group", { name: "本地分支" })).toHaveTextContent("本地分支devmain当前");
    await expect
      .element(screen.getByRole("group", { name: "远程分支" }))
      .toHaveTextContent("远程分支origin/main主分支");
    await screen.getByRole("menuitemradio", { name: "dev", exact: true }).click();
    await expect.element(choice(screen, "起点")).toHaveTextContent("基于 dev");

    await choice(screen, "工作区").click();
    expect(
      screen
        .getByRole("menuitemradio")
        .elements()
        .map((item) => item.textContent),
    ).toStrictEqual(["新建 worktree", "main1 会话", "feat/sidebar1 会话"]);
    await screen.getByRole("menuitemradio", { name: /^feat\/sidebar/ }).click();

    await expect.element(choice(screen, "工作区")).toHaveTextContent("feat/sidebar");
    await expect.element(choice(screen, "起点")).not.toBeInTheDocument();
    await expect.element(choice(screen, "分支名")).not.toBeInTheDocument();
    await expect.element(screen.getByText("发出第一条消息时，在这个工作区里新建会话")).toBeVisible();

    await choice(screen, "工作区").click();
    await screen.getByRole("menuitemradio", { name: "新建 worktree" }).click();
    await expect.element(choice(screen, "起点")).toHaveTextContent("基于 origin/main");
    await expect.element(choice(screen, "分支名")).toHaveTextContent("自动起名");
  });

  it("lists each choice on one line, its icon on the left, what is worth knowing on the right, the one chosen ticked", async () => {
    const { screen, index } = await newWorkspacePage();
    index.setState({ workspaces: changedFeature(index.getState().workspaces) });

    await choice(screen, "项目").click();
    const project = screen.getByRole("menuitemradio", { name: /^atrium/ });
    await expect.element(project).toHaveTextContent("atrium/work");
    await expect.element(project).toHaveAttribute("aria-checked", "true");
    await expect.element(project).toHaveAttribute("title", "/work/atrium");
    await userEvent.keyboard("{Escape}");

    await choice(screen, "工作区").click();
    const items = screen.getByRole("menuitemradio");
    await expect.element(items.nth(2)).toHaveTextContent("feat/sidebar21 会话");
    expect(items.elements().map((item) => item.getAttribute("aria-checked"))).toStrictEqual(["true", "false", "false"]);
    expect(items.elements().map((item) => getComputedStyle(firstIcon(item)).color)).toStrictEqual([
      "rgb(47, 111, 237)",
      "rgb(110, 110, 116)",
      "rgb(47, 111, 237)",
    ]);
    await expect.element(items.nth(2).getByTitle("有未提交的改动")).toBeVisible();
    await expect.element(items.nth(1).getByTitle("有未提交的改动")).not.toBeInTheDocument();
    const row = getComputedStyle(items.nth(1).element());
    expect([row.height, row.fontSize, row.color]).toStrictEqual(["32px", "13px", "rgb(44, 44, 48)"]);
    const tick = lastChild(items.nth(0).element());
    expect(getComputedStyle(tick).color).toBe("rgb(47, 111, 237)");
    expect(firstIcon(tick).getAttribute("width")).toBe("14");
    expect(lastChild(items.nth(1).element()).childElementCount).toBe(0);
  });

  it("filters the bases as typed into the line atop their menu, marking the main and the current branch", async () => {
    const { screen } = await newWorkspacePage({
      bases: async () => ({
        main: "origin/main",
        current: "dev",
        local: ["dev", "main"],
        remote: ["origin/dev", "origin/main"],
      }),
    });

    await choice(screen, "起点").click();
    const filter = screen.getByRole("textbox", { name: "过滤分支" });
    await expect.element(filter).toHaveFocus();
    expect(
      screen
        .getByRole("menuitemradio")
        .elements()
        .map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    ).toStrictEqual([
      ["dev当前", "false"],
      ["main", "false"],
      ["origin/dev", "false"],
      ["origin/main主分支", "true"],
    ]);

    await userEvent.type(filter, "MA");
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("menuitemradio")
          .elements()
          .map((item) => item.textContent),
      ).toStrictEqual(["main", "origin/main主分支"]),
    );
    await userEvent.type(filter, "zz");
    await expect.element(screen.getByText("没有匹配的分支")).toBeVisible();
    await expect.element(screen.getByRole("menuitemradio")).not.toBeInTheDocument();
  });

  it("sends the full ref of the base chosen, local or remote, though it says its short name", async () => {
    // The worktree is still being made, so its step stays to be read.
    const made = Promise.withResolvers<void>();
    const { screen, calls } = await newWorkspacePage({
      bases: async () => ({ main: null, current: "main", local: ["main", "v1"], remote: ["origin/v1"] }),
      createWorkspace: () => made.promise,
    });
    await expect.element(choice(screen, "起点")).toHaveTextContent("基于 main");
    await choice(screen, "起点").click();
    await screen.getByRole("group", { name: "远程分支" }).getByRole("menuitemradio", { name: "origin/v1" }).click();
    await expect.element(choice(screen, "起点")).toHaveTextContent("基于 origin/v1");
    await send(screen, "一");
    await vi.waitFor(() =>
      expect(calls).toContain(`createWorkspace ${PROJECT.id} atrium/fix-login refs/remotes/origin/v1`),
    );
    await vi.waitFor(() => expect(steps(screen)[1]).toStrictEqual(["live", "创建 worktree基于 origin/v1"]));
  });

  it("holds the send back until the bases come, rather than start from HEAD", async () => {
    const bases = Promise.withResolvers<CommandResult<"list_bases">>();
    const { screen, calls } = await newWorkspacePage({ bases: () => bases.promise });
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "修复登录{Enter}");
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    bases.resolve({ main: "origin/main", current: "main", local: ["main"], remote: ["origin/main"] });
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    const before = calls.filter((call) => call.startsWith("createWorkspace"));
    await userEvent.type(box, "{Enter}");

    await vi.waitFor(() =>
      expect(calls).toContain(`createWorkspace ${PROJECT.id} atrium/fix-login refs/remotes/origin/main`),
    );
    expect(before).toStrictEqual([]);
  });

  it("says the model names the branch, with a sparkle, until one is written", async () => {
    const { screen } = await newWorkspacePage();

    const button = choice(screen, "分支名");
    await expect.element(button).toHaveAttribute("title", "发出后，AI 按第一条消息起分支名；点这里自己写");
    expect(getComputedStyle(firstIcon(button.element())).color).toBe("rgb(47, 111, 237)");
    await button.click();
    const field = screen.getByRole("textbox", { name: "分支名" });
    await expect.element(field).toHaveValue("");
    await expect.element(field).toHaveAttribute("placeholder", "输入分支名，留空让 AI 起名");
    expect(getComputedStyle(field.element(), "::placeholder").color).toBe("rgb(161, 161, 167)");
    await userEvent.fill(field, "fix/login");
    await userEvent.keyboard("{Enter}");

    await expect.element(button).toHaveAttribute("title", "分支名");
    expect(getComputedStyle(firstIcon(button.element())).color).toBe("rgb(110, 110, 116)");
  });

  it("edits the branch in place, keeping it on Enter and not on Escape, and names it again once cleared", async () => {
    const { screen } = await newWorkspacePage();

    const before = choice(screen, "分支名").element().getBoundingClientRect();
    await choice(screen, "分支名").click();
    const field = screen.getByRole("textbox", { name: "分支名" });
    await expect.element(field).toHaveAccessibleDescription("⏎ 保存 esc 取消 清空恢复自动起名");
    const box = field.element().getBoundingClientRect();
    // Its text where the button's was, the hint above it, clear of the input box below.
    expect(box.left + 6 - before.left).toBe(28);
    expect(box.top - describedBy(field.element()).getBoundingClientRect().bottom).toBe(4);
    await userEvent.fill(screen.getByRole("textbox", { name: "分支名" }), "fix/login");
    await userEvent.keyboard("{Enter}");
    await expect.element(choice(screen, "分支名")).toHaveTextContent("fix/login");

    await choice(screen, "分支名").click();
    await userEvent.fill(screen.getByRole("textbox", { name: "分支名" }), "other");
    await userEvent.keyboard("{Escape}");
    await expect.element(choice(screen, "分支名")).toHaveTextContent("fix/login");

    await choice(screen, "分支名").click();
    await expect.element(screen.getByRole("textbox", { name: "分支名" })).toHaveValue("fix/login");
    await userEvent.clear(screen.getByRole("textbox", { name: "分支名" }));
    await userEvent.keyboard("{Enter}");
    await expect.element(choice(screen, "分支名")).toHaveTextContent("自动起名");
  });

  it("goes without naming a branch written, saying the branch on its worktree's step", async () => {
    const made = Promise.withResolvers<void>();
    const { screen, calls } = await newWorkspacePage({ createWorkspace: () => made.promise });
    await choice(screen, "分支名").click();
    await userEvent.fill(screen.getByRole("textbox", { name: "分支名" }), "fix/login");
    await userEvent.keyboard("{Enter}");

    await send(screen, "修复登录");

    await vi.waitFor(() =>
      expect(steps(screen)).toStrictEqual([
        ["live", "创建 worktreefix/login · 基于 origin/main"],
        ["wait", "启动会话"],
        ["wait", "发出消息"],
      ]),
    );
    expect(calls.filter((call) => call.startsWith("nameBranch"))).toStrictEqual([]);
    made.resolve();
  });

  it("names the branch randomly when the model could not, and says so", async () => {
    const made = Promise.withResolvers<void>();
    const { screen } = await newWorkspacePage({
      nameBranch: () => Promise.reject(new CommandError("branch_name_failed", { reason: "failed" })),
      createWorkspace: () => made.promise,
    });

    await send(screen, "修复登录");

    await vi.waitFor(() =>
      expect(steps(screen).slice(0, 2)).toStrictEqual([
        ["dot", "起名没起成，用随机名 atrium/brave-badger"],
        ["live", "创建 worktreeatrium/brave-badger · 基于 origin/main"],
      ]),
    );
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    made.resolve();
  });

  it("names the branch, creates the worktree and the session, then sends, step by step, holding the box back till the message goes", async () => {
    const named = Promise.withResolvers<string>();
    const made = Promise.withResolvers<void>();
    const sent = Promise.withResolvers<void>();
    const { screen, calls } = await newWorkspacePage({
      nameBranch: () => named.promise,
      createWorkspace: () => made.promise,
      prompt: async () => {
        await sent.promise;
        return { disposition: "started" };
      },
    });

    await send(screen, "修复登录");

    await vi.waitFor(() =>
      expect(steps(screen)).toStrictEqual([
        ["live", "起名按第一条消息"],
        ["wait", "创建 worktree"],
        ["wait", "启动会话"],
        ["wait", "发出消息"],
      ]),
    );
    expect(calls).toContain(`nameBranch ${PROJECT.id} 修复登录 null`);
    named.resolve("atrium/fix-login");
    await vi.waitFor(() =>
      expect(steps(screen)).toStrictEqual([
        ["dot", "起名atrium/fix-login"],
        ["live", "创建 worktree基于 origin/main"],
        ["wait", "启动会话"],
        ["wait", "发出消息"],
      ]),
    );
    await expect.element(screen.getByTestId("launch-message").getByTestId("user-text")).toHaveTextContent("修复登录");
    await expect.element(screen.getByText("新建工作区", { exact: true })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "下一条{Enter}");
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await expect.element(choice(screen, "工作区")).toBeDisabled();
    expect(calls).toContain(`createWorkspace ${PROJECT.id} atrium/fix-login refs/remotes/origin/main`);

    made.resolve();

    await expect.element(screen.getByRole("tablist")).toBeVisible();
    await vi.waitFor(() =>
      expect(steps(screen)).toStrictEqual([
        ["dot", "起名atrium/fix-login"],
        ["dot", "创建 worktree基于 origin/main"],
        ["dot", "启动会话"],
        ["live", "发出消息"],
      ]),
    );
    await expect.element(screen.getByTestId("launch-message")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("user-message")).toHaveTextContent("修复登录");
    await expect
      .element(screen.getByTestId("workspace-row").filter({ hasText: "atrium/fix-login" }))
      .toHaveAttribute("aria-current", "true");
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveValue("下一条");
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    sent.resolve();

    await expect.element(screen.getByTestId("launch-step").first()).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(
      calls.filter((call) => /^(nameBranch|createWorkspace|createSession|listCommands|prompt) /.test(call)),
    ).toStrictEqual([
      `nameBranch ${PROJECT.id} 修复登录 null`,
      `createWorkspace ${PROJECT.id} atrium/fix-login refs/remotes/origin/main`,
      "createSession wks_made1",
      "listCommands new2",
      "prompt new2 修复登录",
    ]);
  });

  it("stops at a worktree that could not be created, saying why, with the message back in the box and the name on the page", async () => {
    const { screen, calls } = await newWorkspacePage({
      createWorkspace: () =>
        Promise.reject(new CommandError("worktree_create_failed", { reason: "branch_exists", branch: "x" })),
    });

    await send(screen, "修复登录");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("这个分支名已经有了，换一个");
    expect(steps(screen)).toStrictEqual([
      ["dot", "起名atrium/fix-login"],
      ["fail", "创建 worktree基于 origin/main这个分支名已经有了，换一个"],
      ["wait", "启动会话"],
      ["wait", "发出消息"],
    ]);
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveValue("修复登录");
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await expect.element(screen.getByTestId("launch-message")).not.toBeInTheDocument();
    await expect.element(choice(screen, "分支名")).toBeEnabled();
    await expect.element(choice(screen, "分支名")).toHaveTextContent("atrium/fix-login");
    expect(calls.filter((call) => call.startsWith("createSession"))).toStrictEqual([]);
  });

  it("goes on after the user leaves the page, opening the session where they are not", async () => {
    const made = Promise.withResolvers<void>();
    const { screen, calls } = await newWorkspacePage({ createWorkspace: () => made.promise });

    await send(screen, "修复登录");
    await screen.getByTestId("workspace-row").filter({ hasText: "feat/sidebar" }).click();
    made.resolve();

    await vi.waitFor(() => expect(calls).toContain("prompt new2 修复登录"));
    expect(calls).toContain("createSession wks_made1 stay");
    await expect
      .element(screen.getByTestId("workspace-row").filter({ hasText: "feat/sidebar" }))
      .toHaveAttribute("aria-current", "true");
    await expect
      .element(screen.getByTestId("workspace-row").filter({ hasText: "atrium/fix-login" }))
      .toHaveAttribute("aria-current", "false");
  });

  it("shows a failed send over the new session until the next send there", async () => {
    const { screen, calls } = await newWorkspacePage({ prompt: busyOnce() });

    await send(screen, "修复登录");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("pi 正在忙，等这一轮结束再发");
    expect(steps(screen).map(([node]) => node)).toStrictEqual(["dot", "dot", "dot", "fail"]);
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveValue("修复登录");

    await screen.getByRole("button", { name: "发送" }).click();

    await expect.element(screen.getByTestId("launch-step").first()).not.toBeInTheDocument();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.startsWith("prompt"))).toStrictEqual([
        "prompt new2 修复登录",
        "prompt new2 修复登录",
      ]),
    );
  });

  it("goes into the local workspace of a project that is not a repository, with no new worktree to choose", async () => {
    const { screen, calls } = await newWorkspacePage({
      bases: () => Promise.reject(new CommandError("worktree_create_failed", { reason: "not_git" })),
    });

    await expect.element(choice(screen, "工作区")).toHaveTextContent("main");
    await choice(screen, "工作区").click();
    const worktree = screen.getByRole("menuitemradio", { name: "新建 worktree" });
    await expect.element(worktree).toBeDisabled();
    await expect.element(worktree).toHaveAttribute("title", "这个项目不是 git 仓库");
    await userEvent.keyboard("{Escape}");

    await send(screen, "看看");

    await vi.waitFor(() => expect(calls).toContain("prompt new1 看看"));
    expect(calls).toContain(`createSession ${LOCAL}`);
    expect(calls.filter((call) => call.startsWith("createWorkspace"))).toStrictEqual([]);
  });

  it("leaves for ⌘T and ⌘N, and lets the keys for tabs alone", async () => {
    const { screen, calls } = await newWorkspacePage();
    const before = calls.length;

    await userEvent.keyboard("{Meta>}w{/Meta}{Meta>}1{/Meta}");
    await expect.element(screen.getByText("新建工作区", { exact: true })).toBeVisible();
    expect(calls.slice(before).filter((call) => /^(closeTab|openSession)/.test(call))).toStrictEqual([]);

    await userEvent.keyboard("{Meta>}t{/Meta}");
    await expect.element(screen.getByRole("tablist")).toBeVisible();
    await vi.waitFor(() => expect(calls).toContain(`createSession ${LOCAL}`));

    await openFrom(screen);
    await userEvent.keyboard("{Meta>}n{/Meta}");
    await left(screen);
    await vi.waitFor(() => expect(calls.filter((call) => call === "createChat")).toHaveLength(1));

    await openFrom(screen);
    await screen.getByRole("button", { name: "新建对话" }).click();
    await left(screen);
    await vi.waitFor(() => expect(calls.filter((call) => call === "createChat")).toHaveLength(2));
  });

  it("leaves for a chat, a session in the inbox, and a workspace, chat or session found", async () => {
    const { screen, calls } = await newWorkspacePage();

    await screen.getByTestId("chat-row").click();
    await left(screen);
    await vi.waitFor(() => expect(calls).toContain("openSession c1"));

    await openFrom(screen);
    (screen.getByTestId("chat-row").element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await left(screen);

    await openFrom(screen);
    (screen.getByTestId("workspace-row").filter({ hasText: "feat/sidebar" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await left(screen);
    await vi.waitFor(() => expect(calls).toContain(`selectContainer ${FEATURE}`));

    await openFrom(screen);
    onTestFinished(() => localStorage.removeItem("atrium.inboxOpen"));
    await screen.getByRole("button", { name: /^等你处理/ }).click();
    await screen.getByTestId("inbox-row").click();
    await left(screen);
    await vi.waitFor(() => expect(calls).toContain("openSession s3"));

    const searching = screen.getByRole("textbox", { name: "搜索工作区、对话和会话" });
    for (const [query, words] of [
      ["feat", "feat/sidebar"],
      ["解释", "解释 merge-tree"],
      ["重构", "重构宿主"],
    ] as const) {
      await openFrom(screen);
      // Projects give way to the results while searching.
      await userEvent.fill(searching, query);
      await screen.getByRole("region", { name: "搜索结果" }).getByText(words).first().click();
      await left(screen);
      await userEvent.fill(searching, "");
    }
  });

  it("closes when its project goes", async () => {
    const { screen, index } = await newWorkspacePage();

    index.setState({ projects: [] });

    await expect.element(screen.getByText("新建工作区", { exact: true })).not.toBeInTheDocument();
  });

  it("marks no error seen in the session behind it, until the user goes back there", async () => {
    const { screen, calls, index } = await newWorkspacePage();

    index.setState({ sessions: failedS1(index.getState().sessions) });
    onTestFinished(() => localStorage.removeItem("atrium.inboxOpen"));
    await screen.getByRole("button", { name: /^等你处理/ }).click();
    await expect.element(screen.getByTestId("inbox-row").filter({ hasText: "重构宿主" })).toBeVisible();
    expect(calls).not.toContain("clearAttention s1");

    await screen.getByTestId("workspace-row").filter({ hasText: "main" }).click();

    await vi.waitFor(() => expect(calls).toContain("clearAttention s1"));
  });

  it("sets the model chosen on the page on the session, before the message", async () => {
    const opus = {
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      supportsImage: true,
      thinkingLevels: ["off", "low", "high"],
      fast: null,
    } as const;
    const { screen, calls, modelCalls } = await newWorkspacePage({
      models: {
        status: "ready",
        models: [{ ...opus, thinkingLevels: [...opus.thinkingLevels] }],
        defaultModel: null,
        error: null,
      },
    });

    await screen.getByRole("button", { name: /模型与推理强度/ }).click();
    await screen.getByRole("menuitemradio", { name: /Opus/ }).click();
    await expect.element(screen.getByRole("button", { name: /模型与推理强度/ })).toHaveTextContent("Claude Opus 5.5");
    await send(screen, "修复登录");

    await vi.waitFor(() => expect(calls).toContain("prompt new2 修复登录"));
    expect(modelCalls).toContain("setModel new2 anthropic/claude-opus-5-5");
    expect(calls).toContain(`nameBranch ${PROJECT.id} 修复登录 anthropic/claude-opus-5-5`);
    expect(calls.filter((call) => call.startsWith("listCommands"))).toStrictEqual([]);
  });
});
