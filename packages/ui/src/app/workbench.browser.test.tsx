import { CommandError } from "@atrium/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { DisplayModeContext, createDisplayMode, followPreferences } from "../state/display-mode";
import { PROJECT, fakeClient, session, workspace } from "../test/fake-client";
import { Workbench } from "./workbench";

const LOCAL = "wks_000000000000000a";
const FEATURE = "wks_000000000000000b";
const MERGED = "wks_000000000000000c";

/** A list with one project, three workspaces and some sessions, the client in the local workspace. */
function list() {
  return {
    projects: [PROJECT],
    workspaces: [
      workspace({
        id: MERGED,
        branch: "fix/typo",
        createdAt: 9,
        merge: { dirty: false, ahead: 0, verdict: "merged", reason: null },
      }),
      workspace({
        id: FEATURE,
        branch: "feat/sidebar",
        createdAt: 5,
        merge: { dirty: true, ahead: 3, verdict: "pending", reason: null },
      }),
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
      session({ sessionId: "s2", containerId: LOCAL, prompt: "调研 pi RPC", running: true }),
      session({ sessionId: "s3", containerId: FEATURE, name: "实现 sidebar" }),
      session({ sessionId: "c1", containerId: "chats", prompt: "解释 merge-tree" }),
    ],
    layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1", "s2"], active: "s1" } } },
  };
}

/**
 * Renders the workbench over a fake client.
 *
 * @remarks
 * The display mode follows the fake's preferences, as in the app.
 *
 * @sideEffects Renders; installs the display mode subscription until the test ends.
 * @param options - The list, how adding a project answers, and the folder the picker returns.
 * @returns The screen, the fake and the appearances sent to the window.
 */
async function workbench(
  options: {
    initial?: Parameters<typeof fakeClient>[0];
    answers?: Parameters<typeof fakeClient>[1];
    picked?: string | null;
  } = {},
) {
  // The size of the app's window, so the sidebar and tab bar sit side by side.
  await page.viewport(1280, 820);
  const fake = fakeClient(options.initial ?? list(), options.answers);
  const displayMode = createDisplayMode("summary", (mode) => {
    void fake.client.setPreferences({ displayMode: mode });
  });
  onTestFinished(followPreferences(displayMode, fake.client));
  const native: string[] = [];
  const screen = await render(
    <DisplayModeContext value={displayMode}>
      <Workbench
        client={fake.client}
        status={<span>已连接宿主</span>}
        pickDirectory={async () => options.picked ?? null}
        setNativeAppearance={(appearance) => native.push(appearance)}
      />
    </DisplayModeContext>,
  );
  return { screen, ...fake, native };
}

