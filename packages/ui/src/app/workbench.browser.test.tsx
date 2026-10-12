import { CommandError, type SessionView } from "@atrium/client";
import { IDLE_CONTROL } from "@atrium/protocol";
import type { ReactNode } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { describeArchiveError } from "../sidebar/archive";
import { DisplayModeContext, createDisplayMode, followPreferences } from "../state/display-mode";
import { PROJECT, chat, fakeClient, session, workspace } from "../test/fake-client";
import { ConnectionStatus } from "./connection-status";
import { Workbench } from "./workbench";

const LOCAL = "wks_000000000000000a";
const FEATURE = "wks_000000000000000b";
const MERGED = "wks_000000000000000c";
const CHAT = "cht_a";

/**
 * A list with one project, three workspaces, a chat and some sessions, the client in the local
 * workspace.
 */
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
      session({ sessionId: "c1", containerId: CHAT, prompt: "解释 merge-tree" }),
    ],
    chats: [chat({ id: CHAT, firstSessionId: "c1" })],
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
 * @returns The screen, the fake, the appearances sent to the window, and the addresses opened and
 * paths shown in the Finder.
 */
async function workbench(
  options: {
    initial?: Parameters<typeof fakeClient>[0];
    answers?: Parameters<typeof fakeClient>[1];
    picked?: string | null;
    status?: ReactNode;
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
  const opened: string[] = [];
  const revealed: string[] = [];
  const screen = await render(
    <DisplayModeContext value={displayMode}>
      <Workbench
        client={fake.client}
        status={options.status ?? <span>已连接宿主</span>}
        pickDirectory={async () => options.picked ?? null}
        setNativeAppearance={(appearance) => native.push(appearance)}
        openUrl={(url) => opened.push(url)}
        reveal={(path) => revealed.push(path)}
        pathForFile={undefined}
      />
    </DisplayModeContext>,
  );
  return { screen, ...fake, native, opened, revealed };
}

describe("Workbench connection line", () => {
  it("takes no room once connected, and a line at the bottom while not", async () => {
    const connected = {
      status: "connected",
      traceId: "t",
      hostVersion: "0.1.0",
      hostInstanceId: "h1",
      installSeed: 1,
      logDir: "/l",
    } as const;
    const { screen } = await workbench({ status: <ConnectionStatus view={connected} /> });
    const footer = screen.container.querySelector("footer");

    await expect.element(screen.getByRole("status")).toHaveTextContent("已连接宿主 0.1.0");
    expect(footer?.getBoundingClientRect().height).toBe(0);
    await screen.rerender(
      <DisplayModeContext value={createDisplayMode("summary", () => undefined)}>
        <Workbench
          client={fakeClient(list()).client}
          status={<ConnectionStatus view={{ status: "reconnecting", attempt: 1, code: 1006 }} />}
          pickDirectory={undefined}
          setNativeAppearance={undefined}
          openUrl={() => undefined}
          reveal={undefined}
          pathForFile={undefined}
        />
      </DisplayModeContext>,
    );
    await expect.element(screen.getByRole("status")).toBeVisible();
    expect(screen.container.querySelector("footer")?.getBoundingClientRect().height).toBe(24);
  });
});

describe("Workbench sidebar", () => {
  it("lists a project's workspaces, local first, the merged one last, with merge states and running work", async () => {
    const { screen } = await workbench();

    const rows = screen.getByTestId("workspace-row");
    await expect.element(rows.nth(0)).toHaveTextContent("main");
    await expect.element(rows.nth(0).getByRole("img", { name: "运行中" })).toBeVisible();
    await expect.element(rows.nth(1).getByRole("img", { name: "运行中" })).not.toBeInTheDocument();
    await expect.element(rows.nth(1)).toHaveTextContent("feat/sidebar3未提交");
    await expect.element(rows.nth(2)).toHaveTextContent("fix/typo已合并");
    // The arrow and the merge mark are icons, not characters of the font.
    expect(rows.nth(1).getByTitle("未合并：比主干多 3 个提交").element().querySelector("svg")).not.toBeNull();
    expect(
      rows
        .nth(2)
        .getByTitle(/^改动已全部进入主干/)
        .element()
        .querySelector("svg"),
    ).not.toBeNull();
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
          session({ sessionId: "e3", containerId: CHAT, name: "错三", ...error(50) }),
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
            containerId: CHAT,
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
      expect.stringMatching(/^钥一对话 · 解释 merge-tree/),
      "错二atrium · main3 分钟前",
      "错一atrium · feat/sidebar30 分钟前",
      "错四atrium · main40 分钟前",
    ]);
    await expect.element(rows.nth(0).getByRole("img", { name: "待回答" })).toBeVisible();
    await expect.element(rows.nth(1).getByRole("img", { name: "待授权" })).toBeVisible();
    await inbox.getByRole("button", { name: "还有 1 条" }).click();
    await expect.element(rows.nth(5)).toHaveTextContent("错三对话 · 解释 merge-tree50 分钟前");
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
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }), "SideBar");
    const results = screen.getByRole("region", { name: "搜索结果" });
    await expect
      .element(results)
      .toMatchTextContent(/^工作区feat\/sidebaratrium3未提交会话实现 sidebaratrium · feat\/sidebar1 分钟前$/);
    await results.getByRole("button", { name: /实现 sidebar/ }).click();
    await vi.waitFor(() => expect(calls).toContain("openSession s3"));

    // Results stay after one is chosen; Escape in the box closes the search.
    await screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("region", { name: "搜索结果" })).not.toBeInTheDocument();
  });

  it("finds chats by name in a group of their own, going to one when chosen", async () => {
    const initial = list();
    const { screen, calls } = await workbench({
      initial: { ...initial, chats: [chat({ id: CHAT, firstSessionId: "c1", alias: "Merge 原理" })] },
    });
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();
    const box = screen.getByRole("textbox", { name: "搜索工作区、对话和会话" });

    await userEvent.type(box, "MERGE");
    const results = screen.getByRole("region", { name: "搜索结果" });
    await expect
      .element(results)
      .toMatchTextContent(/^对话Merge 原理1 分钟前会话解释 merge-tree对话 · Merge 原理1 分钟前$/);
    await userEvent.fill(box, "原理");
    await expect.element(results).toMatchTextContent(/^对话Merge 原理1 分钟前$/);
    await results.getByRole("button").click();

    await vi.waitFor(() => expect(calls).toContain("openSession c1"));
  });

  it("says when nothing matches", async () => {
    const { screen } = await workbench();
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }), "nothing");

    await expect.element(screen.getByText("没有匹配的工作区、对话或会话")).toBeVisible();
  });

  it("lists chats like workspaces, latest first, five until the rest are shown in place", async () => {
    const minute = 60_000;
    const sessions = Array.from({ length: 7 }, (_, at) =>
      session({
        sessionId: `c${at}`,
        containerId: `cht_${at}`,
        prompt: `问题 ${at}`,
        updatedAt: Date.now() - (at + 1) * minute,
      }),
    );
    const { screen, calls } = await workbench({
      initial: {
        ...list(),
        sessions: [
          ...sessions,
          // A later session of chat 6 brings it to the top, with its status; its name stays the first's.
          session({ sessionId: "c6b", containerId: "cht_6", prompt: "追问", running: true, updatedAt: Date.now() }),
          session({ sessionId: "gone", containerId: "cht_gone", archived: true }),
        ],
        chats: [
          ...sessions.map((one, at) => chat({ id: `cht_${at}`, firstSessionId: one.sessionId })),
          chat({ id: "cht_gone", firstSessionId: null }),
        ],
      },
    });
    const section = screen.getByRole("region", { name: "对话" });
    const rows = section.getByTestId("chat-row");

    await expect.element(rows.nth(0)).toHaveTextContent("问题 6刚刚");
    await expect.element(rows.nth(0).getByRole("img", { name: "运行中" })).toBeVisible();
    expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
      "问题 6刚刚",
      "问题 01 分钟前",
      "问题 12 分钟前",
      "问题 23 分钟前",
      "问题 34 分钟前",
    ]);
    await section.getByRole("button", { name: "显示全部 7 个" }).click();
    await expect.element(rows.nth(6)).toHaveTextContent("问题 56 分钟前");
    await section.getByRole("button", { name: "收起" }).click();
    await expect.element(rows.nth(5)).not.toBeInTheDocument();
    // The area opens the active session s1 of the local workspace on its own.
    expect(calls.filter((call) => /^(selectContainer|openSession c)/.test(call))).toStrictEqual([]);
  });

  it("names a chat by its alias, else its first session's title, else as new", async () => {
    const initial = list();
    await workbench({
      initial: {
        ...initial,
        sessions: [
          ...initial.sessions,
          session({ sessionId: "d1", containerId: "cht_b", prompt: null, file: null, state: "draft" }),
          session({ sessionId: "r1", containerId: "cht_c", prompt: "周报的提纲" }),
        ],
        chats: [
          ...initial.chats,
          chat({ id: "cht_b", firstSessionId: "d1" }),
          chat({ id: "cht_c", firstSessionId: "r1", alias: "周报" }),
        ],
      },
    });

    const rows = page.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    expect(rows.elements().map((row) => row.querySelector(".truncate")?.textContent)).toStrictEqual([
      "解释 merge-tree",
      "新对话",
      "周报",
    ]);
  });

  it("opens a chat's latest session when it has no tab open, and goes back to its tabs when it has", async () => {
    const initial = list();
    const { screen, calls, index } = await workbench({
      initial: {
        ...initial,
        sessions: [
          ...initial.sessions,
          session({ sessionId: "c2", containerId: CHAT, prompt: "再问", updatedAt: Date.now() - 1000 }),
          session({ sessionId: "b1", containerId: "cht_b", prompt: "旧的", updatedAt: Date.now() - 9000 }),
          session({ sessionId: "b2", containerId: "cht_b", prompt: "新的", updatedAt: Date.now() - 2000 }),
        ],
        chats: [...initial.chats, chat({ id: "cht_b", firstSessionId: "b1" })],
        layout: { ...initial.layout, tabs: { ...initial.layout.tabs, [CHAT]: { open: ["c1"], active: "c1" } } },
      },
    });
    const rows = screen.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await expect.element(rows.nth(1)).toHaveTextContent("旧的刚刚");

    await rows.nth(1).click();
    await vi.waitFor(() => expect(calls).toContain("openSession b2"));
    await expect.element(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "false");
    await rows.nth(0).click();

    await vi.waitFor(() => expect(calls).toContain(`selectContainer ${CHAT}`));
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "true");
    expect(calls).not.toContain("openSession c2");
    expect(index.getState().layout.tabs[CHAT]).toStrictEqual({ open: ["c1"], active: "c1" });
  });

  it("explains a chat that went while it was being renamed", async () => {
    const { screen } = await workbench({
      answers: { renameChat: () => Promise.reject(new CommandError("chat_not_found", { chatId: CHAT })) },
    });
    const row = screen.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await row.hover();
    await row.getByRole("button", { name: "对话 解释 merge-tree" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();

    await userEvent.fill(screen.getByRole("textbox", { name: "对话名称" }), "合并原理");
    await userEvent.keyboard("{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("这个对话已经不在了");
  });

  it("renames a chat in place from its menu, and clears its name with an empty one", async () => {
    const initial = list();
    const { screen, calls } = await workbench({
      initial: { ...initial, chats: [chat({ id: CHAT, firstSessionId: "c1", alias: "合并原理" })] },
    });
    const row = screen.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await row.hover();
    await row.getByRole("button", { name: "对话 合并原理" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();

    await userEvent.fill(screen.getByRole("textbox", { name: "对话名称" }), "merge-tree");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(calls).toContain(`renameChat ${CHAT} merge-tree`));
    await row.hover();
    await row.getByRole("button", { name: "对话 合并原理" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();
    await userEvent.clear(screen.getByRole("textbox", { name: "对话名称" }));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(calls).toContain(`renameChat ${CHAT} null`));
    // The area opens the active session s1 of the local workspace on its own.
    expect(calls.filter((call) => /^(selectContainer|openSession c)/.test(call))).toStrictEqual([]);
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

/**
 * The list of {@link list} with the merged worktree running one of its two live sessions, and two
 * worktrees archived five minutes and two hours ago.
 *
 * @sideEffects none
 * @returns The list.
 */
function archivable() {
  const base = list();
  return {
    ...base,
    workspaces: [
      ...base.workspaces,
      workspace({ id: "wks_00000000000000a1", branch: "old/one", archivedAt: Date.now() - 2 * 60 * 60_000 }),
      workspace({ id: "wks_00000000000000a2", branch: "old/two", archivedAt: Date.now() - 5 * 60_000 }),
    ],
    sessions: [
      ...base.sessions,
      session({ sessionId: "m1", containerId: MERGED, prompt: "收尾", running: true }),
      session({ sessionId: "m2", containerId: MERGED, prompt: "早先的", running: true, archived: true }),
      session({ sessionId: "m3", containerId: MERGED, prompt: "闲着" }),
    ],
  };
}

/**
 * Opens the "···" menu of the n-th workspace row.
 *
 * @sideEffects Hovers and clicks in the page.
 * @param screen - The rendered workbench.
 * @param nth - Which row, from 0.
 * @param name - The workspace's name.
 */
async function workspaceMenu(screen: Awaited<ReturnType<typeof workbench>>["screen"], nth: number, name: string) {
  const row = screen.getByTestId("workspace-row").nth(nth);
  await row.hover();
  await row.getByRole("button", { name: `工作区 ${name}` }).click();
}

/**
 * Opens the project's "···" menu.
 *
 * @sideEffects Hovers and clicks in the page.
 * @param screen - The rendered workbench.
 */
async function projectMenu(screen: Awaited<ReturnType<typeof workbench>>["screen"]) {
  const project = screen.getByTestId("project-row");
  await project.hover();
  await project.getByRole("button", { name: "项目 atrium" }).click();
}

describe("Workbench workspace archiving (M1.11)", () => {
  it("asks before archiving a worktree, saying its branch is kept and its running sessions stop, then hides it", async () => {
    const { screen, calls } = await workbench({ initial: archivable() });
    await workspaceMenu(screen, 2, "fix/typo");
    await screen.getByRole("menuitem", { name: "归档…" }).click();

    const dialog = screen.getByRole("alertdialog", { name: "归档工作区「fix/typo」？" });
    await expect
      .element(dialog)
      .toHaveAccessibleDescription(
        "会删除 worktree 目录（包括被 git 忽略的文件），分支 fix/typo 保留；之后可以在项目菜单的“已归档的工作区”里恢复 其中 1 个会话正在运行，归档会停止它们",
      );
    await expect.element(dialog.getByRole("button", { name: "取消" })).toHaveFocus();
    // On the page's body, so it covers the whole window rather than the sidebar.
    expect(dialog.element().closest("nav")).toBeNull();
    expect(calls).not.toContain(`archiveWorkspace ${MERGED}`);

    await dialog.getByRole("button", { name: "归档" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(calls).toContain(`archiveWorkspace ${MERGED}`);
    expect(calls).not.toContain(`selectContainer ${MERGED}`);
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(2));
    await expect.element(screen.getByTestId("workspace-row").nth(1)).toHaveTextContent("feat/sidebar3未提交");
  });

  it("says a detached worktree's commit is kept, and warns of nothing when none of its sessions runs", async () => {
    const base = list();
    const { screen } = await workbench({
      initial: {
        ...base,
        workspaces: [...base.workspaces, workspace({ id: "wks_00000000000000d1", branch: null, head: "abc1234" })],
      },
    });
    await workspaceMenu(screen, 2, "wks_00000000000000d1");
    await screen.getByRole("menuitem", { name: "归档…" }).click();

    await expect
      .element(screen.getByRole("alertdialog"))
      .toHaveAccessibleDescription(
        "会删除 worktree 目录（包括被 git 忽略的文件），提交 abc1234 保留；之后可以在项目菜单的“已归档的工作区”里恢复",
      );
  });

  it("says nothing is kept when the worktree was on neither a branch nor a commit", async () => {
    const base = list();
    const { screen } = await workbench({
      initial: {
        ...base,
        workspaces: [...base.workspaces, workspace({ id: "wks_00000000000000d2", branch: null, head: null })],
      },
    });
    await workspaceMenu(screen, 2, "wks_00000000000000d2");
    await screen.getByRole("menuitem", { name: "归档…" }).click();

    await expect
      .element(screen.getByRole("alertdialog"))
      .toHaveAccessibleDescription(
        "会删除 worktree 目录（包括被 git 忽略的文件）；之后可以在项目菜单的“已归档的工作区”里恢复",
      );
  });

  it("offers archiving only for a worktree, and not while it has changes not committed", async () => {
    const { screen } = await workbench();
    await workspaceMenu(screen, 0, "main");

    await expect.element(screen.getByRole("menuitem", { name: "重命名" })).toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: "归档…" })).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await workspaceMenu(screen, 1, "feat/sidebar");
    const archive = screen.getByRole("menuitem", { name: "归档…" });
    await expect.element(archive).toBeDisabled();
    await expect.element(archive).toHaveAttribute("title", "有未提交的改动，先提交或丢弃");
  });

  it("cancels with 取消, Escape or a click outside, archiving nothing", async () => {
    const { screen, calls } = await workbench();
    const dialog = screen.getByRole("alertdialog");
    const ways = [
      () => dialog.getByRole("button", { name: "取消" }).click(),
      () => userEvent.keyboard("{Escape}"),
      () => screen.getByTestId("archive-scrim").click({ position: { x: 5, y: 5 } }),
    ];
    for (const cancel of ways) {
      await workspaceMenu(screen, 2, "fix/typo");
      await screen.getByRole("menuitem", { name: "归档…" }).click();
      await expect.element(dialog).toBeVisible();
      await cancel();
      await expect.element(dialog).not.toBeInTheDocument();
    }

    expect(calls.filter((call) => call.startsWith("archiveWorkspace"))).toStrictEqual([]);
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(3));
  });

  it("waits while archiving, then says why it failed and lets the user try again", async () => {
    const answer = Promise.withResolvers<void>();
    const { screen, calls } = await workbench({ answers: { archiveWorkspace: () => answer.promise } });
    await workspaceMenu(screen, 2, "fix/typo");
    await screen.getByRole("menuitem", { name: "归档…" }).click();
    const dialog = screen.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "归档" }).click();

    await expect.element(dialog.getByRole("button", { name: "归档中…" })).toBeDisabled();
    await expect.element(dialog.getByRole("button", { name: "取消" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await screen.getByTestId("archive-scrim").click({ position: { x: 5, y: 5 }, force: true });
    await expect.element(dialog).toBeVisible();

    answer.reject(new CommandError("workspace_dirty"));

    await expect.element(dialog.getByRole("alert")).toHaveTextContent("有未提交的改动，先提交或丢弃再归档");
    await expect.element(dialog.getByRole("button", { name: "归档" })).toBeEnabled();
    expect(calls.filter((call) => call.startsWith("archiveWorkspace"))).toStrictEqual([`archiveWorkspace ${MERGED}`]);
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(3));
  });

  it("lays the dialog out as a 380 px card over a blurred scrim, its buttons 30 px tall", async () => {
    const { screen } = await workbench();
    await workspaceMenu(screen, 2, "fix/typo");
    await screen.getByRole("menuitem", { name: "归档…" }).click();
    const dialog = screen.getByRole("alertdialog").element();
    const scrim = screen.getByTestId("archive-scrim").element();

    expect(dialog.getBoundingClientRect().width).toBe(380);
    expect(getComputedStyle(scrim).backdropFilter).toContain("blur(8px)");
    expect([scrim.getBoundingClientRect().width, scrim.getBoundingClientRect().height]).toStrictEqual([1280, 820]);
    expect(
      ["取消", "归档"].map(
        (name) =>
          screen.getByRole("alertdialog").getByRole("button", { name }).element().getBoundingClientRect().height,
      ),
    ).toStrictEqual([30, 30]);
  });

  it("hides archived workspaces from the projects and search, listing them in the project's menu newest first, opened and closed in place", async () => {
    const { screen } = await workbench({ initial: archivable() });

    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(3));
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }), "old/");
    await expect.element(screen.getByText("没有匹配的工作区、对话或会话")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();

    await expect
      .element(screen.getByRole("list", { name: "已归档的工作区" }))
      .toHaveTextContent("old/two5 分钟前恢复old/one2 小时前恢复");
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    await expect.element(screen.getByRole("list", { name: "已归档的工作区" })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("menuitem", { name: "已归档的工作区" }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("leaves the archived item out of a project with none archived", async () => {
    const { screen } = await workbench();
    await projectMenu(screen);

    await expect.element(screen.getByRole("menuitem", { name: "从侧栏移除" })).toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: "已归档的工作区" })).not.toBeInTheDocument();
  });

  it("restores an archived workspace from the list, closing the menu and showing it again", async () => {
    const { screen, calls } = await workbench({ initial: archivable() });
    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    await screen.getByRole("menuitem", { name: "恢复 old/one" }).click();

    await vi.waitFor(() => expect(calls).toContain("restoreWorkspace wks_00000000000000a1"));
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(4));
    await expect.element(screen.getByTestId("workspace-row").nth(2)).toHaveTextContent("old/one");
  });

  it("shows eight archived workspaces before the list scrolls", async () => {
    const base = list();
    const { screen } = await workbench({
      initial: {
        ...base,
        workspaces: Array.from({ length: 10 }, (_, n) =>
          workspace({ id: `wks_00000000000000b${n}`, archivedAt: Date.now() - n * 60_000 }),
        ),
      },
    });
    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    const shown = screen.getByRole("list", { name: "已归档的工作区" }).element();

    expect([shown.clientHeight, shown.scrollHeight]).toStrictEqual([256, 320]);
  });

  it("explains a restore that failed", async () => {
    const { screen } = await workbench({
      initial: archivable(),
      answers: { restoreWorkspace: () => Promise.reject(new CommandError("worktree_restore_failed")) },
    });
    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    await screen.getByRole("menuitem", { name: "恢复 old/two" }).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("没能恢复：目录已被占用，或分支已删除、正被别处检出");
  });
});

describe("describeArchiveError", () => {
  it("says why archiving failed for each code, and that the host failed otherwise", () => {
    const failures = [
      new CommandError("workspace_dirty"),
      new CommandError("workspace_unsaved_commits"),
      new CommandError("worktree_remove_failed"),
      new CommandError("workspace_not_found"),
      new CommandError("internal_error"),
      new Error("boom"),
    ];

    expect(failures.map(describeArchiveError)).toStrictEqual([
      "有未提交的改动，先提交或丢弃再归档",
      "当前提交不在任何分支上，先建一个分支再归档",
      "git 没能删除这个 worktree",
      "这个工作区已经不在了",
      "宿主出错了，没有完成",
      "宿主出错了，没有完成",
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

  it("creates a session in the chat the client is in with ⌘T and the tab bar's +, and a new chat with ⌘N", async () => {
    const { calls, screen } = await workbench({
      initial: { ...list(), layout: { container: CHAT, tabs: { [CHAT]: { open: ["c1"], active: "c1" } } } },
    });

    await userEvent.keyboard("{Meta>}t{/Meta}");
    await vi.waitFor(() => expect(calls).toContain(`createSession ${CHAT}`));
    await screen.getByRole("button", { name: "新建会话（⌘T）" }).click();
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.startsWith("create"))).toStrictEqual([
        `createSession ${CHAT}`,
        `createSession ${CHAT}`,
      ]),
    );
    await userEvent.keyboard("{Meta>}n{/Meta}");

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

  it.each<[string, Partial<SessionView>]>([
    ["a message on its way", { pending: [{ clientMessageId: "r1", text: "two" }] }],
    ["a run pi reported", { run: { runId: "run-1", startedAt: 1 } }],
    ["a stop under way", { control: { ...IDLE_CONTROL, stopping: true } }],
    ["pi starting again", { control: { ...IDLE_CONTROL, restarting: true } }],
    [
      "messages in the queue",
      { control: { ...IDLE_CONTROL, queue: [{ id: "q1", text: "two", createdAt: 1, images: 0 }] } },
    ],
  ])("cannot hand off a session with %s, which the host would refuse", async (_, state) => {
    const { screen, views } = await workbench();
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState(state);

    await screen.getByRole("button", { name: "当前会话" }).click();
    const item = screen.getByRole("menuitem", { name: "在终端中继续" });

    await expect.element(item).toBeDisabled();
    await expect.element(item).toHaveAttribute("title", "先停止运行或清空排队，再交给终端");
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

/**
 * What the model button's canvas shows once its frames have been drawn.
 *
 * @remarks
 * Below the top level the dots settle, so the canvas comes to hold one picture per seed: it is
 * read once it has stayed the same for ten frames.
 *
 * @sideEffects Waits for animation frames.
 * @param button - The model button.
 * @returns The canvas as a data URL.
 */
async function picture(button: Element): Promise<string> {
  const canvas = button.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  let last = "";
  for (let same = 0; same < 10;) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = canvas.toDataURL();
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return last;
}

describe("Workbench dots", () => {
  it("paints the model button's dots in the pattern of the host's install seed, kept while reconnecting", async () => {
    const opus = {
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      supportsImage: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      fast: null,
    } as const;
    const { screen, connection } = await workbench({
      initial: {
        preferences: {
          ...fakeClient().client.index.getState().preferences,
          lastModel: { providerId: opus.providerId, modelId: opus.modelId },
          thinkingByModel: { "anthropic/claude-opus-5-5": "medium" },
        },
      },
      answers: {
        models: {
          status: "ready",
          models: [{ ...opus, thinkingLevels: [...opus.thinkingLevels] }],
          defaultModel: null,
          error: null,
        },
      },
    });
    const chip = screen.getByRole("button", { name: /模型与推理强度/ });
    await expect.element(chip).toHaveTextContent("Claude Opus 5.5中");
    const first = await picture(chip.element());
    const connected = {
      status: "connected",
      traceId: "t",
      hostVersion: "0",
      hostInstanceId: "h1",
      logDir: "/Users/test/.atrium/logs",
    } as const;

    connection.setState({ ...connected, installSeed: 2 }, true);
    const second = await picture(chip.element());
    connection.setState({ status: "reconnecting", attempt: 1, code: 1006 }, true);
    const reconnecting = await picture(chip.element());
    connection.setState({ ...connected, installSeed: 1 }, true);
    const back = await picture(chip.element());

    expect(second).not.toBe(first);
    expect(reconnecting).toBe(second);
    expect(back).toBe(first);
  });
});
