import { CommandError } from "@atrium/client";
import type { Turn } from "@atrium/protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Workbench } from "../app/workbench";
import { chat, direction, fakeClient, session } from "../test/fake-client";

const GO = "lrn_go";
const RUST = "lrn_rust";
const SQL = "lrn_sql";

/**
 * Renders the workbench over a fake client with the list given.
 *
 * @remarks
 * A wide window, so the sidebar and the tab bar are whole.
 *
 * @sideEffects Renders; clears `localStorage` when the test ends.
 * @param initial - The list.
 * @param answers - How some commands answer.
 * @returns The screen and the fake.
 */
async function workbench(
  initial: Parameters<typeof fakeClient>[0] = {},
  answers: Parameters<typeof fakeClient>[1] = {},
) {
  await page.viewport(1280, 820);
  onTestFinished(() => localStorage.clear());
  const fake = fakeClient(initial, answers);
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
  return { screen, ...fake };
}

/**
 * A finished turn of one message and its reply.
 *
 * @sideEffects none
 * @param text - The message.
 * @returns The turn.
 */
function doneTurn(text: string): Turn {
  return {
    kind: "turn",
    id: "t1",
    source: null,
    user: { text, images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    steps: [{ kind: "text", id: "0", text: "好" }],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1000,
    usage: null,
    changes: [],
  };
}

describe("study mode in the window (SPEC-0008, ML1)", () => {
  it("opens the empty learning home from the sidebar's 学习 row, then the new-direction page, making nothing", async () => {
    const { screen, calls } = await workbench({
      chats: [chat({ id: "cht_a", firstSessionId: null })],
      learningDir: "~/学习",
    });
    const row = screen.getByTestId("learning-row");
    await expect.element(row).toHaveTextContent("学习");

    await row.click();

    await expect.element(row).toHaveAttribute("aria-current", "true");
    await expect.element(screen.getByTestId("learning-bar")).toHaveTextContent("学习");
    await expect.element(screen.getByText("一个方向一个目录，放在 ~/学习/ 下面")).toBeVisible();
    await screen.getByRole("button", { name: "新建方向" }).click();
    await expect.element(screen.getByTestId("learning-bar")).toHaveTextContent("学习 › 新方向");
    await expect.element(screen.getByText("想学点什么？")).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveFocus();
    expect(calls.filter((call) => call.startsWith("createDirection"))).toStrictEqual([]);
  });

  it("sends the first message: the host makes the direction, the window goes to its discussion, and the message follows", async () => {
    const { screen, calls } = await workbench();
    await screen.getByTestId("learning-row").click();
    await screen.getByRole("button", { name: "新建方向" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "我想学 Go{Enter}");

    await expect
      .poll(() => calls.filter((call) => /^(createDirection|listCommands|prompt)/.test(call)))
      .toStrictEqual(["createDirection 我想学 Go null", "listCommands new1", "prompt new1 我想学 Go"]);
    const tabs = screen.getByRole("tablist", { name: "打开的会话" });
    await expect.element(tabs.getByRole("tab", { name: "Go", exact: true })).toHaveAttribute("aria-selected", "false");
    await expect.element(tabs.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByLabelText("讨论")).toBeVisible();
    await expect.element(screen.getByTestId("learning-bar")).not.toBeInTheDocument();
  });

  it("sends what was typed in the discussion before the first message reached pi after it, in order (2026-11-09)", async () => {
    const starting = Promise.withResolvers<void>();
    const { screen, calls } = await workbench({}, { listCommands: () => starting.promise });
    await screen.getByTestId("learning-row").click();
    await screen.getByRole("button", { name: "新建方向" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "我想学 Go{Enter}");
    await expect.element(screen.getByLabelText("讨论")).toBeVisible();
    await expect.poll(() => calls.includes("listCommands new1")).toBe(true);

    // pi is still starting: the first message waits for it, and these two wait for the first.
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "第二条{Enter}");
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "第三条{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.startsWith("prompt"))).toStrictEqual([]);
    starting.resolve();

    await expect
      .poll(() => calls.filter((call) => call.startsWith("prompt")))
      .toStrictEqual(["prompt new1 我想学 Go", "prompt new1 第二条", "prompt new1 第三条"]);
  });

  it("refuses a first message for the host, before any direction is made, keeping it in the box", async () => {
    const { screen, calls } = await workbench();
    await screen.getByTestId("learning-row").click();
    await screen.getByRole("button", { name: "新建方向" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "/atrium-fast on{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("以 /atrium- 开头的消息留给 Atrium 自己用");
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveValue("/atrium-fast on");
    expect(calls.filter((call) => call.startsWith("createDirection"))).toStrictEqual([]);
  });

  it("shows 继续 for the direction opened last, a card for each, and the archived ones last; 打开 goes in", async () => {
    const { screen, calls } = await workbench({
      directions: [
        direction({ id: GO, name: "Go", lastOpenedAt: 10 }),
        direction({ id: RUST, name: "Rust", alias: "Rust 入门", lastOpenedAt: 20, pinnedAt: 5 }),
        direction({ id: SQL, name: "SQL", archived: true }),
      ],
      sessions: [session({ sessionId: "talk", containerId: RUST, study: { kind: "discuss" } })],
    });
    await screen.getByTestId("learning-row").click();

    const resume = screen.getByRole("region", { name: "继续" });
    await expect.element(resume).toHaveTextContent("继续Rust 入门讨论中还没排出阶梯打开 Rust 入门");
    await expect.element(screen.getByRole("button", { name: "继续讨论" })).not.toBeInTheDocument();
    const cards = screen.getByRole("region", { name: "全部方向" }).getByRole("group");
    await expect
      .poll(() => cards.elements().map((card) => card.getAttribute("aria-label")))
      .toStrictEqual(["Rust 入门", "Go"]);
    await expect.element(cards.first().getByLabelText("已置顶")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "全部方向" })).not.toHaveTextContent("SQL");
    await screen.getByRole("button", { name: "已归档的方向" }).click();
    await expect.element(screen.getByRole("list", { name: "已归档的方向" })).toHaveTextContent("SQL恢复");

    await resume.getByRole("button", { name: "打开 Rust 入门" }).click();

    await expect.element(screen.getByTestId("direction-home").getByRole("heading")).toHaveTextContent("Rust 入门");
    expect(calls.filter((call) => /^(selectContainer|openSession|createSession)/.test(call))).toStrictEqual([
      `selectContainer ${RUST}`,
    ]);
  });

  it("goes into a direction from anywhere on its card", async () => {
    const { screen, calls } = await workbench({ directions: [direction({ id: GO, name: "Go" })] });
    await screen.getByTestId("learning-row").click();

    // Its middle is none of its buttons.
    await screen.getByRole("group", { name: "Go" }).click();

    await expect.element(screen.getByTestId("direction-home").getByRole("heading")).toHaveTextContent("Go");
    expect(calls).toContain(`selectContainer ${GO}`);
  });

  it("asks before archiving a direction some of whose sessions run, and archives only on 归档", async () => {
    const { screen, calls } = await workbench({
      directions: [direction({ id: GO, name: "Go" })],
      sessions: [
        session({ sessionId: "talk", containerId: GO, running: true }),
        session({ sessionId: "idle", containerId: GO }),
      ],
    });
    await screen.getByTestId("learning-row").click();
    const archive = async () => {
      await screen.getByRole("button", { name: "Go 的更多操作" }).click();
      await screen.getByRole("menuitem", { name: "归档" }).click();
    };

    await archive();
    const dialog = screen.getByRole("alertdialog", { name: "归档方向「Go」？" });
    await expect
      .element(dialog)
      .toHaveTextContent(
        "归档方向「Go」？目录会移到 ~/Atrium/Learning/Archive/ 下；之后可以在“已归档的方向”里恢复其中 1 个会话正在运行，归档会停止它们取消归档",
      );
    await expect.element(dialog.getByRole("button", { name: "取消" })).toHaveFocus();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(calls.filter((call) => call.startsWith("archiveDirection"))).toStrictEqual([]);

    await archive();
    await screen.getByRole("alertdialog").getByRole("button", { name: "归档" }).click();

    await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect
      .poll(() => calls.filter((call) => call.startsWith("archiveDirection")))
      .toStrictEqual([`archiveDirection ${GO}`]);
  });

  it("pins, renames and archives a direction from its card's ···, and restores an archived one", async () => {
    const { screen, calls } = await workbench({ directions: [direction({ id: GO, name: "Go" })] });
    await screen.getByTestId("learning-row").click();
    const card = screen.getByRole("group", { name: "Go" });

    await card.getByRole("button", { name: "Go 的更多操作" }).click();
    await screen.getByRole("menuitem", { name: "置顶" }).click();
    await card.getByRole("button", { name: "Go 的更多操作" }).click();
    await screen.getByRole("menuitem", { name: "改名" }).click();
    await userEvent.fill(screen.getByRole("textbox", { name: "方向名称" }), "Go 语言");
    await userEvent.keyboard("{Enter}");
    await screen.getByRole("group", { name: "Go 语言" }).getByRole("button", { name: "Go 语言 的更多操作" }).click();
    await screen.getByRole("menuitem", { name: "归档" }).click();
    // Nothing of it runs: it goes without asking.
    await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "已归档的方向" }).click();
    await screen.getByRole("button", { name: "恢复 Go 语言" }).click();

    await expect
      .poll(() => calls.filter((call) => /Direction/.test(call)))
      .toStrictEqual([
        `pinDirection ${GO}`,
        `renameDirection ${GO} Go 语言`,
        `archiveDirection ${GO}`,
        `restoreDirection ${GO}`,
      ]);
    await expect.element(screen.getByRole("group", { name: "Go 语言" })).toBeVisible();
  });

  it("says why a restore was refused", async () => {
    const { screen } = await workbench(
      { directions: [direction({ id: GO, name: "Go", archived: true })] },
      { directionCommand: async () => Promise.reject(new CommandError("study_restore_conflict", { directionId: GO })) },
    );
    await screen.getByTestId("learning-row").click();
    await screen.getByRole("button", { name: "已归档的方向" }).click();

    await screen.getByRole("button", { name: "恢复 Go" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("原来的位置已经有同名的目录了，先把它挪走再恢复");
  });

  it("shows a direction's fixed home tab: 讨论中 and its sessions, hidden by a session tab and shown again", async () => {
    const { screen, calls } = await workbench({
      directions: [direction({ id: GO, name: "Go" })],
      sessions: [
        session({ sessionId: "talk", containerId: GO, name: "定档", study: { kind: "discuss" }, updatedAt: 1 }),
        session({ sessionId: "more", containerId: GO, name: "再聊聊", updatedAt: 2 }),
        session({ sessionId: "gone", containerId: GO, name: "旧的", archived: true }),
      ],
    });
    await screen.getByTestId("learning-row").click();
    await screen.getByRole("group", { name: "Go" }).getByRole("button", { name: "Go", exact: true }).click();

    const home = screen.getByTestId("direction-home");
    await expect.element(home.getByText("排出阶梯以后，这里显示当前一级的步骤")).toBeVisible();
    await expect
      .poll(() =>
        home
          .getByRole("list", { name: "会话" })
          .getByRole("button")
          .elements()
          .map((row) => row.firstElementChild?.nextElementSibling?.textContent),
      )
      .toStrictEqual(["再聊聊", "定档"]);
    await expect.element(home.getByRole("button", { name: "继续讨论" })).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("learning-row")).toHaveAttribute("aria-current", "true");
    const tabs = screen.getByRole("tablist", { name: "打开的会话" });
    await expect.element(tabs.getByRole("tab", { name: "Go", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.element(tabs.getByRole("button", { name: /关闭 Go/ })).not.toBeInTheDocument();

    await home.getByRole("button", { name: /定档/ }).click();

    await expect.element(screen.getByTestId("direction-home")).not.toBeInTheDocument();
    expect(calls).toContain("openSession talk");
    await expect.element(tabs.getByRole("tab", { name: /定档/ })).toHaveAttribute("aria-selected", "true");
    await expect.element(tabs.getByRole("tab", { name: "Go", exact: true })).toHaveAttribute("aria-selected", "false");
    await tabs.getByRole("tab", { name: "Go", exact: true }).click();
    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
    await expect.element(tabs.getByRole("tab", { name: /定档/ })).toHaveAttribute("aria-selected", "false");
    await tabs.getByRole("tab", { name: /定档/ }).click();
    await expect.element(screen.getByTestId("direction-home")).not.toBeInTheDocument();
    expect(calls).toContain(`selectContainer ${GO}`);
    const crumb = screen.getByRole("button", { name: "学习 › Go" });
    await expect.element(crumb.getByText("学习", { exact: true })).toHaveClass(/font-semibold/);
    await expect.element(crumb.getByText("› Go")).toHaveClass(/text-\[var\(--text-dim\)\]/);
    await crumb.click();
    await expect.element(screen.getByTestId("learning-bar")).toBeVisible();
  });

  it("goes to the home tab with ⌘1 and the brackets, and ⌘W there closes no session", async () => {
    const { screen, calls } = await workbench({
      directions: [direction({ id: GO, name: "Go" })],
      sessions: [session({ sessionId: "talk", containerId: GO, name: "定档" })],
      layout: { container: GO, tabs: { [GO]: { open: ["talk"], active: "talk" } } },
    });
    const tabs = screen.getByRole("tablist", { name: "打开的会话" });
    await expect.element(tabs.getByRole("tab", { name: /定档/ })).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Meta>}1{/Meta}");
    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
    await userEvent.keyboard("{Meta>}w{/Meta}");
    expect(calls.filter((call) => call.startsWith("closeTab"))).toStrictEqual([]);
    await userEvent.keyboard("{Meta>}2{/Meta}");
    await expect.element(screen.getByTestId("direction-home")).not.toBeInTheDocument();
    await userEvent.keyboard("{Meta>}{Shift>}[[{/Shift}{/Meta}");
    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
    await userEvent.keyboard("{Meta>}{Shift>}]{/Shift}{/Meta}");
    await expect.element(tabs.getByRole("tab", { name: /定档/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Meta>}w{/Meta}");
    await expect.poll(() => calls.filter((call) => call.startsWith("closeTab"))).toStrictEqual(["closeTab talk"]);
  });

  it("offers no new session in an archived direction", async () => {
    const { screen } = await workbench({
      directions: [direction({ id: GO, name: "Go", archived: true })],
      layout: { container: GO, tabs: {} },
    });

    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "新建会话（⌘T）" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "新建" })).not.toBeInTheDocument();
  });

  it("shows a direction with its ladder as no longer under discussion, where the learner is (ML2)", async () => {
    const progress = {
      profile: { goal: "写爬虫", language: "Go" },
      ladder: [
        { id: "l1", name: "语法", topics: "", pass: "", state: "current" as const },
        { id: "l2", name: "并发", topics: "", pass: "", state: "todo" as const },
      ],
      steps: { l1: [{ id: "s1", kind: "lesson" as const, title: "变量", lesson: null, quiz: null, done: null }] },
      gaps: [],
      finishedAt: null,
    };
    const { screen } = await workbench({
      directions: [direction({ id: GO, name: "Go", discussing: false, lastOpenedAt: 3, progress })],
    });
    await screen.getByTestId("learning-row").click();

    const card = screen.getByRole("group", { name: "Go" });
    await expect.element(card).toHaveTextContent("Go共 2 级 · 第 1 级第 1 步");
    await expect
      .element(screen.getByRole("region", { name: "继续" }))
      .toHaveTextContent("继续Go已排好阶梯共 2 级 · 第 1 级第 1 步打开 Go");
    await card.click();
    const home = screen.getByTestId("direction-home");
    await expect.element(home.getByText("写爬虫 · Go")).toBeVisible();
    await expect.element(home.getByRole("heading", { level: 1 })).toHaveTextContent("Go");
    await expect.element(home.getByText("第 1 级 · 语法").first()).toBeVisible();
    await expect.element(home.getByText("讨论中")).not.toBeInTheDocument();
  });

  it("says on a direction's home that it was made but its session could not be started", async () => {
    const { screen } = await workbench(
      {},
      {
        noDiscussion: true,
        createSession: async () => Promise.reject(new CommandError("pi_unavailable", { status: "exited" })),
      },
    );
    await screen.getByTestId("learning-row").click();
    await screen.getByRole("button", { name: "新建方向" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "我想学 Go{Enter}");

    await expect
      .element(screen.getByTestId("direction-home").getByRole("alert"))
      .toHaveTextContent("方向建好了，但没能开始会话：pi 现在用不了");
  });

  it("treats the session made when the discussion could not be as the discussion, with its line", async () => {
    const { screen, calls, views } = await workbench({}, { noDiscussion: true });
    await screen.getByTestId("learning-row").click();
    await screen.getByRole("button", { name: "新建方向" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "我想学 Go{Enter}");

    await expect
      .poll(() => calls.filter((call) => call.startsWith("createSession")))
      .toStrictEqual([`createSession ${GO}`]);
    const sessionId = "new1";
    await vi.waitFor(() => expect(views.has(sessionId)).toBe(true));
    views.get(sessionId)?.setState({ items: [doneTurn("我想学 Go")] });
    await expect
      .element(screen.getByTestId("direction-created"))
      .toHaveTextContent("建了方向 Go · ~/Atrium/Learning/go/");
  });

  it("says why an archive was refused for a name taken under Archive/", async () => {
    const { screen } = await workbench(
      { directions: [direction({ id: GO, name: "Go" })] },
      { directionCommand: async () => Promise.reject(new CommandError("study_archive_conflict", { directionId: GO })) },
    );
    await screen.getByTestId("learning-row").click();

    await screen.getByRole("button", { name: "Go 的更多操作" }).click();
    await screen.getByRole("menuitem", { name: "归档" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("Archive 里已经有同名的目录了，先把它挪走再归档");
  });

  it("offers 恢复 on an archived direction's home, and opens its sessions only to be read", async () => {
    const { screen, calls, views } = await workbench({
      directions: [direction({ id: GO, name: "Go", archived: true })],
      sessions: [session({ sessionId: "talk", containerId: GO, name: "定档" })],
      layout: { container: GO, tabs: {} },
    });

    const home = screen.getByTestId("direction-home");
    await expect.element(home.getByText("已归档")).toBeVisible();
    await expect.element(home.getByText("会话只能看，恢复以后才能接着学")).toBeVisible();
    await expect.element(home.getByRole("button", { name: "恢复" })).toBeVisible();

    await home.getByRole("button", { name: /定档/ }).click();
    await vi.waitFor(() => expect(views.has("talk")).toBe(true));
    views.get("talk")?.setState({ items: [doneTurn("先从 HTTP 讲起")] });

    await expect.element(screen.getByText("先从 HTTP 讲起")).toBeVisible();
    const bar = screen.getByRole("region", { name: "方向已归档" });
    await expect.element(bar).toHaveTextContent("这个方向已归档，恢复以后才能接着学恢复");
    await expect.element(screen.getByRole("textbox", { name: "消息" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "从这里分叉" })).not.toBeInTheDocument();
    await bar.getByRole("button", { name: "恢复" }).click();

    await expect
      .poll(() => calls.filter((call) => call.startsWith("restoreDirection")))
      .toStrictEqual([`restoreDirection ${GO}`]);
    // Restored, it goes on as any session.
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toBeVisible();
    await expect.element(bar).not.toBeInTheDocument();
  });

  it("restores an archived direction from its home", async () => {
    const { screen, calls } = await workbench({
      directions: [direction({ id: GO, name: "Go", archived: true })],
      layout: { container: GO, tabs: {} },
    });

    await screen.getByTestId("direction-home").getByRole("button", { name: "恢复" }).click();

    await expect
      .poll(() => calls.filter((call) => call.startsWith("restoreDirection")))
      .toStrictEqual([`restoreDirection ${GO}`]);
    await expect.element(screen.getByTestId("direction-home").getByText("讨论中")).toBeVisible();
  });

  it("says under a discussion's first message which direction it made, and only there", async () => {
    const { screen, views, index } = await workbench({
      learningDir: "~/学习",
      directions: [direction({ id: GO, name: "Go", dir: "/elsewhere/Learning/go" })],
      sessions: [session({ sessionId: "talk", containerId: GO, name: "定档", study: { kind: "discuss" } })],
      layout: { container: GO, tabs: { [GO]: { open: ["talk"], active: "talk" } } },
    });
    await vi.waitFor(() => expect(views.has("talk")).toBe(true));
    views.get("talk")?.setState({ items: [doneTurn("我想学 Go"), { ...doneTurn("先学什么"), id: "t2" }] });

    const line = screen.getByTestId("direction-created");
    await expect.element(line).toHaveTextContent("建了方向 Go · ~/学习/go/");
    await expect.poll(() => line.elements().length).toBe(1);
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toBeVisible();

    // Archived, it still says where it was made.
    index.setState({
      directions: [
        direction({ id: GO, name: "Go", alias: "Go 语言", archived: true, dir: "/elsewhere/Learning/Archive/go" }),
      ],
    });
    await expect.element(line).toHaveTextContent("建了方向 Go 语言 · ~/学习/go/");
    index.setState({ sessions: [session({ sessionId: "talk", containerId: GO, name: "定档" })] });
    await expect.element(line).not.toBeInTheDocument();
  });

  it("sums up directions' sessions on the 学习 row and in the inbox, leaving out an archived direction's", async () => {
    const { screen, index } = await workbench({
      directions: [direction({ id: GO, name: "Go" }), direction({ id: SQL, name: "SQL", archived: true })],
      sessions: [
        session({ sessionId: "talk", containerId: GO, name: "讨论 Go", asking: 3 }),
        session({ sessionId: "old", containerId: SQL, name: "讨论 SQL", asking: 2 }),
      ],
    });
    const row = screen.getByTestId("learning-row");

    await expect.element(row.getByRole("img", { name: "待回答" })).toBeVisible();
    const inbox = screen.getByRole("region", { name: "等你处理" });
    await inbox.getByRole("button", { name: /等你处理/ }).click();
    await expect
      .poll(() =>
        inbox
          .getByTestId("inbox-row")
          .elements()
          .map((one) => one.textContent),
      )
      .toStrictEqual([expect.stringContaining("学习 · Go")]);

    index.setState({
      sessions: [
        session({ sessionId: "talk", containerId: GO, name: "讨论 Go", running: true }),
        session({ sessionId: "old", containerId: SQL, name: "讨论 SQL", asking: 2 }),
      ],
    });
    await expect.element(row.getByRole("img", { name: "运行中" })).toBeVisible();

    index.setState({ sessions: [session({ sessionId: "old", containerId: SQL, name: "讨论 SQL", running: true })] });
    await expect.element(row.getByRole("img", { name: "运行中" })).not.toBeInTheDocument();
    await expect.element(row.getByRole("img", { name: "待回答" })).not.toBeInTheDocument();
  });
});