describe("Workbench sidebar", () => {
  it("lists a project's workspaces, local first, the merged one last, with merge states and running work", async () => {
    const { screen } = await workbench();

    const rows = screen.getByTestId("workspace-row");
    await expect.element(rows.nth(0)).toHaveTextContent("main");
    await expect.element(rows.nth(0).getByRole("img", { name: "运行中" })).toBeVisible();
    await expect.element(rows.nth(1).getByRole("img", { name: "运行中" })).not.toBeInTheDocument();
    await expect.element(rows.nth(1)).toHaveTextContent("feat/sidebar↑3未提交");
    await expect.element(rows.nth(2)).toHaveTextContent("fix/typo已合并");
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "true");
    await expect.element(rows.nth(0)).toHaveAttribute("title", "本地工作区（项目目录）");
  });

  it("shows each session's highest status on its tab, and the highest of a workspace's live sessions on its row", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: {
        ...initial,
        sessions: [
          session({ sessionId: "s1", containerId: LOCAL, attention: { reason: "error", at: 1, cleared: true } }),
          ...initial.sessions.slice(1),
          session({ sessionId: "s4", containerId: FEATURE, attention: { reason: "auth", at: 1, cleared: false } }),
          session({ sessionId: "s5", containerId: MERGED, asking: 1, archived: true }),
        ],
      },
    });

    const rows = screen.getByTestId("workspace-row");
    await expect.element(rows.nth(0).getByRole("img", { name: "出错" })).toBeVisible();
    await expect.element(rows.nth(0).getByRole("img", { name: "运行中" })).not.toBeInTheDocument();
    await expect.element(rows.nth(1).getByRole("img", { name: "待授权" })).toBeVisible();
    await expect.element(rows.nth(2).getByRole("img", { name: "待回答" })).not.toBeInTheDocument();
    const tabs = screen.getByRole("tab");
    await expect.element(tabs.nth(0).getByRole("img", { name: "出错" })).toBeVisible();
    await expect.element(tabs.nth(1).getByRole("img", { name: "运行中" })).toBeVisible();
    onTestFinished(() => localStorage.removeItem("atrium.collapsedProjects"));
    await screen.getByTestId("project-row").click();
    await expect.element(screen.getByTestId("project-row").getByRole("img", { name: "待授权" })).toBeVisible();
  });

  it("collects the sessions that need the user above the projects, five at first, opening one when clicked", async () => {
    const initial = list();
    const minute = 60_000;
    /** An error not seen yet, set `minutesAgo`. */
    const error = (minutesAgo: number) => ({
      attention: { reason: "error" as const, at: Date.now() - minutesAgo * minute, cleared: false },
    });
    const { screen, calls } = await workbench({
      initial: {
        ...initial,
        sessions: [
          ...initial.sessions,
          session({ sessionId: "e1", containerId: FEATURE, name: "错一", ...error(30) }),
          session({ sessionId: "e2", containerId: LOCAL, name: "错二", ...error(3) }),
          session({ sessionId: "e3", containerId: "chats", name: "错三", ...error(50) }),
          session({ sessionId: "e4", containerId: LOCAL, name: "错四", ...error(40) }),
          session({
            sessionId: "seen",
            containerId: LOCAL,
            ...error(1),
            attention: { ...error(1).attention, cleared: true },
          }),
          session({ sessionId: "gone", containerId: LOCAL, ...error(1), archived: true }),
          session({ sessionId: "a1", containerId: FEATURE, name: "问一", asking: Date.now() - 12 * minute }),
          session({
            sessionId: "k1",
            containerId: "chats",
            name: "钥一",
            attention: { reason: "auth", at: 0, cleared: false },
          }),
        ],
      },
    });

    const inbox = screen.getByRole("region", { name: "等你处理" });
    await expect.element(inbox).toBeVisible();
    expect(inbox.element().firstElementChild?.textContent).toBe("等你处理6");
    const rows = inbox.getByTestId("inbox-row");
    expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
      "问一atrium · feat/sidebar12 分钟前",
      expect.stringMatching(/^钥一对话/),
      "错二atrium · main3 分钟前",
      "错一atrium · feat/sidebar30 分钟前",
      "错四atrium · main40 分钟前",
    ]);
    await expect.element(rows.nth(0).getByRole("img", { name: "待回答" })).toBeVisible();
    await expect.element(rows.nth(1).getByRole("img", { name: "待授权" })).toBeVisible();
    await inbox.getByRole("button", { name: "还有 1 条" }).click();
    await expect.element(rows.nth(5)).toHaveTextContent("错三对话50 分钟前");
    await inbox.getByRole("button", { name: "收起" }).click();
    await expect.element(rows.nth(5)).not.toBeInTheDocument();

    // A question stays until answered; an error would leave once seen.
    await rows.nth(0).click();
    await vi.waitFor(() => expect(calls).toContain("openSession a1"));
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "true");
    await expect.element(rows.nth(1)).toHaveAttribute("aria-current", "false");
  });

  it("leaves the inbox out when nothing needs the user", async () => {
    const { screen } = await workbench();

    await expect.element(screen.getByTestId("project-row")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "等你处理" })).not.toBeInTheDocument();
  });

  it("goes to a workspace when clicked, and collapses a project to a summary it remembers", async () => {
    const { screen, calls } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.collapsedProjects"));

    await screen.getByTestId("workspace-row").nth(1).click();
    await vi.waitFor(() => expect(calls).toContain(`selectContainer ${FEATURE}`));
    await screen.getByTestId("project-row").click();

    await expect.element(screen.getByTestId("workspace-row")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("project-row")).toHaveTextContent("atrium1 待合并");
    await expect.element(screen.getByTestId("project-row").getByRole("img", { name: "运行中" })).toBeVisible();
    await expect.element(screen.getByTestId("project-row")).toHaveAttribute("aria-current", "true");
    expect(localStorage.getItem("atrium.collapsedProjects")).toBe(JSON.stringify([PROJECT.id]));
  });

  it("adds the folder the user picks as a project, and nothing when cancelled", async () => {
    const { screen, calls } = await workbench({ picked: "/work/web" });

    await screen.getByRole("button", { name: "添加项目" }).click();

    await vi.waitFor(() => expect(calls).toContain("addProject /work/web"));
  });

  it("explains a folder that is a project already", async () => {
    const { screen } = await workbench({
      picked: "/work/atrium",
      answers: {
        addProject: () => Promise.reject(new CommandError("project_exists", { projectId: PROJECT.id })),
      },
    });

    await screen.getByRole("button", { name: "添加项目" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("这个目录已经在项目「atrium」里了");
  });

  it("searches workspaces and sessions, and opens what is chosen", async () => {
    const { screen, calls } = await workbench();
    await screen.getByRole("button", { name: "搜索工作区和会话" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区和会话" }), "SideBar");
    const results = screen.getByRole("region", { name: "搜索结果" });
    await expect
      .element(results)
      .toMatchTextContent(/^工作区feat\/sidebaratrium↑3未提交会话实现 sidebaratrium · feat\/sidebar1 分钟前$/);
    await results.getByRole("button", { name: /实现 sidebar/ }).click();
    await vi.waitFor(() => expect(calls).toContain("openSession s3"));

    // Results stay after one is chosen; Escape in the box closes the search.
    await screen.getByRole("textbox", { name: "搜索工作区和会话" }).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("region", { name: "搜索结果" })).not.toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    const { screen } = await workbench();
    await screen.getByRole("button", { name: "搜索工作区和会话" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区和会话" }), "nothing");

    await expect.element(screen.getByText("没有匹配的工作区或会话")).toBeVisible();
  });

  it("lists the five latest chats and offers the rest", async () => {
    const chats = Array.from({ length: 7 }, (_, at) =>
      session({ sessionId: `c${at}`, containerId: "chats", prompt: `对话 ${at}`, updatedAt: Date.now() - at * 60_000 }),
    );
    const { screen, calls } = await workbench({ initial: { ...list(), sessions: chats } });

    await expect.element(screen.getByText("对话 4")).toBeVisible();
    await expect.element(screen.getByText("对话 5")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "全部 7 个对话" }).click();

    await vi.waitFor(() => expect(calls).toContain("selectContainer chats"));
  });

  it("renames a workspace in place, and clears its name with an empty one", async () => {
    const { screen, calls } = await workbench();
    const row = screen.getByTestId("workspace-row").nth(1);
    await row.hover();
    await row.getByRole("button", { name: "工作区 feat/sidebar" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();

    await userEvent.fill(screen.getByRole("textbox", { name: "工作区名称" }), "侧栏");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(calls).toContain(`renameWorkspace ${FEATURE} 侧栏`));
    expect(calls).not.toContain(`selectContainer ${FEATURE}`);
  });

  it("renames and removes a project from its menu", async () => {
    const { screen, calls } = await workbench();
    const project = screen.getByTestId("project-row");
    await project.hover();
    await project.getByRole("button", { name: "项目 atrium" }).click();
    await screen.getByRole("menuitem", { name: "从侧栏移除" }).click();

    await vi.waitFor(() => expect(calls).toContain(`removeProject ${PROJECT.id}`));
  });

  it("switches the appearance between following the system, light and dark", async () => {
    const { screen, calls, native } = await workbench();
    onTestFinished(() => document.documentElement.classList.remove("dark"));

    await screen.getByRole("button", { name: "外观：跟随系统" }).click();
    await screen.getByRole("button", { name: "外观：浅色" }).click();

    await expect.element(screen.getByRole("button", { name: "外观：深色" })).toBeVisible();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(native).toStrictEqual(["system", "light", "dark"]);
    expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([
      'setPreferences {"appearance":"light"}',
      'setPreferences {"appearance":"dark"}',
    ]);
  });
});

describe("Workbench merge states", () => {
  it("says when a worktree's merge state cannot be told, and why on hover", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: {
        ...initial,
        workspaces: [
          workspace({
            id: FEATURE,
            branch: "feat/old-git",
            merge: { dirty: true, ahead: 0, verdict: "unknown", reason: "git_too_old" },
          }),
        ],
      },
    });

    const row = screen.getByTestId("workspace-row");
    await expect.element(row).toHaveTextContent("feat/old-git未提交状态未知");
    await expect.element(row.getByText("状态未知")).toHaveAttribute("title", "无法判断是否已合并：git 低于 2.38");
  });
});

