import { CommandError } from "@atrium/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { memoryStorage } from "../state/panes";
import { pageNotices } from "../state/session-notices";
import { createWorkspaceViews, openFile, viewOf } from "../state/workspace-views";
import { PROJECT, fakeClient, session, workspace } from "../test/fake-client";
import { Breadcrumb } from "./breadcrumb";
import { ChildCapsule } from "./child-capsule";
import { askForChild, pageNewChild } from "./new-child";
import { NewChildDialog } from "./new-child-dialog";

const W = "wks_000000000000000a";
const OTHER = "wks_000000000000000b";
const CHAT = "cht_c";

afterEach(() => {
  pageNewChild().setState(null, true);
  pageNotices().setState(null, true);
});

/**
 * A child conversation of a session, in the workspace unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param sessionId - Its id, also its name.
 * @param parent - Its parent's id.
 * @param fields - Its other fields.
 * @returns The session.
 */
function child(sessionId: string, parent: string, fields: Parameters<typeof session>[0] | object = {}) {
  return session({
    sessionId,
    containerId: W,
    name: sessionId,
    parent: { sessionId: parent, by: "user" },
    ...fields,
  });
}

/**
 * Where an element is on the page, in whole pixels.
 *
 * @remarks
 * The edges the tests compare; rounding keeps sub-pixel layout from mattering.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Its top, right, bottom, left and width.
 */
function edges(element: Element) {
  const box = element.getBoundingClientRect();
  return {
    width: Math.round(box.width),
    top: Math.round(box.top),
    right: Math.round(box.right),
    bottom: Math.round(box.bottom),
    left: Math.round(box.left),
  };
}

/** The parent. */
const MAIN = session({ sessionId: "main", containerId: W, name: "重构登录" });

/** 重构登录 with four children: one running, one asking below it, one elsewhere, one handed off. */
const FAMILY = [
  MAIN,
  child("安全审查", "main", { running: true, updatedAt: Date.now() - 1000 }),
  child("补测试", "main", { containerId: OTHER, updatedAt: Date.now() - 180_000 }),
  child("边界用例", "补测试", { asking: 5, containerId: OTHER }),
  child("时区", "边界用例", { containerId: OTHER }),
  child("日志排查", "main", { handedOff: true, updatedAt: Date.now() - 3_600_000 }),
  child("旧的", "main", { archived: true }),
];

/** The list with the family, in a project's workspaces. */
const LISTED = {
  projects: [PROJECT],
  workspaces: [workspace({ id: W, branch: "main" }), workspace({ id: OTHER, branch: "atrium/tests" })],
  sessions: FAMILY,
};

