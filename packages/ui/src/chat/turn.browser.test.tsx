import type { Step, Turn } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DisplayModeContext, type DisplayMode, createDisplayMode } from "../state/display-mode";
import "../styles.css";
import { NoticeView, TurnView } from "./turn-view";

const at = Date.UTC(2026, 9, 7, 14, 31);

/** A finished turn with these steps. */
function turn(steps: Step[], fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id: "t1",
    user: { text: "改一下侧栏", images: 0, clientMessageId: null, timestamp: at },
    steps,
    outcome: "done",
    error: null,
    startedAt: at,
    durationMs: 133_000,
    usage: { input: 18_000, output: 400 },
    changes: [],
    ...fields,
  };
}

const thinking: Step = { kind: "thinking", id: "0", text: "先看侧栏。再决定。", durationMs: 6_000 };
const command: Step = {
  kind: "tool",
  id: "1",
  callId: "c1",
  tool: "bash",
  args: { command: "pnpm test" },
  status: "failed",
  output: { text: "FAIL sidebar", truncated: true },
  details: { tool: "bash", command: "pnpm test" },
};
const edit: Step = {
  kind: "tool",
  id: "2",
  callId: "c2",
  tool: "edit",
  args: { path: "src/a.ts" },
  status: "done",
  output: { text: "ok", truncated: false },
  details: { tool: "edit", path: "src/a.ts", diff: " 1 keep\n-2 old\n+2 new", added: 1, removed: 1 },
};
const steer: Step = { kind: "steer", id: "3", text: "顺便加个测试" };
const answer: Step = { kind: "text", id: "4", text: "改好了，**一处**改动。" };

/**
 * Renders a turn in a display mode.
 *
 * @remarks
 * Each render gets a mode store of its own, so modes do not leak between tests.
 */
async function show(value: Turn, mode: DisplayMode = "summary", runStartedAt: number | null = null) {
  const store = createDisplayMode({ getItem: () => mode, setItem: () => undefined });
  const screen = await render(
    <DisplayModeContext value={store}>
      <TurnView turn={value} runStartedAt={runStartedAt} />
    </DisplayModeContext>,
  );
  return { screen, store };
}

/** The steps shown, by kind. */
function shownSteps(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="step"]')].map((step) => step.getAttribute("data-kind") ?? "");
}