describe("Workbench tabs", () => {
  it("shows the container's open sessions as tabs, the active one selected, and switches and closes them", async () => {
    const { screen, calls } = await workbench();
    const tabs = screen.getByRole("tab");

    await expect.element(tabs.nth(0)).toHaveTextContent("重构宿主");
    await expect.element(tabs.nth(1)).toHaveTextContent("调研 pi RPC");
    await expect.element(tabs.nth(1).getByRole("img", { name: "运行中" })).toBeVisible();
    await expect.element(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(1).click();
    await expect.element(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await screen.getByRole("button", { name: "关闭 调研 pi RPC" }).click();

    await expect.element(screen.getByRole("tab")).toHaveTextContent("重构宿主");
    expect(calls).toContain("openSession s2");
    expect(calls).toContain("closeTab s2");
  });

  it("lists every session of the container in its history, newest first, marking open ones", async () => {
    const initial = list();
    const { screen, calls } = await workbench({
      initial: {
        ...initial,
        sessions: [
          ...initial.sessions,
          session({ sessionId: "old", containerId: LOCAL, prompt: "旧的", updatedAt: Date.now() - 3 * 3_600_000 }),
          session({ sessionId: "gone", containerId: LOCAL, prompt: "归档的", archived: true }),
        ],
      },
    });

    await screen.getByRole("button", { name: "历史" }).click();
    const items = screen.getByRole("menuitem");

    await expect.element(items.nth(0)).toMatchTextContent(/^重构宿主已打开1 分钟前$/);
    await expect.element(items.nth(2)).toMatchTextContent(/^旧的3 小时前$/);
    await expect.element(screen.getByText("归档的")).not.toBeInTheDocument();
    await items.nth(2).click();
    await vi.waitFor(() => expect(calls).toContain("openSession old"));
  });

  it("creates a session in the workspace with +, then as a draft in a new tab", async () => {
    const { screen, calls } = await workbench();

    await screen.getByRole("button", { name: "新建会话（⌘T）" }).click();

    await vi.waitFor(() => expect(calls).toContain(`createSession ${LOCAL}`));
    await expect.element(screen.getByRole("tab").nth(2)).toHaveTextContent("新会话");
    await expect.element(screen.getByRole("tab").nth(2)).toHaveAttribute("aria-selected", "true");
  });

  it("renames and archives the active session from its menu, and copies its file's path", async () => {
    const { screen, calls } = await workbench();

    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();
    await userEvent.fill(screen.getByRole("textbox", { name: "会话名称" }), "新名字");
    await userEvent.keyboard("{Enter}");
    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "归档" }).click();

    await vi.waitFor(() => expect(calls).toContain("archiveSession s1"));
    expect(calls).toContain("renameSession s1 新名字");
    await screen.getByRole("button", { name: "当前会话" }).click();
    await expect.element(screen.getByRole("menuitem", { name: "复制会话文件路径" })).toBeEnabled();
  });

  it("cannot rename a draft or copy its path, as it has no file yet", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: { ...initial, sessions: [session({ sessionId: "s1", containerId: LOCAL, file: null, state: "draft" })] },
    });

    await screen.getByRole("button", { name: "当前会话" }).click();

    await expect.element(screen.getByRole("menuitem", { name: "复制会话文件路径" })).toBeDisabled();
    await expect.element(screen.getByRole("menuitem", { name: "重命名" })).toBeDisabled();
  });

  it("switches the display mode with Ctrl+O and from its menu, saving it with the preferences", async () => {
    const { screen, calls } = await workbench();
    const menu = screen.getByRole("button", { name: "显示模式（Ctrl+O 切换）" });
    await expect.element(menu).toHaveTextContent("摘要模式");

    await userEvent.keyboard("{Control>}o{/Control}");
    await expect.element(menu).toHaveTextContent("思考模式");
    await menu.click();
    await screen.getByRole("menuitemradio", { name: /详细/ }).click();

    await expect.element(menu).toHaveTextContent("详细模式");
    expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([
      'setPreferences {"displayMode":"thinking"}',
      'setPreferences {"displayMode":"detailed"}',
    ]);
  });
});