describe("ChildCapsule", () => {
  it("shows nothing for a session without children", async () => {
    const { client } = fakeClient({ sessions: [session({ sessionId: "lone", containerId: W })] });
    const screen = await render(<ChildCapsule client={client} sessionId="lone" />);

    expect(screen.container.textContent).toBe("");
  });

  it("counts the children not archived and their statuses, and opens a list of them, the latest first", async () => {
    const { client } = fakeClient(LISTED);
    const screen = await render(
      <div className="relative mt-[400px] w-[680px]">
        <ChildCapsule client={client} sessionId="main" />
      </div>,
    );

    const capsule = screen.getByRole("button", { name: /^子对话 3/ });
    await expect.element(capsule).toHaveTextContent("子对话 3·1·1");
    await expect.element(capsule.getByRole("img", { name: "待回答" })).toBeInTheDocument();
    await expect.element(capsule.getByRole("img", { name: "运行中" })).toBeInTheDocument();
    await userEvent.click(capsule);

    const rows = screen.getByTestId("child-row");
    await vi.waitFor(() =>
      expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
        "安全审查刚刚",
        "补测试atrium · atrium/tests+23 分钟前",
        "日志排查已在终端中继续1 小时前",
      ]),
    );
    const list = screen.getByRole("dialog", { name: "子对话" }).element();
    expect(list.getBoundingClientRect().width).toBeLessThan(680);
  });

  it("opens a child from its row, and detaches or archives one from its menu, saying when that failed", async () => {
    const { client, calls } = fakeClient(LISTED);
    client.archiveSession = () => Promise.reject(new CommandError("internal_error"));
    const screen = await render(
      <div className="relative mt-[400px] w-[680px]">
        <ChildCapsule client={client} sessionId="main" />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^子对话 3/ }));

    await userEvent.click(screen.getByRole("button", { name: "「日志排查」的操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "脱离" }));
    await userEvent.click(screen.getByRole("button", { name: "「安全审查」的操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    await vi.waitFor(() =>
      expect(pageNotices().getState()).toStrictEqual({ sessionId: "main", text: "没能归档子对话", problem: true }),
    );
    await userEvent.click(screen.getByText("补测试"));

    await vi.waitFor(() => expect(calls).toStrictEqual(["detachSession 日志排查", "openSession 补测试"]));
    await expect.poll(() => screen.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("floats its list 8px above the capsule, its left at the capsule's, at least 300px wide", async () => {
    const { client } = fakeClient({ sessions: [MAIN, child("a", "main")] });
    const screen = await render(
      <div className="relative mt-[400px] flex w-[680px]">
        <span className="w-[120px] flex-none" />
        <ChildCapsule client={client} sessionId="main" />
      </div>,
    );
    const capsule = screen.getByRole("button", { name: /^子对话 1/ });
    await userEvent.click(capsule);
    const list = edges(screen.getByRole("dialog", { name: "子对话" }).element());
    const cap = edges(capsule.element());

    expect([cap.top - list.bottom, list.left - cap.left, list.width]).toStrictEqual([8, 0, 300]);
  });

  it("keeps its list within the bar however long a child's name", async () => {
    const { client } = fakeClient({ sessions: [MAIN, child("名字很长".repeat(30), "main")] });
    const screen = await render(
      <div className="relative mt-[400px] flex w-[680px]" data-testid="bar">
        <span className="w-[240px] flex-none" />
        <ChildCapsule client={client} sessionId="main" />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^子对话 1/ }));

    expect(edges(screen.getByRole("dialog", { name: "子对话" }).element()).right).toBe(
      edges(screen.getByTestId("bar").element()).right,
    );
  });

  it("closes its list on a press outside it and on Escape", async () => {
    const { client } = fakeClient(LISTED);
    const screen = await render(
      <div>
        <button type="button">外面</button>
        <div className="relative mt-[400px] w-[680px]">
          <ChildCapsule client={client} sessionId="main" />
        </div>
      </div>,
    );
    const capsule = screen.getByRole("button", { name: /^子对话 3/ });
    await userEvent.click(capsule);
    await userEvent.click(screen.getByRole("button", { name: "「日志排查」的操作" }));
    await expect.element(capsule).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("button", { name: "外面" }));
    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => screen.container.querySelector('[role="dialog"]')).toBeNull();
    await userEvent.click(capsule);
    await userEvent.keyboard("{Escape}");

    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => screen.container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("ChildCapsule with children the agent opened", () => {
  /** 修复 with two children its agent opened, one asking it and one with progress, and deliveries held. */
  const AGENT_FAMILY = [
    session({ sessionId: "main", containerId: W, name: "修复", heldDeliveries: 1 }),
    child("补测试", "main", {
      running: true,
      updatedAt: Date.now() - 1000,
      parent: { sessionId: "main", by: "agent" },
      heldDeliveries: 2,
      agent: {
        handle: "tests",
        role: "work",
        status: "waiting_for_parent",
        progress: "补了 3 个",
        question: "用 vitest 还是 jest？\n仓库两种都有",
        taskId: null,
        taskStartedAt: null,
      },
    }),
    child("安全审查", "main", {
      running: true,
      updatedAt: Date.now() - 60_000,
      parent: { sessionId: "main", by: "agent" },
      agent: {
        handle: "audit",
        role: "explore",
        status: "running",
        progress: "读完了 auth/",
        question: null,
        taskId: null,
        taskStartedAt: null,
      },
    }),
  ];

  it("gives each its role, its question or progress, counts the asking one as a question, and lets the held go on", async () => {
    const { client, calls } = fakeClient({ sessions: AGENT_FAMILY });
    const screen = await render(
      <div className="relative mt-[400px] w-[680px]">
        <ChildCapsule client={client} sessionId="main" />
      </div>,
    );
    const capsule = screen.getByRole("button", { name: /^子对话 2/ });
    await expect.element(capsule).toHaveTextContent("子对话 2·1·1");
    await expect.element(capsule.getByRole("img", { name: "待回答" })).toBeInTheDocument();
    await userEvent.click(capsule);

    const rows = screen.getByTestId("child-row");
    await vi.waitFor(() =>
      expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
        "补测试可写在问主 agent：用 vitest 还是 jest？刚刚",
        "安全审查只读读完了 auth/1 分钟前",
      ]),
    );
    await expect.element(rows.nth(0).getByRole("img", { name: "待回答" })).toBeInTheDocument();
    await expect.element(screen.getByTestId("deliveries-held")).toHaveTextContent("宿主重启后暂停了 3 条送达全部继续");
    await userEvent.click(screen.getByRole("button", { name: "全部继续" }));

    await vi.waitFor(() => expect(calls).toStrictEqual(["resumeDeliveries main true"]));
  });
});

describe("ChildCapsule with the workbench", () => {
  it("shows a child opened over the file its workspace showed", async () => {
    const { client, calls } = fakeClient(LISTED);
    const views = createWorkspaceViews(memoryStorage());
    openFile(views, OTHER, "src/a.ts", true);
    const screen = await render(
      <div className="relative mt-[400px] w-[680px]">
        <ChildCapsule client={client} sessionId="main" views={views} />
      </div>,
    );

    await userEvent.click(screen.getByRole("button", { name: /^子对话 3/ }));
    await userEvent.click(screen.getByText("补测试"));

    await vi.waitFor(() => expect(calls).toStrictEqual(["openSession 补测试"]));
    expect(viewOf(views.getState(), OTHER).active).toBeNull();
  });

  it("closes its list once no child is left, so the next does not open it", async () => {
    const { client } = fakeClient({ sessions: [MAIN, child("安全审查", "main")] });
    const screen = await render(
      <div className="relative mt-[400px] w-[680px]">
        <ChildCapsule client={client} sessionId="main" />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^子对话 1/ }));
    await expect.element(screen.getByRole("dialog", { name: "子对话" })).toBeInTheDocument();

    client.index.setState({ sessions: [MAIN, child("安全审查", "main", { archived: true })] });
    await expect.element(screen.getByRole("button", { name: /^子对话/ })).not.toBeInTheDocument();
    client.index.setState({ sessions: [MAIN, child("安全审查", "main"), child("补测试", "main")] });

    await expect.element(screen.getByRole("button", { name: /^子对话 2/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("Breadcrumb", () => {
  it("shows nothing for a session without a parent", async () => {
    const { client } = fakeClient(LISTED);
    const screen = await render(<Breadcrumb client={client} sessionId="main" />);

    expect(screen.container.textContent).toBe("");
  });

  it("shows the way down to a child, going back from a name", async () => {
    const { client, calls } = fakeClient(LISTED);
    const screen = await render(<Breadcrumb client={client} sessionId="边界用例" />);

    await expect
      .element(screen.getByRole("navigation", { name: "子对话的位置" }))
      .toHaveTextContent("重构登录补测试边界用例");
    await userEvent.click(screen.getByRole("button", { name: "重构登录" }));
    await vi.waitFor(() => expect(calls).toStrictEqual(["openSession main"]));
  });

  it("shows the session gone back to over the file its workspace showed", async () => {
    const { client, calls } = fakeClient(LISTED);
    const views = createWorkspaceViews(memoryStorage());
    openFile(views, W, "src/a.ts", true);
    const screen = await render(<Breadcrumb client={client} sessionId="边界用例" views={views} />);

    await userEvent.click(screen.getByRole("button", { name: "重构登录" }));

    await vi.waitFor(() => expect(calls).toStrictEqual(["openSession main"]));
    expect(viewOf(views.getState(), W).active).toBeNull();
  });

  it("folds the middle levels of a chain over three into …, which lists them", async () => {
    const { client, calls } = fakeClient(LISTED);
    const screen = await render(<Breadcrumb client={client} sessionId="时区" />);

    await expect.element(screen.getByRole("navigation")).toHaveTextContent("重构登录…边界用例时区");
    await userEvent.click(screen.getByRole("button", { name: "中间的对话" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "补测试" }));

    await vi.waitFor(() => expect(calls).toStrictEqual(["openSession 补测试"]));
  });
});

describe("NewChildDialog", () => {
  it("opens a child from a turn into the parent's workspace, named by the count of its children", async () => {
    const { client, calls } = fakeClient(LISTED);
    await render(<NewChildDialog client={client} />);

    askForChild({ parentSessionId: "main", turnId: "main:u3" });
    await expect
      .element(page.getByRole("dialog", { name: "开子对话" }).getByText("带上「重构登录」到这一轮为止的对话"))
      .toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "名字" })).toHaveValue("子对话 4");
    await userEvent.click(page.getByRole("button", { name: "开子对话" }));

    await vi.waitFor(() => expect(calls).toStrictEqual(['forkSession main main:u3 子对话 4 {"place":"same"}']));
    await vi.waitFor(() => expect(pageNewChild().getState()).toBeNull());
  });

  it("opens an empty child in a new worktree on the branch given", async () => {
    const { client, calls } = fakeClient(LISTED);
    await render(<NewChildDialog client={client} />);

    askForChild({ parentSessionId: "main", turnId: null });
    await expect.element(page.getByRole("dialog").getByText("空的子对话，挂在「重构登录」下")).toBeInTheDocument();
    await userEvent.fill(page.getByRole("textbox", { name: "名字" }), "补测试");
    await userEvent.click(page.getByRole("radio", { name: "新建 worktree" }));
    await expect
      .element(page.getByRole("textbox", { name: "分支" }))
      .toHaveValue(expect.stringMatching(/^atrium\/[a-z]+-[a-z]+$/));
    await userEvent.fill(page.getByRole("textbox", { name: "分支" }), "atrium/tests");
    await userEvent.click(page.getByRole("button", { name: "开子对话" }));

    await vi.waitFor(() =>
      expect(calls).toStrictEqual([
        `createChild ${W} {"parentSessionId":"main","name":"补测试","place":"worktree","branch":"atrium/tests"}`,
      ]),
    );
  });

  it("offers no new worktree in a project that is no git repository", async () => {
    const { client } = fakeClient({
      projects: [PROJECT],
      workspaces: [workspace({ id: W, branch: null, head: null })],
      sessions: [session({ sessionId: "main", containerId: W, name: "重构登录" })],
    });
    await render(<NewChildDialog client={client} />);

    askForChild({ parentSessionId: "main", turnId: null });
    await expect.element(page.getByRole("radio", { name: "当前工作区" })).toBeInTheDocument();
    expect(page.getByRole("radio", { name: "新建 worktree" }).elements()).toHaveLength(0);
  });

  it("offers a new worktree from a detached HEAD", async () => {
    const { client } = fakeClient({
      projects: [PROJECT],
      workspaces: [workspace({ id: W, branch: null, head: "abc1234" })],
      sessions: [session({ sessionId: "main", containerId: W, name: "重构登录" })],
    });
    await render(<NewChildDialog client={client} />);

    askForChild({ parentSessionId: "main", turnId: null });
    await expect.element(page.getByRole("radio", { name: "新建 worktree" })).toBeInTheDocument();
  });

  it("closes on a child kept though its pi failed, opens it and says it did not open well", async () => {
    const { client, calls } = fakeClient(LISTED, {
      child: () => Promise.reject(new CommandError("fork_failed", { sessionId: "kept" })),
    });
    await render(<NewChildDialog client={client} />);

    askForChild({ parentSessionId: "main", turnId: "main:u3" });
    await userEvent.click(page.getByRole("radio", { name: "新建 worktree" }));
    await userEvent.click(page.getByRole("button", { name: "开子对话" }));

    await vi.waitFor(() =>
      expect(pageNotices().getState()).toStrictEqual({ sessionId: "kept", text: "子对话没有开好", problem: true }),
    );
    expect(pageNewChild().getState()).toBeNull();
    await vi.waitFor(() => expect(calls).toContain("openSession kept"));
  });

  it("says beside the tab bar when a child in a new worktree was not told where it works", async () => {
    const { client } = fakeClient(LISTED, { unnoted: true });
    await render(<NewChildDialog client={client} />);

    askForChild({ parentSessionId: "main", turnId: "main:u3" });
    await userEvent.click(page.getByRole("radio", { name: "新建 worktree" }));
    await userEvent.click(page.getByRole("button", { name: "开子对话" }));

    await vi.waitFor(() =>
      expect(pageNotices().getState()).toStrictEqual({
        sessionId: "fork-1",
        text: "没能告诉模型换了目录",
        problem: true,
      }),
    );
    expect(pageNewChild().getState()).toBeNull();
  });

  it("offers no new worktree for a chat's session, says in the dialog why it failed, and closes on Escape", async () => {
    const { client } = fakeClient(
      { sessions: [session({ sessionId: "talk", containerId: CHAT, name: "聊聊" })] },
      { child: () => Promise.reject(new CommandError("session_busy")) },
    );
    await render(<NewChildDialog client={client} />);

    askForChild({ parentSessionId: "talk", turnId: "talk:u1" });
    await expect.element(page.getByRole("radio", { name: "当前对话" })).toBeInTheDocument();
    expect(page.getByRole("radio", { name: "新建 worktree" }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "开子对话" }));
    await expect.element(page.getByRole("alert")).toHaveTextContent("运行中不能开带上下文的子对话");
    await userEvent.keyboard("{Escape}");

    await vi.waitFor(() => expect(pageNewChild().getState()).toBeNull());
    expect(page.getByRole("dialog").elements()).toHaveLength(0);
  });
});