describe("TurnView", () => {
  it("folds a finished turn's process into its header, keeping steers in view, with the reply below", async () => {
    const { screen } = await show(
      turn([thinking, command, edit, steer, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] }),
    );
    const header = screen.getByTestId("process-header");

    await expect
      .element(header)
      .toHaveTextContent("已完成，用时 2 分 13 秒 · 跑了 1 条命令 · 改了 1 个文件 · 1 条命令失败");
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    expect(shownSteps(screen.container)).toStrictEqual(["steer"]);
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("改好了，一处改动。");

    await header.click();

    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "tool", "tool", "steer"]);
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a step's detail on click: a command's output, an edit's diff", async () => {
    const { screen } = await show(turn([command, edit, answer]), "detailed");
    const details = screen.container.querySelectorAll('[data-testid="step-detail"]');

    expect(details).toHaveLength(2);
    expect(details[0]?.textContent).toBe("出错bashFAIL sidebar只保留了最后 16 KB");
    expect(
      [...screen.container.querySelectorAll('[data-testid="diff"] > div')].map((line) =>
        line.getAttribute("data-kind"),
      ),
    ).toStrictEqual(["context", "del", "add"]);
    expect(screen.container.querySelector('[data-testid="diff"]')?.textContent).toBe("1keepold2new");

    await screen.getByRole("button", { name: /运行 · pnpm test/ }).click();

    expect(screen.container.querySelectorAll('[data-testid="step-detail"]')).toHaveLength(1);
  });

  it("opens thinking in thinking mode, even folded, and says how long it took", async () => {
    const { screen } = await show(turn([thinking, command, answer]), "thinking");

    expect(shownSteps(screen.container)).toStrictEqual(["thinking"]);
    await expect.element(screen.getByRole("button", { name: /思考了 6 秒 · 先看侧栏…/ })).toBeVisible();
    expect(screen.container.querySelector('[data-testid="step-detail"]')?.textContent).toBe("先看侧栏。再决定。");
  });

  it("follows the display mode as it changes", async () => {
    const { screen, store } = await show(turn([command, answer]));
    expect(shownSteps(screen.container)).toStrictEqual([]);

    store.getState().set("detailed");

    await vi.waitFor(() => expect(shownSteps(screen.container)).toStrictEqual(["tool"]));
  });

  it("calls a process of thinking only by how long it thought", async () => {
    const { screen } = await show(turn([thinking, { ...thinking, id: "1", durationMs: 4_000 }, answer]));

    await expect.element(screen.getByTestId("process-header")).toHaveTextContent("思考了 10 秒");
  });

  it("calls untimed thinking only 思考过程", async () => {
    const { screen } = await show(turn([{ ...thinking, durationMs: null }, answer]));

    await expect.element(screen.getByTestId("process-header")).toHaveTextContent("思考过程");
  });

  it("has no header when the turn has no process", async () => {
    const { screen } = await show(turn([answer]));

    expect(screen.container.querySelector('[data-testid="process-header"]')).toBeNull();
  });

  it("shows a running turn's process open with the step going on, and no info row", async () => {
    const live: Step = { ...command, status: "running", output: { text: "running…", truncated: false } };
    const { screen } = await show(
      turn([thinking, live], { outcome: "running", durationMs: null, usage: null }),
      "summary",
      Date.now() - 5_000,
    );

    await expect.element(screen.getByTestId("process-header")).toMatchTextContent(/^进行中 · [56]s$/);
    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "tool"]);
    await expect.element(screen.getByRole("button", { name: /运行 · pnpm test 运行中/ })).toBeVisible();
    expect(screen.container.querySelector('[data-testid="step-detail"]')?.textContent).toContain("running…");
    expect(screen.container.querySelector('[data-testid="turn-footer"]')).toBeNull();
  });

  it("streams the thinking going on as 思考中, open", async () => {
    const { screen } = await show(
      turn([{ ...thinking, durationMs: null }], { outcome: "running" }),
      "summary",
      Date.now(),
    );

    await expect.element(screen.getByRole("button", { name: /思考中/ })).toBeVisible();
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-testid="step-detail"]')?.textContent).toBe("先看侧栏。再决定。"),
    );
  });

  it("marks a stopped turn", async () => {
    const { screen } = await show(turn([command], { outcome: "stopped" }));

    await expect.element(screen.getByTestId("process-header")).toMatchTextContent(/^已停止，用时 2 分 13 秒/);
    expect(screen.container.textContent).toContain("已停止");
  });

  it("shows a failed turn's error behind a toggle", async () => {
    const { screen } = await show(turn([], { outcome: "failed", error: "429 rate limited" }));

    await expect.element(screen.getByTestId("turn-error")).toHaveTextContent("回复出错展开看原始报错");
    await screen.getByRole("button", { name: "展开看原始报错" }).click();
    await expect.element(screen.getByTestId("turn-error")).toHaveTextContent("回复出错收起429 rate limited");
  });

  it("shows the info row: copy, more, files changed, usage and the time the turn ended", async () => {
    const { screen } = await show(
      turn([edit, answer], {
        changes: [
          { path: "src/a.ts", added: 1, removed: 1 },
          { path: "src/b.ts", added: null, removed: null },
        ],
      }),
    );
    const footer = screen.getByTestId("turn-footer");

    await expect.element(footer).toMatchTextContent(/^改了 2 个文件\+1−1用量 18\.4K tok\d{2}:33$/);
    await footer.getByRole("button", { name: /改了 2 个文件/ }).click();
    await expect.element(screen.getByTestId("files")).toHaveTextContent("src/a.ts+1 −1src/b.ts写入");
    await screen.getByRole("button", { name: /src\/a\.ts/ }).click();
    expect(screen.container.querySelector('[data-testid="files"] [data-testid="diff"]')?.textContent).toBe(
      "1keepold2new",
    );
  });

  it("copies the reply as shown, or as Markdown from its menu", async () => {
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      written.push(text);
    });
    const { screen } = await show(turn([answer]));

    await screen.getByRole("button", { name: "复制回复" }).click();
    await screen.getByRole("button", { name: "更多" }).click();
    await screen.getByRole("menuitem", { name: "复制为 Markdown" }).click();

    expect(written).toStrictEqual(["改好了，一处改动。", "改好了，**一处**改动。"]);
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the reply menu on Escape and on a click elsewhere", async () => {
    const { screen } = await show(turn([answer]));
    const more = screen.getByRole("button", { name: "更多" });

    await more.click();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    await more.click();
    await screen.getByTestId("reply").click();
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
  });
});

describe("NoticeView", () => {
  it("says the context was compacted and how big it was, opening pi's summary", async () => {
    const screen = await render(
      <NoticeView
        notice={{
          kind: "notice",
          id: "n1",
          notice: "compacted",
          tokensBefore: 152_000,
          summary: "**做到**一半",
          timestamp: 0,
        }}
      />,
    );
    const line = screen.getByRole("button", { name: "上下文已压缩 · 压缩前 152K tokens" });

    await line.click();

    await expect.element(screen.getByText("做到")).toBeVisible();
    await expect.element(line).toHaveAttribute("aria-expanded", "true");
  });
});