describe("Workbench keys and focus", () => {
  it.each([
    ["{Meta>}n{/Meta}", "createChat"],
    ["{Meta>}t{/Meta}", `createSession ${LOCAL}`],
    ["{Meta>}w{/Meta}", "closeTab s1"],
    ["{Meta>}2{/Meta}", "openSession s2"],
    ["{Meta>}{Shift>}]{/Shift}{/Meta}", "openSession s2"],
  ])("acts on %s", async (keys, call) => {
    const { calls } = await workbench();

    await userEvent.keyboard(keys);

    await vi.waitFor(() => expect(calls).toContain(call));
  });

  it("goes to the previous tab with ⌘⇧[, and ignores keys with no tab to go to", async () => {
    const initial = list();
    const { index } = await workbench({
      initial: { ...initial, layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1", "s2"], active: "s2" } } } },
    });

    await userEvent.keyboard("{Meta>}{Shift>}[[{/Shift}{/Meta}");
    await vi.waitFor(() => expect(index.getState().layout.tabs[LOCAL]?.active).toBe("s1"));
    await userEvent.keyboard("{Meta>}{Shift>}[[{/Shift}{/Meta}");
    await userEvent.keyboard("{Meta>}9{/Meta}");

    expect(index.getState().layout.tabs[LOCAL]).toStrictEqual({ open: ["s1", "s2"], active: "s1" });
  });

  it("starts a chat with ⌘T when the client is nowhere", async () => {
    const { calls, screen } = await workbench({ initial: { ...list(), layout: { container: null, tabs: {} } } });

    await expect.element(screen.getByText("开始一段对话")).toBeVisible();
    await userEvent.keyboard("{Meta>}t{/Meta}");

    await vi.waitFor(() => expect(calls).toContain("createChat"));
  });

  it("asks the host to look again when the window gains focus", async () => {
    const { calls } = await workbench();

    window.dispatchEvent(new FocusEvent("focus"));

    await vi.waitFor(() => expect(calls).toContain("windowFocused"));
  });

  it("mentions index files reset at the host's start until dismissed", async () => {
    const { screen } = await workbench({ initial: { ...list(), resets: ["projects", "layouts"] } });

    await expect.element(screen.getByText(/项目列表、标签页的文件损坏了，已经重置/)).toBeVisible();
    await screen.getByRole("button", { name: "知道了" }).click();

    await expect.element(screen.getByText(/文件损坏了/)).not.toBeInTheDocument();
  });
});

/** Keeps a draft for each session named. */
function drafts(...sessionIds: string[]): void {
  for (const id of sessionIds) {
    localStorage.setItem(`atrium-draft:${id}`, JSON.stringify({ text: id, pastes: [], files: [] }));
  }
}

/** The sessions that still have a draft. */
function kept(): string[] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith("atrium-draft:"))
    .map((key) => key.slice("atrium-draft:".length))
    .toSorted();
}

