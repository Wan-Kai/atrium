import type { Step, Turn } from "@atrium/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ClockContext, type UiClock } from "../state/clock";
import { DisplayModeContext, type DisplayMode, createDisplayMode } from "../state/display-mode";
import "../styles.css";
import { LoadStepContext } from "./steps";
import { NoticeView, TurnView } from "./turn-view";

const at = Date.UTC(2026, 9, 7, 14, 31);

/** A finished turn with these steps. */
function turn(steps: Step[], fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id: "t1",
    user: { text: "改一下侧栏", images: 0, clientMessageId: null, auto: false, timestamp: at },
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
  output: "FAIL sidebar",
  details: { tool: "bash", command: "pnpm test" },
  partial: false,
};
const edit: Step = {
  kind: "tool",
  id: "2",
  callId: "c2",
  tool: "edit",
  args: { path: "src/a.ts" },
  status: "done",
  output: "ok",
  details: { tool: "edit", path: "src/a.ts", diff: " 1 keep\n-2 old\n+2 new", added: 1, removed: 1 },
  partial: false,
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
  const store = createDisplayMode(mode);
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

/** The rail's nodes, in order. */
function railNodes(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="rail-node"]')].map(
    (node) => node.getAttribute("data-node") ?? "",
  );
}

/**
 * How far an element's first character starts from a left edge, to the half pixel.
 *
 * @remarks
 * For the rail's text column, which starts where the text does, not where its box does.
 *
 * @sideEffects none
 * @param element - The element.
 * @param left - The edge, in viewport pixels.
 * @returns The distance.
 * @throws {Error} When the element has no text.
 */
function textStart(element: Element, left: number): number {
  const first = document
    .createTreeWalker(element, NodeFilter.SHOW_TEXT, (node) =>
      node.textContent?.trim() === "" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
    )
    .nextNode();
  if (first === null) throw new Error("no text");
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(first, 1);
  return Math.round((range.getBoundingClientRect().left - left) * 2) / 2;
}

/**
 * How far a rail row's node sits from the row's left edge, to its centre.
 *
 * @remarks
 * Branch nodes sit off the main line; the column the text starts in follows from where they are.
 *
 * @sideEffects none
 * @param row - The row.
 * @returns The distance.
 * @throws {Error} When the row has no node.
 */
function nodeCenter(row: Element): number {
  const node = row.querySelector('[data-testid="rail-node"]');
  if (node === null) throw new Error("no node");
  const box = node.getBoundingClientRect();
  return box.left + box.width / 2 - row.getBoundingClientRect().left;
}

/**
 * How far the rail's line runs on below its last node's centre, to the pixel.
 *
 * @remarks
 * A finished rail ends at its last step, with nothing hanging below it.
 *
 * @sideEffects none
 * @param container - What the turn is rendered in.
 * @returns The distance; 0 when the line stops at the node.
 * @throws {Error} When there is no node.
 */
function railReach(container: HTMLElement): number {
  const node = [...container.querySelectorAll('[data-testid="rail-node"]')].at(-1);
  if (node === undefined) throw new Error("no node");
  const box = node.getBoundingClientRect();
  const centre = box.top + box.height / 2;
  const ends = [...container.querySelectorAll('[class*="--rail"]')].map((line) => line.getBoundingClientRect().bottom);
  return Math.max(0, Math.round(Math.max(...ends) - centre));
}

/**
 * The file chips' type marks: each one's kind and colour.
 *
 * @sideEffects none
 * @param container - What holds the chips.
 * @returns Each chip's mark, in order.
 */
function fileMarks(container: Element): string[][] {
  return [...container.querySelectorAll('[data-testid="file-chip"] [data-testid="file-mark"]')].map((mark) => [
    mark.getAttribute("data-kind") ?? "",
    getComputedStyle(mark).color,
  ]);
}

/**
 * The muted text colour of the page's theme, as computed.
 *
 * @sideEffects Adds and removes a probe element.
 * @returns The colour.
 */