describe("Workbench drafts", () => {
  it("drops the drafts of archived sessions, and of sessions gone from the list while it runs", async () => {
    localStorage.clear();
    onTestFinished(() => localStorage.clear());
    drafts("s1", "s2", "s3", "unseen");
    const initial = list();
    const { index } = await workbench({
      initial: { ...initial, sessions: initial.sessions.map((one) => ({ ...one, archived: one.sessionId === "s2" })) },
    });

    await vi.waitFor(() => expect(kept()).toStrictEqual(["s1", "s3", "unseen"]));
    index.setState({ seq: 2, sessions: index.getState().sessions.filter((one) => one.sessionId !== "s1") });
    await vi.waitFor(() => expect(kept()).toStrictEqual(["s3", "unseen"]));
    // A new host may not have found every session yet: nothing is dropped for being missing.
    index.setState({ generation: "h2", seq: 1, sessions: [] });
    await vi.waitFor(() => expect(index.getState().sessions).toStrictEqual([]));
    expect(kept()).toStrictEqual(["s3", "unseen"]);
  });
});

describe("Workbench attention and hand-off (M1.9)", () => {
  it("marks an error seen once its session shows in a focused window, but never a sign-in problem", async () => {
    const initial = list();
    const { calls, index } = await workbench({
      initial: {
        ...initial,
        sessions: [
          session({ sessionId: "s1", containerId: LOCAL, attention: { reason: "error", at: 1, cleared: false } }),
          session({ sessionId: "s2", containerId: LOCAL, attention: { reason: "auth", at: 1, cleared: false } }),
        ],
      },
    });

    window.dispatchEvent(new FocusEvent("focus"));
    await vi.waitFor(() => expect(calls).toContain("clearAttention s1"));
    index.setState({ layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1", "s2"], active: "s2" } } } });
    window.dispatchEvent(new FocusEvent("focus"));

    await vi.waitFor(() => expect(calls.filter((call) => call.startsWith("windowFocused"))).toHaveLength(2));
    expect(calls.filter((call) => call.startsWith("clearAttention"))).toStrictEqual(["clearAttention s1"]);
    expect(index.getState().sessions[0]?.attention).toStrictEqual({ reason: "error", at: 1, cleared: true });
  });

  it("hands the active session to a terminal, then shows only how to go on there, until taken back", async () => {
    const { screen, calls } = await workbench();

    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "在终端中继续" }).click();

    const banner = screen.getByRole("region", { name: "已在终端中继续" });
    await expect.element(banner).toBeVisible();
    await expect.element(banner.getByText("pi --session '/pi/s1.jsonl'")).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).not.toBeInTheDocument();
    expect(calls).toContain("handOff s1");

    await banner.getByRole("button", { name: "在 Atrium 里继续" }).click();

    await expect.element(banner).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toBeVisible();
    expect(calls).toContain("takeBack s1");
  });

  it("cannot hand off a draft, which has no file, nor a session running", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: {
        ...initial,
        sessions: [
          session({ sessionId: "s1", containerId: LOCAL, file: null, state: "draft" }),
          session({ sessionId: "s2", containerId: LOCAL, running: true }),
        ],
      },
    });

    await screen.getByRole("button", { name: "当前会话" }).click();
    await expect.element(screen.getByRole("menuitem", { name: "在终端中继续" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await screen.getByRole("tab").nth(1).click();
    await screen.getByRole("button", { name: "当前会话" }).click();

    await expect.element(screen.getByRole("menuitem", { name: "在终端中继续" })).toBeDisabled();
  });

  it("says why a hand-off was refused", async () => {
    const { screen } = await workbench({
      answers: { handOff: () => Promise.reject(new CommandError("session_busy")) },
    });

    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "在终端中继续" }).click();

    await expect.element(screen.getByText("先停止运行或清空排队，再交给终端")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "已在终端中继续" })).not.toBeInTheDocument();
  });
});