function mutedColor(): string {
  const probe = document.createElement("span");
  probe.style.color = "var(--text-muted)";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** Where an element's first animation takes its height, from first frame to last. */
function heightFrames(element: Element): unknown[] {
  const effect = element.getAnimations()[0]?.effect as KeyframeEffect | undefined;
  return effect?.getKeyframes().map((frame) => frame["height"]) ?? [];
}

describe("TurnView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("folds a finished turn's process into its header, keeping steers in view, with the reply below", async () => {
    const { screen } = await show(
      turn([thinking, command, edit, steer, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] }),
    );
    const header = screen.getByTestId("process-header");

    await expect
      .element(header)
      .toHaveTextContent("已完成，用时 2 分 13 秒 · 跑了 1 条命令 · 改了 1 个文件 · 1 条命令没走通");
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    expect(shownSteps(screen.container)).toStrictEqual(["steer"]);
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("改好了，一处改动。");

    await header.click();

    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "tool", "tool", "steer"]);
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    await expect.element(header).toMatchTextContent(/^已完成，用时 2 分 13 秒$/);
  });

  it("opens a step's detail on click: a command's output, an edit's diff", async () => {
    const { screen } = await show(turn([command, edit, answer]), "detailed");
    const details = screen.container.querySelectorAll('[data-testid="step-detail"]');

    expect(details).toHaveLength(2);
    expect(details[0]?.textContent).toBe("出错bashFAIL sidebar");
    expect(
      [...screen.container.querySelectorAll('[data-testid="diff"] > div')].map((line) =>
        line.getAttribute("data-kind"),
      ),
    ).toStrictEqual(["context", "del", "add"]);
    expect(screen.container.querySelector('[data-testid="diff"]')?.textContent).toBe("1keepold2new");

    await screen.getByRole("button", { name: /^运行了 pnpm test 失败$/ }).click();

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
    const live: Step = { ...command, status: "running", output: "running…" };
    const { screen } = await show(
      turn([thinking, live], { outcome: "running", durationMs: null, usage: null }),
      "summary",
      Date.now() - 5_000,
    );

    await expect.element(screen.getByTestId("process-header")).toMatchTextContent(/^进行中 · [56]s$/);
    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "tool"]);
    await expect.element(screen.getByRole("button", { name: /^正在运行 pnpm test$/ })).toBeVisible();
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

  it("keeps thinking with nothing to show from opening, in any mode", async () => {
    const hidden: Step = { ...thinking, text: " \n" };
    const { screen } = await show(turn([hidden, command, answer]), "detailed");

    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "tool"]);
    expect(screen.getByTestId("step").first().element().textContent?.trim()).toBe("思考了 6 秒");
    expect(screen.getByRole("button", { name: /思考了/ }).elements()).toHaveLength(0);
    expect(screen.container.querySelectorAll('[data-testid="step-detail"]')).toHaveLength(1);
  });

  it("shows no empty block under thinking going on that has nothing to show yet", async () => {
    const { screen } = await show(
      turn([{ ...thinking, text: "", durationMs: null }], { outcome: "running" }),
      "summary",
      Date.now(),
    );

    await expect.element(screen.getByTestId("step")).toBeVisible();
    expect(screen.getByTestId("step").element().textContent?.trim()).toBe("思考中");
    expect(screen.getByRole("button", { name: /思考中/ }).elements()).toHaveLength(0);
    expect(screen.container.querySelector('[data-testid="step-detail"]')).toBeNull();
  });

  it("fetches a step that arrived as a preview once it is opened, and only then", async () => {
    const asked: string[] = [];
    const store = createDisplayMode("summary");
    const preview: Step = { ...command, status: "done", output: "…the end", partial: true };
    const screen = await render(
      <DisplayModeContext value={store}>
        <LoadStepContext value={(turnId, stepId) => asked.push(`${turnId}/${stepId}`)}>
          <TurnView turn={turn([preview, answer], { id: "t7" })} runStartedAt={null} />
        </LoadStepContext>
      </DisplayModeContext>,
    );
    await screen.getByTestId("process-header").click();
    expect(asked).toStrictEqual([]);

    await screen.getByRole("button", { name: /^运行了 pnpm test ✓? ?通过$/ }).click();

    expect(asked).toStrictEqual(["t7/1"]);
    await expect.element(screen.getByTestId("step-loading")).toHaveTextContent("正在加载完整内容…");
    await screen.rerender(
      <DisplayModeContext value={store}>
        <LoadStepContext value={(turnId, stepId) => asked.push(`${turnId}/${stepId}`)}>
          <TurnView
            turn={turn([{ ...preview, output: "the start…the end", partial: false }, answer], { id: "t7" })}
            runStartedAt={null}
          />
        </LoadStepContext>
      </DisplayModeContext>,
    );
    await expect.element(screen.getByTestId("step-detail")).toHaveTextContent("输出bashthe start…the end");
    expect(asked).toStrictEqual(["t7/1"]);
  });

  it("fetches a file change that arrived as a preview when the file is opened", async () => {
    const asked: string[] = [];
    const store = createDisplayMode("summary");
    const screen = await render(
      <DisplayModeContext value={store}>
        <LoadStepContext value={(turnId, stepId) => asked.push(`${turnId}/${stepId}`)}>
          <TurnView
            turn={turn([{ ...edit, partial: true }, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] })}
            runStartedAt={null}
          />
        </LoadStepContext>
      </DisplayModeContext>,
    );

    await screen
      .getByTestId("turn-footer")
      .getByRole("button", { name: /改了 1 个文件/ })
      .click();
    await screen.getByRole("button", { name: /src\/a\.ts/ }).click();

    expect(asked).toStrictEqual(["t1/2"]);
    await expect.element(screen.getByTestId("files")).toMatchTextContent(/正在加载完整内容…$/);
  });

  it("shows a turn pi went away in as failed, with no text of pi's to open", async () => {
    const { screen } = await show(turn([command], { outcome: "failed", error: null }));

    await expect.element(screen.getByTestId("turn-error")).toHaveTextContent("回复出错");
    expect(screen.container.querySelector('[data-testid="turn-error"] button')).toBeNull();
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

  it("shows the info row: copy, files changed, usage and the time the turn ended", async () => {
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

  it("copies the reply's Markdown source, from its one copy button", async () => {
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      written.push(text);
    });
    const { screen } = await show(turn([answer]));
    const footer = screen.getByTestId("turn-footer");

    await footer.getByRole("button", { name: "复制回复" }).click();

    expect(written).toStrictEqual(["改好了，**一处**改动。"]);
    expect(footer.getByRole("button").all()).toHaveLength(1);
  });

  it("draws the process on a rail: a failed command branches off, a steer joins, and it ends at the last step", async () => {
    const { screen } = await show(
      turn([thinking, command, edit, steer, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] }),
      "detailed",
    );

    expect(railNodes(screen.container)).toStrictEqual(["dot", "dead", "dot", "steer"]);
    expect(railReach(screen.container)).toBe(0);
    await expect.element(screen.getByText("完成", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^编辑了 a\.ts \+1 −1$/ })).toBeVisible();
    expect(screen.getByTestId("file-chip").element().getAttribute("title")).toBe("src/a.ts");
    await expect.element(screen.getByRole("button", { name: /^你插话 · 顺便加个测试$/ })).toBeVisible();
  });

  it("lines the header's and rows' text up 30px in, the main line's nodes at 10.5px and the branches' at 19.5px", async () => {
    const { screen } = await show(
      turn([thinking, command, edit, steer, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] }),
      "detailed",
    );
    const header = screen.getByTestId("process-header").element();
    const title = screen.getByText(/^已完成/).element();
    const rows = [...screen.container.querySelectorAll('[data-testid="step"]')];

    expect({
      header: textStart(title, header.getBoundingClientRect().left),
      rows: rows.map((row) => textStart(row, row.getBoundingClientRect().left)),
      nodes: rows.map(nodeCenter),
    }).toStrictEqual({
      header: 30,
      rows: [30, 30, 30, 30],
      nodes: [10.5, 19.5, 10.5, 19.5],
    });
  });

  it("says a stopped or failed turn in its header alone, the rail ending at the last step", async () => {
    const stopped = await show(turn([thinking, command], { outcome: "stopped" }), "detailed");
    await expect.element(stopped.screen.getByTestId("process-header")).toMatchTextContent(/^已停止，用时 2 分 13 秒$/);
    expect(railNodes(stopped.screen.container)).toStrictEqual(["dot", "dead"]);
    expect(railReach(stopped.screen.container)).toBe(0);
    await stopped.screen.unmount();

    const failed = await show(turn([thinking, edit], { outcome: "failed" }), "detailed");
    await expect.element(failed.screen.getByTestId("process-header")).toMatchTextContent(/^出错了，用时 2 分 13 秒$/);
    expect(railNodes(failed.screen.container)).toStrictEqual(["dot", "dot"]);
    expect(railReach(failed.screen.container)).toBe(0);
  });

  it("shows looking around as one row, the files read as chips, five at most", async () => {
    const reads = ["a.ts", "b.tsx", "c.md", "d.json", "Makefile", "f.ts", "a.ts"].map((path, index): Step => ({
      kind: "tool",
      id: `r${index}`,
      callId: `r${index}`,
      tool: "read",
      args: { path },
      status: "done",
      output: "",
      details: { tool: "read", path: `src/${path}`, offset: null, limit: null },
      partial: false,
    }));
    const grep: Step = { ...command, id: "g", tool: "grep", status: "done", details: null };
    const { screen } = await show(turn([...reads, grep, answer]), "detailed");

    await expect
      .element(screen.getByRole("button", { name: /^探索了代码库 · 读了 7 个文件，搜索了 1 次$/ }))
      .toBeVisible();
    await expect.element(screen.getByTestId("explored-files")).toHaveTextContent("a.tsb.tsxc.mdd.jsonMakefile+1 个");
    expect(fileMarks(screen.getByTestId("explored-files").element())).toStrictEqual([
      ["ts", "rgb(49, 120, 198)"],
      ["react", "rgb(28, 155, 189)"],
      ["md", "rgb(79, 107, 148)"],
      ["json", "rgb(183, 121, 31)"],
      ["file", mutedColor()],
    ]);
    expect(railNodes(screen.container).slice(0, 1)).toStrictEqual(["search"]);
  });

  it("holds a turn that finishes in view open a second, then folds it into its header", async () => {
    const timers = new Map<number, () => void>();
    const clock: UiClock = {
      now: () => at,
      every: () => () => undefined,
      after: (ms, run) => {
        timers.set(ms, run);
        return () => timers.delete(ms);
      },
    };
    const store = createDisplayMode("summary");
    const steps = [thinking, { ...command, status: "done" as const }];
    /** The turn, running or finished. */
    const view = (value: Turn) => (
      <ClockContext value={clock}>
        <DisplayModeContext value={store}>
          <TurnView turn={value} runStartedAt={at} />
        </DisplayModeContext>
      </ClockContext>
    );
    const screen = await render(view(turn(steps, { outcome: "running", durationMs: null })));

    await screen.rerender(view(turn([...steps, answer])));

    const header = screen.getByTestId("process-header");
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "tool"]);
    expect([...timers.keys()]).toStrictEqual([1000]);

    timers.get(1000)?.();

    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("process").element().getAttribute("data-fold")).toBe("closing");
    await vi.waitFor(() => expect(shownSteps(screen.container)).toStrictEqual([]), { timeout: 3000 });
    await expect.element(screen.getByTestId("process-summary")).toHaveTextContent("· 跑了 1 条命令");
    expect(screen.getByTestId("process-summary").element().classList).toContain("atrium-fold-summary");
    const summary = getComputedStyle(screen.getByTestId("process-summary").element());
    expect([summary.animationDuration, summary.animationDelay]).toStrictEqual(["0.26s", "0.16s"]);
  });

  it("forgets the second's hold when the turn goes away, or when its header is clicked first", async () => {
    const timers = new Set<() => void>();
    const clock: UiClock = {
      now: () => at,
      every: () => () => undefined,
      after: (_ms, run) => {
        timers.add(run);
        return () => timers.delete(run);
      },
    };
    const store = createDisplayMode("summary");
    /** The turn, running or finished. */
    const view = (value: Turn) => (
      <ClockContext value={clock}>
        <DisplayModeContext value={store}>
          <TurnView turn={value} runStartedAt={at} />
        </DisplayModeContext>
      </ClockContext>
    );
    const screen = await render(view(turn([thinking], { outcome: "running", durationMs: null })));
    await screen.rerender(view(turn([thinking, answer])));
    expect(timers.size).toBe(1);

    await screen.getByTestId("process-header").click();

    expect(timers.size).toBe(0);
    await expect.element(screen.getByTestId("process-header")).toHaveAttribute("aria-expanded", "false");
    await screen.rerender(view(turn([thinking, answer], { id: "t2", outcome: "running" })));
    await screen.rerender(view(turn([thinking, answer], { id: "t2" })));
    expect(timers.size).toBe(1);
    await screen.unmount();
    expect(timers.size).toBe(0);
  });

  it("unfolds a folded process from nothing, and folds it from where it is", async () => {
    const { screen } = await show(turn([command, edit, answer]), "summary");
    const header = screen.getByTestId("process-header");
    /** Where the process's height animation starts and ends. */
    const heights = () => heightFrames(screen.getByTestId("process").element());

    await header.click();

    expect(heights()?.[0]).toBe("0px");
    expect(heights()?.[1]).not.toBe("0px");

    await header.click();

    expect(heights()?.[0]).not.toBe("0px");
    expect(heights()?.[1]).toBe("0px");
  });

  it("folds and unfolds in 0.4 s, the rows a little quicker", async () => {
    const { screen } = await show(turn([command, edit, answer]), "summary");
    const header = screen.getByTestId("process-header");
    /** How long the process's height and each row take, and when each row starts. */
    const timings = () =>
      [screen.getByTestId("process").element(), ...screen.container.querySelectorAll("[data-rail-row]")].map(
        (element) => {
          const timing = element.getAnimations()[0]?.effect?.getTiming();
          return [timing?.duration, timing?.delay];
        },
      );

    await header.click();

    expect(timings()).toStrictEqual([
      [400, 0],
      [260, 40],
      [260, 54],
    ]);

    await header.click();

    expect(timings()).toStrictEqual([
      [400, 40],
      [220, 14],
      [220, 0],
    ]);
  });

  it("folds at once when less motion is asked for", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query === "(prefers-reduced-motion: reduce)" }) as MediaQueryList,
    );
    const { screen } = await show(turn([command, answer]), "summary");
    await screen.getByTestId("process-header").click();
    expect(shownSteps(screen.container)).toStrictEqual(["tool"]);

    await screen.getByTestId("process-header").click();

    expect(shownSteps(screen.container)).toStrictEqual([]);
  });

  it("plays the entrance of steps that arrive while shown, not of those already there", async () => {
    const store = createDisplayMode("summary");
    /** The running turn with these steps. */
    const view = (steps: Step[]) => (
      <DisplayModeContext value={store}>
        <TurnView turn={turn(steps, { outcome: "running", durationMs: null })} runStartedAt={at} />
      </DisplayModeContext>
    );
    const screen = await render(view([thinking]));

    await screen.rerender(view([thinking, { ...command, status: "running" }]));

    expect(
      [...screen.container.querySelectorAll('[data-testid="step"]')].map((step) =>
        step.classList.contains("atrium-step-enter"),
      ),
    ).toStrictEqual([false, true]);
    expect(railNodes(screen.container)).toStrictEqual(["dot", "live"]);
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
