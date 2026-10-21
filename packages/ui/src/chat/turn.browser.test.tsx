import type { Step, Turn } from "@atrium/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "vitest-browser-react";
import { ClockContext, type UiClock } from "../state/clock";
import { Key, Sparkle, Warning } from "../design/icons";
import "../styles.css";
import { LoadStepContext } from "./steps";
import { OpenFileContext } from "./file-opener";
import { NoticeView, OpenLogin, TurnView } from "./turn-view";

const at = Date.UTC(2026, 9, 7, 14, 31);

/** A finished turn with these steps. */
function turn(steps: Step[], fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id: "t1",
    source: null,
    user: { text: "改一下侧栏", images: 0, clientMessageId: null, auto: false, command: null, timestamp: at },
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
const compaction: Step = {
  kind: "compaction",
  id: "5",
  tokensBefore: 152_000,
  tokensAfter: 41_000,
  summary: "**做到**一半",
  reason: "threshold",
};
const answer: Step = { kind: "text", id: "4", text: "改好了，**一处**改动。" };

/**
 * Renders a turn.
 *
 * @sideEffects Renders into the page.
 * @param value - The turn.
 * @param runStartedAt - When its run started, for a running turn.
 * @returns The screen.
 */
async function show(value: Turn, runStartedAt: number | null = null) {
  const screen = await render(<TurnView turn={value} runStartedAt={runStartedAt} />);
  return { screen };
}

/**
 * Renders a turn whose files open where `opens` says, its process open, and what was opened.
 *
 * @sideEffects Renders into the page and clicks the process open.
 * @param value - The turn.
 * @param opens - Whether a path can be opened.
 * @returns The screen, and the paths opened so far.
 */
async function withOpener(value: Turn, opens: (path: string) => boolean) {
  const openedPaths: string[] = [];
  /**
   * How a chip opens its file, where `opens` lets it.
   *
   * @sideEffects none; the action it returns records the path.
   * @param path - The chip's path.
   * @returns What opens it, or null.
   */
  const opener = (path: string) => (opens(path) ? () => openedPaths.push(path) : null);
  const screen = await render(
    <OpenFileContext value={opener}>
      <TurnView turn={value} runStartedAt={null} />
    </OpenFileContext>,
  );
  await screen.getByTestId("process-header").click();
  return { screen, openedPaths };
}

/** A button's text and background colours, as computed. */
function paint(button: Element): string[] {
  const style = getComputedStyle(button);
  return [style.color, style.backgroundColor];
}

/**
 * Renders a finished turn with its process and every step opened, as a click on each would.
 *
 * @remarks
 * What the detailed display mode showed before M1.11 took the modes out (SPEC-0001, "过程的显
 * 示"); waits for the unfolding to finish so what is measured has settled.
 *
 * @sideEffects Renders into the page and clicks in it.
 * @param value - The turn.
 * @returns The screen.
 */
async function opened(value: Turn) {
  const { screen } = await show(value);
  await screen.getByTestId("process-header").click();
  // Opening a row can bring rows of its own, so open until none is left closed.
  const closed = (): HTMLButtonElement | null =>
    screen.container.querySelector<HTMLButtonElement>('[data-testid="step"] > button[aria-expanded="false"]');
  for (let toggle = closed(); toggle !== null; toggle = closed()) {
    toggle.click();
    await new Promise(requestAnimationFrame);
  }
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  return { screen };
}

/**
 * Where an element's first drawn shape starts, in viewport pixels.
 *
 * @remarks
 * For an icon, whose box is wider than what it draws.
 *
 * @sideEffects none
 * @param element - What holds the icon.
 * @returns The left edge of the icon's first path.
 * @throws {Error} When there is no path.
 */
function drawnLeft(element: Element): number {
  const path = element.querySelector("svg path");
  if (path === null) throw new Error("no path");
  return path.getBoundingClientRect().left;
}

/**
 * A running turn with these steps, as the transcript renders it.
 *
 * @sideEffects none
 * @param steps - The steps.
 * @returns The element.
 */
function runningView(steps: Step[]) {
  return <TurnView turn={turn(steps, { outcome: "running", durationMs: null })} runStartedAt={at} />;
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
 * The file chips' type icons, as shown.
 *
 * @remarks
 * A chip holds a light and a dark variant where the theme has both; only the one shown counts.
 *
 * @sideEffects none
 * @param container - What holds the chips.
 * @returns Each chip's icon, in order.
 */
function fileIcons(container: Element): string[] {
  return [...container.querySelectorAll('[data-testid="file-chip"] [data-testid="file-icon"]')]
    .filter((icon) => getComputedStyle(icon).display !== "none")
    .map((icon) => icon.getAttribute("data-icon") ?? "");
}

/** Where an element's first animation takes its height, from first frame to last. */
function heightFrames(element: Element): unknown[] {
  const effect = element.getAnimations()[0]?.effect as KeyframeEffect | undefined;
  return effect?.getKeyframes().map((frame) => frame["height"]) ?? [];
}

/**
 * A colour as the browser computes it.
 *
 * @remarks
 * CSS variables hold colours as written; an element's computed colour is `rgb(…)`.
 *
 * @sideEffects Adds and removes an element.
 * @param value - The colour as written.
 * @returns It as computed.
 */
function colorOf(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value.trim();
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/**
 * An icon's SVG as it renders.
 *
 * @sideEffects none
 * @param icon - The icon.
 * @returns Its markup.
 */
function iconMarkup(icon: ReactElement): string {
  return renderToStaticMarkup(icon);
}

/**
 * How far each press class shrinks a button held down, and which it leaves alone, as the style
 * sheet says.
 *
 * @remarks
 * A test cannot hold a button down, so it reads the rules (design-language, "动效 · 按下的实体感").
 *
 * @sideEffects none
 * @returns The scale of each class while pressed, then what the rule leaves out.
 */
function pressedScales(): Record<string, string> {
  const scales: Record<string, string> = {};
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const pressed = /^\.(atrium-press(?:-sm|-row)?):active/u.exec(rule.selectorText);
      if (pressed?.[1] !== undefined && rule.style.scale !== "") {
        scales[pressed[1]] = `${rule.style.scale} ${rule.selectorText.slice(pressed[0].length)}`;
      }
    }
  }
  return scales;
}

/** What a press rule leaves out: a button disabled either way. */
const NOT_DISABLED = ':not(:disabled, [aria-disabled="true"])';

/**
 * The press classes an element has.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Its press classes.
 */
function pressOf(element: Element): string[] {
  return ["atrium-press-sm", "atrium-press", "atrium-press-row"].filter((name) => element.classList.contains(name));
}

/**
 * A value the test knows is there.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns It.
 * @throws {Error} When it is not there.
 */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
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
    const { screen } = await opened(turn([command, edit, answer]));
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

  it("shows a running turn's process open with the step going on, its detail shut until clicked, and no info row", async () => {
    const live: Step = { ...command, status: "running", output: "running…" };
    const { screen } = await show(
      turn([thinking, live], { outcome: "running", durationMs: null, usage: null }),
      Date.now() - 5_000,
    );

    await expect.element(screen.getByTestId("process-header")).toMatchTextContent(/^进行中 · [56]s$/);
    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "tool"]);
    const going = screen.getByRole("button", { name: /^正在运行 pnpm test$/ });
    await expect.element(going).toHaveAttribute("aria-expanded", "false");
    // Opening on its own and shutting when done made the view jump at every step.
    expect(screen.container.querySelectorAll('[data-testid="step-detail"]')).toHaveLength(0);
    expect(screen.container.querySelector('[data-testid="turn-footer"]')).toBeNull();

    await going.click();
    await expect.element(going).toHaveAttribute("aria-expanded", "true");
    expect(screen.container.querySelector('[data-testid="step-detail"]')?.textContent).toContain("running…");
  });

  it("streams the thinking going on as 思考中 once opened", async () => {
    const { screen } = await show(turn([{ ...thinking, durationMs: null }], { outcome: "running" }), Date.now());
    const going = screen.getByRole("button", { name: /思考中/ });

    await expect.element(going).toBeVisible();
    expect(screen.container.querySelectorAll('[data-testid="step-detail"]')).toHaveLength(0);
    await going.click();
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-testid="step-detail"]')?.textContent).toBe("先看侧栏。再决定。"),
    );
  });

  it("omits blank thinking while keeping tools and their details", async () => {
    const hidden: Step = { ...thinking, text: " \n" };
    const { screen } = await opened(turn([hidden, command, answer]));

    expect(shownSteps(screen.container)).toStrictEqual(["tool"]);
    expect(screen.getByRole("button", { name: /思考了/ }).elements()).toHaveLength(0);
    expect(screen.container.querySelectorAll('[data-testid="step-detail"]')).toHaveLength(1);
  });

  it("waits without blank thinking or reply placeholders, then reveals nonblank content", async () => {
    const hidden = { ...thinking, text: "", durationMs: null };
    const screen = await render(runningView([hidden, { ...answer, text: " \n" }]));

    await expect.element(screen.getByTestId("run-waiting")).toMatchTextContent(/进行中/);
    expect(shownSteps(screen.container)).toStrictEqual([]);
    expect(screen.container.querySelector('[data-testid="process-header"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="reply"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="step-detail"]')).toBeNull();

    await screen.rerender(runningView([thinking]));
    expect(shownSteps(screen.container)).toStrictEqual(["thinking"]);
    expect(screen.container.querySelector('[data-testid="run-waiting"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="reply"]')).toBeNull();
    await screen.getByRole("button", { name: /思考中/ }).click();
    await expect.element(screen.getByTestId("step-detail")).toHaveTextContent("先看侧栏。再决定。");

    await screen.rerender(runningView([thinking, answer]));
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("改好了，一处改动。");
  });

  it.each([
    { steps: [] },
    {
      steps: [
        { ...thinking, text: " \n" },
        { ...answer, text: "" },
      ],
    },
  ])("leaves a normal empty end without a reply or footer: $steps", async ({ steps }) => {
    const { screen } = await show(turn(steps));

    expect(screen.container.textContent).toContain("改一下侧栏");
    expect(shownSteps(screen.container)).toStrictEqual([]);
    expect(screen.container.querySelector('[data-testid="reply"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="process-header"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="turn-footer"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="turn-error"]')).toBeNull();
    expect(screen.getByRole("button", { name: "重试", exact: true }).elements()).toHaveLength(0);
  });

  it("keeps a tool-only run visible without an empty reply or error", async () => {
    const { screen } = await show(
      turn(
        [
          { ...thinking, text: "" },
          { ...command, status: "running" },
          { ...answer, text: "" },
        ],
        {
          outcome: "running",
        },
      ),
    );

    expect(shownSteps(screen.container)).toStrictEqual(["tool"]);
    await expect.element(screen.getByRole("button", { name: /正在运行 pnpm test/ })).toBeVisible();
    expect(screen.container.querySelector('[data-testid="reply"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="turn-error"]')).toBeNull();
  });

  it("keeps connection errors and cancellation distinct from blank thinking", async () => {
    const blank: Step[] = [
      { ...thinking, text: "" },
      { ...answer, text: " \n" },
    ];
    const retried: string[] = [];
    const screen = await render(
      <TurnView
        turn={turn(blank, { outcome: "failed", error: "Connection disconnected" })}
        runStartedAt={null}
        onRetry={() => retried.push("retry")}
      />,
    );

    await expect.element(screen.getByTestId("turn-error")).toMatchTextContent(/回复出错/);
    expect(shownSteps(screen.container)).toStrictEqual([]);
    expect(screen.container.querySelector('[data-testid="reply"]')).toBeNull();
    await screen.getByRole("button", { name: "详情", exact: true }).click();
    expect(screen.container.textContent).toContain("Connection disconnected");
    expect(retried).toStrictEqual([]);
    await screen.getByRole("button", { name: "重试", exact: true }).click();
    expect(retried).toStrictEqual(["retry"]);

    await screen.rerender(<TurnView turn={turn(blank, { outcome: "stopped" })} runStartedAt={null} />);
    expect(screen.container.textContent).toContain("已停止");
    expect(shownSteps(screen.container)).toStrictEqual([]);
    expect(screen.container.querySelector('[data-testid="turn-error"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="reply"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="turn-footer"]')).toBeNull();
  });

  it.each([
    ["stopped", "已停止"],
    ["failed", "出错了"],
  ] as const)("keeps %s ahead of a thinking-only header", async (outcome, label) => {
    const { screen } = await show(turn([thinking], { outcome }));

    await expect.element(screen.getByTestId("process-header")).toHaveTextContent(`${label}，用时 2 分 13 秒`);
  });

  it("fetches a step that arrived as a preview once it is opened, and only then", async () => {
    const asked: string[] = [];
    const preview: Step = { ...command, status: "done", output: "…the end", partial: true };
    const screen = await render(
      <LoadStepContext value={(turnId, stepId) => asked.push(`${turnId}/${stepId}`)}>
        <TurnView turn={turn([preview, answer], { id: "t7" })} runStartedAt={null} />
      </LoadStepContext>,
    );
    await screen.getByTestId("process-header").click();
    expect(asked).toStrictEqual([]);

    await screen.getByRole("button", { name: /^运行了 pnpm test ✓? ?通过$/ }).click();

    expect(asked).toStrictEqual(["t7/1"]);
    await expect.element(screen.getByTestId("step-loading")).toHaveTextContent("正在加载完整内容…");
    await screen.rerender(
      <LoadStepContext value={(turnId, stepId) => asked.push(`${turnId}/${stepId}`)}>
        <TurnView
          turn={turn([{ ...preview, output: "the start…the end", partial: false }, answer], { id: "t7" })}
          runStartedAt={null}
        />
      </LoadStepContext>,
    );
    await expect.element(screen.getByTestId("step-detail")).toHaveTextContent("输出bashthe start…the end");
    expect(asked).toStrictEqual(["t7/1"]);
  });

  it("fetches a file change that arrived as a preview when the file is opened", async () => {
    const asked: string[] = [];
    const screen = await render(
      <LoadStepContext value={(turnId, stepId) => asked.push(`${turnId}/${stepId}`)}>
        <TurnView
          turn={turn([{ ...edit, partial: true }, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] })}
          runStartedAt={null}
        />
      </LoadStepContext>,
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

  it("shows a failed turn's error behind 详情 at the line's right end, its chevron turning down", async () => {
    const { screen } = await show(turn([], { outcome: "failed", error: "429 rate limited" }));
    const card = screen.getByTestId("turn-error");
    const details = screen.getByRole("button", { name: "详情" });

    await expect.element(card).toHaveTextContent("回复出错详情");
    expect(details.element().getBoundingClientRect().right).toBe(card.element().getBoundingClientRect().right);
    const chevron = details.element().querySelector(".atrium-fold-chevron") as Element;
    expect(getComputedStyle(chevron).rotate).toBe("none");
    await details.click();

    await expect.element(details).toHaveAttribute("aria-expanded", "true");
    await expect.element(card).toHaveTextContent("回复出错详情429 rate limited");
    for (const transition of chevron.getAnimations()) transition.finish();
    expect(getComputedStyle(chevron).rotate).toBe("90deg");
  });

  it("shows a failure that looks like a credentials problem with the sidebar's key, offering 去登录 before 重试", async () => {
    const asked: string[] = [];
    const failed = turn([], { outcome: "failed", error: "OAuth refresh failed for anthropic: invalid_grant" });
    const screen = await render(
      <OpenLogin value={() => asked.push("login")}>
        <TurnView turn={failed} runStartedAt={null} onRetry={() => asked.push("retry")} />
      </OpenLogin>,
    );
    const card = screen.getByTestId("turn-error");

    await expect.element(card).toHaveTextContent("登录已失效去登录重试详情");
    expect(card.element().querySelector("svg")?.outerHTML).toBe(iconMarkup(<Key size={14} />));
    const root = getComputedStyle(document.documentElement);
    expect(getComputedStyle(card.element()).color).toBe(colorOf(root.getPropertyValue("--attn")));
    // 去登录 is the one main button; 重试 is plain text.
    expect([
      paint(screen.getByRole("button", { name: "去登录" }).element()),
      paint(screen.getByRole("button", { name: "重试" }).element()),
    ]).toStrictEqual([
      [colorOf(root.getPropertyValue("--attn-text")), colorOf(root.getPropertyValue("--attn-soft"))],
      [colorOf(root.getPropertyValue("--text-muted")), "rgba(0, 0, 0, 0)"],
    ]);
    await screen.getByRole("button", { name: "去登录" }).click();
    await screen.getByRole("button", { name: "重试" }).click();
    expect(asked).toStrictEqual(["login", "retry"]);
  });

  it("offers 去登录 only where 重试 is, and only with settings to open; other failures stay red", async () => {
    const auth = turn([], { outcome: "failed", error: "No API key found for anthropic." });
    const screen = await render(
      <OpenLogin value={() => undefined}>
        <TurnView turn={auth} runStartedAt={null} />
      </OpenLogin>,
    );
    await expect.element(screen.getByTestId("turn-error")).toHaveTextContent("登录已失效详情");

    await screen.rerender(<TurnView turn={auth} runStartedAt={null} onRetry={() => undefined} />);
    await expect.element(screen.getByTestId("turn-error")).toHaveTextContent("登录已失效重试详情");
    expect(paint(screen.getByRole("button", { name: "重试" }).element())).toStrictEqual([
      colorOf(getComputedStyle(document.documentElement).getPropertyValue("--attn-text")),
      colorOf(getComputedStyle(document.documentElement).getPropertyValue("--attn-soft")),
    ]);

    const other = turn([], { outcome: "failed", error: "429 rate limited" });
    await screen.rerender(
      <OpenLogin value={() => undefined}>
        <TurnView turn={other} runStartedAt={null} onRetry={() => undefined} />
      </OpenLogin>,
    );
    const card = screen.getByTestId("turn-error");
    await expect.element(card).toHaveTextContent("回复出错重试详情");
    expect(card.element().querySelector("svg")?.outerHTML).toBe(iconMarkup(<Warning size={14} />));
    const root = getComputedStyle(document.documentElement);
    expect(getComputedStyle(card.element()).color).toBe(colorOf(root.getPropertyValue("--danger")));
    expect(paint(screen.getByRole("button", { name: "重试" }).element())).toStrictEqual([
      colorOf(root.getPropertyValue("--danger")),
      colorOf(root.getPropertyValue("--danger-soft")),
    ]);
  });

  it("ends a failed turn with no reply and no changes at its error, leaving the info row out", async () => {
    const { screen } = await show(turn([command], { outcome: "failed", error: "429 rate limited" }));
    await expect.element(screen.getByTestId("turn-error")).toBeVisible();
    expect(screen.container.querySelector('[data-testid="turn-footer"]')).toBeNull();

    await screen.rerender(
      <TurnView turn={turn([command, answer], { outcome: "failed", error: "429" })} runStartedAt={null} />,
    );
    await expect.element(screen.getByTestId("turn-footer").getByRole("button", { name: "复制回复" })).toBeVisible();
    await screen.rerender(
      <TurnView
        turn={turn([edit], { outcome: "failed", error: "429", changes: [{ path: "src/a.ts", added: 1, removed: 1 }] })}
        runStartedAt={null}
      />,
    );
    await expect.element(screen.getByTestId("turn-footer")).toMatchTextContent(/^改了 1 个文件/);
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

  it("starts a message that started with a skill with its tag, copying it as it was typed", async () => {
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      written.push(text);
    });
    const plain = turn([answer]);
    const { screen } = await show({ ...plain, user: { ...plain.user, command: { kind: "skill", name: "review" } } });
    const tag = screen.getByTestId("command-tag");
    const icon = tag.element().querySelector("svg");

    expect(screen.getByTestId("user-text").element().textContent).toBe("skill:review改一下侧栏");
    expect([
      tag.element().getBoundingClientRect().height,
      icon?.outerHTML,
      getComputedStyle(icon as Element).color,
    ]).toStrictEqual([22, iconMarkup(<Sparkle size={14} />), colorOf("var(--ctx-tools)")]);
    await screen.getByTestId("user-message").getByRole("button", { name: "复制" }).click();
    expect(written).toStrictEqual(["/skill:review 改一下侧栏"]);
  });

  it("has no tag on a message typed as it is", async () => {
    const { screen } = await show(turn([answer]));

    expect(screen.getByTestId("user-text").element().textContent).toBe("改一下侧栏");
    expect(screen.getByTestId("command-tag").elements()).toHaveLength(0);
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

  it("shows a check for 2 seconds once copied, from each copy, and nothing when the clipboard refuses", async () => {
    const runs: (() => void)[] = [];
    const clock: UiClock = {
      now: () => at,
      every: () => () => undefined,
      after: (_ms, run) => {
        runs.push(run);
        return () => undefined;
      },
    };
    const written = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const screen = await render(
      <ClockContext value={clock}>
        <TurnView turn={turn([answer])} runStartedAt={null} />
      </ClockContext>,
    );
    const copy = screen.getByTestId("turn-footer").getByRole("button", { name: "复制回复" });

    await copy.click();
    await expect.element(copy).toHaveAttribute("title", "已复制");
    await expect.element(copy).toHaveAttribute("data-copied", "true");
    runs.at(-1)?.();
    await expect.element(copy).toHaveAttribute("title", "复制回复");
    written.mockRejectedValue(new Error("denied"));
    await copy.click();

    await expect.element(copy).toHaveAttribute("data-copied", "false");
    expect(runs).toHaveLength(1);
  });

  it("gives each button a press: small ones shrink most, rows least, and the files' caret turns smoothly", async () => {
    const { screen } = await show(
      turn([thinking, command, edit, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] }),
    );
    const footer = screen.getByTestId("turn-footer");
    const files = footer.getByRole("button", { name: /改了 1 个文件/ });

    expect(
      [
        footer.getByRole("button", { name: "复制回复" }).element(),
        files.element(),
        screen.getByTestId("process-header").element(),
      ].map(pressOf),
    ).toStrictEqual([["atrium-press-sm"], ["atrium-press"], ["atrium-press-row"]]);
    expect(pressedScales()).toStrictEqual({
      "atrium-press-sm": `0.9 ${NOT_DISABLED}`,
      "atrium-press": `0.95 ${NOT_DISABLED}`,
      "atrium-press-row": `0.985 ${NOT_DISABLED}`,
    });
    expect(getComputedStyle(present(files.element().querySelector("svg:last-of-type"))).transitionProperty).toBe(
      "rotate",
    );
  });

  it("draws the process on a rail: a failed command branches off, a steer joins, and it ends at the last step", async () => {
    const { screen } = await opened(
      turn([thinking, command, edit, steer, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] }),
    );

    expect(railNodes(screen.container)).toStrictEqual(["dot", "dead", "dot", "steer"]);
    expect(railReach(screen.container)).toBe(0);
    await expect.element(screen.getByText("完成", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^编辑了 a\.ts \+1 −1$/ })).toBeVisible();
    expect(screen.getByTestId("file-chip").element().getAttribute("title")).toBe("src/a.ts");
    await expect.element(screen.getByRole("button", { name: /^你插话 · 顺便加个测试$/ })).toBeVisible();
  });

  it("lines the rows' text up 30px in, the main line's nodes at 10.5px and the branches' at 19.5px", async () => {
    const { screen } = await opened(
      turn([thinking, command, edit, steer, answer], { changes: [{ path: "src/a.ts", added: 1, removed: 1 }] }),
    );
    const header = screen.getByTestId("process-header").element();
    const title = screen.getByText(/^已完成/).element();
    const rows = [...screen.container.querySelectorAll('[data-testid="step"]')];

    expect({
      header: textStart(title, header.getBoundingClientRect().left),
      rows: rows.map((row) => textStart(row, row.getBoundingClientRect().left)),
      nodes: rows.map(nodeCenter),
    }).toStrictEqual({
      header: 14.5,
      rows: [30, 30, 30, 30],
      nodes: [10.5, 19.5, 10.5, 19.5],
    });
  });

  it("starts the folded header's arrow at the reply's left edge, the title 6px after it", async () => {
    const { screen } = await show(turn([thinking, command, answer]));
    const header = screen.getByTestId("process-header").element();
    const left = header.getBoundingClientRect().left;

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect({
      arrow: Math.round(drawnLeft(header) - left),
      title: textStart(screen.getByText(/^已完成/).element(), left),
      reply: Math.round(screen.getByTestId("reply").element().getBoundingClientRect().left - left),
    }).toStrictEqual({ arrow: 0, title: 14.5, reply: 0 });
  });

  it('starts the running cat at the reply\'s left edge and "进行中" 24px in', async () => {
    const live: Step = { ...command, status: "running", output: "running…" };
    const { screen } = await show(
      turn([thinking, live], { outcome: "running", durationMs: null, usage: null }),
      Date.now(),
    );
    const status = screen.getByTestId("run-status").element();
    const left = screen.getByTestId("process-header").element().getBoundingClientRect().left;

    expect({
      cat: Math.round(screen.getByTestId("run-cat").element().getBoundingClientRect().left - left),
      text: textStart(status, left),
    }).toStrictEqual({ cat: 0, text: 24 });
  });

  it("says a stopped or failed turn in its header alone, the rail ending at the last step", async () => {
    const stopped = await opened(turn([thinking, command], { outcome: "stopped" }));
    await expect.element(stopped.screen.getByTestId("process-header")).toMatchTextContent(/^已停止，用时 2 分 13 秒$/);
    expect(railNodes(stopped.screen.container)).toStrictEqual(["dot", "dead"]);
    expect(railReach(stopped.screen.container)).toBe(0);
    await stopped.screen.unmount();

    const failed = await opened(turn([thinking, edit], { outcome: "failed" }));
    await expect.element(failed.screen.getByTestId("process-header")).toMatchTextContent(/^出错了，用时 2 分 13 秒$/);
    expect(railNodes(failed.screen.container)).toStrictEqual(["dot", "dot"]);
    expect(railReach(failed.screen.container)).toBe(0);
  });

  it("opens an edited file from its chip without opening the row, the rest of the row opening it", async () => {
    const { screen, openedPaths } = await withOpener(turn([edit, answer]), () => true);
    const row = screen.getByRole("button", { name: /^编辑了/ });
    const chip = screen.getByTestId("file-chip");

    await chip.click();

    expect([openedPaths, row.element().getAttribute("aria-expanded")]).toStrictEqual([["src/a.ts"], "false"]);
    await row.click({ position: { x: 300, y: 10 } });
    await expect.element(row).toHaveAttribute("aria-expanded", "true");
    expect(openedPaths).toStrictEqual(["src/a.ts"]);
  });

  it("keeps a chip its opener turns down a plain chip, its row one button", async () => {
    const { screen } = await withOpener(turn([edit, answer]), () => false);

    await expect.element(screen.getByTestId("file-chip")).toBeVisible();

    expect([
      screen.getByTestId("file-chip").element().tagName,
      screen
        .getByRole("button", { name: /^编辑了/ })
        .element()
        .closest('[data-testid="step"] > button') !== null,
    ]).toStrictEqual(["SPAN", true]);
  });

  it("opens a read file from an explore row's chip without opening the row", async () => {
    const read: Step = {
      kind: "tool",
      id: "r",
      callId: "r",
      tool: "read",
      args: { path: "src/b.ts" },
      status: "done",
      output: "",
      details: { tool: "read", path: "src/b.ts", offset: null, limit: null },
      partial: false,
    };
    const { screen, openedPaths } = await withOpener(turn([read, { ...read, id: "s" }, answer]), () => true);

    await screen.getByTestId("file-chip").click();

    expect([openedPaths, screen.getByRole("button", { name: /^探索了/ }).element().ariaExpanded]).toStrictEqual([
      ["src/b.ts"],
      "false",
    ]);
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
    const { screen } = await opened(turn([...reads, grep, answer]));

    await expect
      .element(screen.getByRole("button", { name: /^探索了代码库 · 读了 7 个文件，搜索了 1 次$/ }))
      .toBeVisible();
    await expect.element(screen.getByTestId("explored-files")).toHaveTextContent("a.tsb.tsxc.mdd.jsonMakefile+1 个");
    expect(fileIcons(screen.getByTestId("explored-files").element())).toStrictEqual([
      "typescript",
      "react_ts",
      "markdown",
      "json",
      "makefile",
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
    const steps = [thinking, { ...command, status: "done" as const }];
    /** The turn, running or finished. */
    const view = (value: Turn) => (
      <ClockContext value={clock}>
        <TurnView turn={value} runStartedAt={at} />
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
    /** The turn, running or finished. */
    const view = (value: Turn) => (
      <ClockContext value={clock}>
        <TurnView turn={value} runStartedAt={at} />
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
    const { screen } = await show(turn([command, edit, answer]));
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
    const { screen } = await show(turn([command, edit, answer]));
    const header = screen.getByTestId("process-header");
    /** How long the process's height and each row take, and when each row starts. */
    const timings = () =>
      [screen.getByTestId("process").element(), ...screen.container.querySelectorAll("[data-fold-row]")].map(
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
    const { screen } = await show(turn([command, answer]));
    await screen.getByTestId("process-header").click();
    expect(shownSteps(screen.container)).toStrictEqual(["tool"]);

    await screen.getByTestId("process-header").click();

    expect(shownSteps(screen.container)).toStrictEqual([]);
  });

  it("plays the entrance of steps that arrive while shown, not of those already there", async () => {
    const screen = await render(runningView([thinking]));

    await screen.rerender(runningView([thinking, { ...command, status: "running" }]));

    expect(
      [...screen.container.querySelectorAll('[data-testid="step"]')].map((step) =>
        step.classList.contains("atrium-step-enter"),
      ),
    ).toStrictEqual([false, true]);
    expect(railNodes(screen.container)).toStrictEqual(["dot", "live"]);
  });
});

/**
 * The boxes of the marks a row draws on the main line, relative to the row: its line and its node.
 *
 * @remarks
 * For the compaction's ticks, which cross the line without breaking it (design-language, "压缩步骤").
 *
 * @sideEffects none
 * @param row - The row.
 * @returns The line's pieces and the ticks, as left, top, width and height to the half pixel.
 */
function mainLineMarks(row: Element) {
  const origin = row.getBoundingClientRect();
  /**
   * An element's box relative to the row.
   *
   * @remarks
   * See `mainLineMarks`.
   *
   * @sideEffects none
   * @param element - The element.
   * @returns Its box.
   */
  const box = (element: Element): number[] => {
    const rect = element.getBoundingClientRect();
    return [rect.left - origin.left, rect.top - origin.top, rect.width, rect.height].map(
      (value) => Math.round(value * 2) / 2,
    );
  };
  return {
    line: [...row.querySelectorAll(':scope > [class*="--rail"]')].map(box),
    ticks: [...row.querySelectorAll('[data-testid="rail-node"] > span')].map(box),
    height: Math.round(origin.height),
  };
}

describe("TurnView, what the agent said in the process", () => {
  it("marks text said mid-turn with a larger blue node and darker, heavier words, and leaves thinking as it was", async () => {
    const said: Step = { kind: "text", id: "1", text: "先写纯逻辑，再写扩展。" };
    const { screen } = await show(turn([thinking, said, command, answer]));
    await screen.getByTestId("process-header").click();
    const node = present(screen.container.querySelector('[data-node="said"] span'));
    const words = present(screen.container.querySelector('[data-testid="said-words"]'));
    const thought = present(screen.container.querySelector('[data-kind="thinking"]'));

    expect([
      railNodes(screen.container),
      getComputedStyle(node).width,
      colorOf(getComputedStyle(node).backgroundColor),
      getComputedStyle(node).boxShadow.includes("2px"),
      words.textContent,
      colorOf(getComputedStyle(words).color),
      getComputedStyle(words).fontWeight,
      thought.querySelector('[data-testid="said-words"]'),
    ]).toStrictEqual([
      ["dot", "said", "dead"],
      "7px",
      colorOf("var(--tint)"),
      true,
      "先写纯逻辑，再写扩展。",
      colorOf("var(--text)"),
      "500",
      null,
    ]);
  });

  it("shows as much of a long first line as the row holds, on one line, the row cutting it", async () => {
    const long = `我会让 Grok 4.7 审查这次改动。${"然后对照规格逐条核对实现与测试，".repeat(6)}`;
    const said: Step = { kind: "text", id: "1", text: `${long}\n第二段` };
    const { screen } = await show(turn([thinking, said, command, answer]));
    await screen.getByTestId("process-header").click();
    const words = present(screen.container.querySelector<HTMLElement>('[data-testid="said-words"]'));

    expect([
      words.textContent,
      words.getClientRects().length,
      words.scrollWidth > words.clientWidth,
      getComputedStyle(words).textOverflow,
      getComputedStyle(words).whiteSpace,
    ]).toStrictEqual([`${long}…`, 1, true, "ellipsis", "nowrap"]);
  });
});

describe("TurnView compaction", () => {
  it("keeps the answer visible when a trailing compaction is added, including after the process folds", async () => {
    const { screen } = await show(turn([thinking, answer]));
    await screen.rerender(<TurnView turn={turn([thinking, answer, compaction])} runStartedAt={null} />);

    await expect.element(screen.getByTestId("process-header")).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("改好了，一处改动。");
    await expect.element(screen.getByTestId("reply")).toBeVisible();
    await expect
      .element(screen.getByTestId("process-header"))
      .toHaveTextContent("已完成，用时 2 分 13 秒 · 压缩了 1 次上下文");
    await screen.getByTestId("process-header").click();
    expect(shownSteps(screen.container)).toStrictEqual(["thinking", "compaction"]);
    await expect.element(screen.getByTestId("reply")).toBeVisible();
  });

  it("draws a compaction as two ticks across the unbroken main line, saying the context before and after", async () => {
    const { screen } = await show(turn([thinking, compaction, answer]));
    await screen.getByTestId("process-header").click();
    const row = present(screen.container.querySelector('[data-kind="compaction"]'));

    expect(railNodes(screen.container)).toStrictEqual(["dot", "compaction"]);
    expect(mainLineMarks(row)).toStrictEqual({
      // From the row above down to where the rail ends at the last step, through the node.
      line: [[10, 0, 1, 15]],
      ticks: [
        [4, 13, 13, 1.5],
        [4, 16, 13, 1.5],
      ],
      height: 30,
    });
    const words = screen.getByRole("button", { name: "压缩了上下文 · 152K → 41K" });
    await expect.element(words).toBeVisible();
    expect(getComputedStyle(present(row.querySelector('[data-testid="compaction-tokens"]'))).fontVariantNumeric).toBe(
      "tabular-nums",
    );
    expect(colorOf(getComputedStyle(present(row.querySelector('[data-testid="compaction-words"]'))).color)).toBe(
      colorOf("var(--text-muted)"),
    );
  });

  it("runs the main line on through a compaction with steps after it", async () => {
    const { screen } = await show(turn([thinking, compaction, edit, answer]));
    await screen.getByTestId("process-header").click();
    const row = present(screen.container.querySelector('[data-kind="compaction"]'));

    expect(mainLineMarks(row).line).toStrictEqual([
      [10, 0, 1, 15],
      [10, 15, 1, 15],
    ]);
  });

  it("says 压缩前 while the context after is unknown, and what pi does on an overflow", async () => {
    const { screen } = await opened(
      turn([
        { ...compaction, id: "0", tokensAfter: null, reason: null },
        { ...compaction, id: "1", reason: "overflow" },
        answer,
      ]),
    );

    await expect.element(screen.getByRole("button", { name: "压缩了上下文 · 压缩前 152K" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "上下文超出窗口，已压缩" })).toBeVisible();
  });

  it("opens a compaction's detail: the tokens before and after, then pi's summary in Markdown", async () => {
    const { screen } = await show(turn([compaction, answer]));
    await screen.getByTestId("process-header").click();
    const row = screen.getByRole("button", { name: "压缩了上下文 · 152K → 41K" });
    const caret = present(row.element().querySelector("svg"));

    await row.click();

    await expect.element(row).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByTestId("step-detail");
    await expect.element(detail).toHaveTextContent("压缩前 152K tokens · 压缩后 41K · 保留了最近的原文做到一半");
    await expect.element(screen.getByText("做到")).toBeVisible();
    expect(screen.getByText("压缩前 152K tokens · 压缩后 41K · 保留了最近的原文").element().className).toContain(
      "text-[var(--text-dim)]",
    );
    expect(caret.getAttribute("class")).toContain("rotate-90");
  });

  it("ends the folded header with how many times the context was compacted", async () => {
    const { screen } = await show(turn([command, compaction, { ...compaction, id: "6" }, answer]));

    await expect
      .element(screen.getByTestId("process-header"))
      .toHaveTextContent("已完成，用时 2 分 13 秒 · 跑了 1 条命令 · 1 条命令没走通 · 压缩了 2 次上下文");
  });

  it("says on the rail where pi compacts now, shimmering, after the last step and before any", async () => {
    const running = { outcome: "running", durationMs: null, usage: null } as const;
    const busy = await render(<TurnView turn={turn([command, thinking], running)} runStartedAt={at} compacting />);

    expect(shownSteps(busy.container)).toStrictEqual(["tool", "thinking", "compacting"]);
    // The thinking before it is no longer going on, and the line runs on below it to the compaction.
    expect(railNodes(busy.container)).toStrictEqual(["dead", "dot", "compaction"]);
    expect(mainLineMarks(present(busy.container.querySelector('[data-kind="thinking"]'))).line).toStrictEqual([
      [10, 0, 1, 8],
      [10, 22, 1, 8],
    ]);
    const line = busy.getByText("正在压缩上下文…");
    await expect.element(line).toBeVisible();
    expect(line.element().className).toContain("atrium-shimmer");
    await busy.unmount();

    const first = await render(<TurnView turn={turn([], running)} runStartedAt={at} compacting />);
    expect(shownSteps(first.container)).toStrictEqual(["compacting"]);
    expect(first.container.querySelector('[data-testid="run-waiting"]')).toBeNull();
    await expect.element(first.getByTestId("process-header")).toMatchTextContent(/^进行中 · /);
  });
});

describe("NoticeView", () => {
  it("says the context was compacted between turns and how big it was before and after, opening pi's summary", async () => {
    const notice = {
      kind: "notice",
      id: "n1",
      notice: "compacted",
      tokensBefore: 152_000,
      tokensAfter: 41_000,
      summary: "**做到**一半",
      timestamp: 0,
    } as const;
    const screen = await render(<NoticeView notice={notice} />);
    const line = screen.getByRole("button", { name: "上下文已压缩 · 152K → 41K" });

    await line.click();

    await expect.element(screen.getByText("做到")).toBeVisible();
    await expect.element(line).toHaveAttribute("aria-expanded", "true");
    await screen.rerender(<NoticeView notice={{ ...notice, tokensAfter: null }} />);
    await expect.element(screen.getByRole("button", { name: "上下文已压缩 · 压缩前 152K tokens" })).toBeVisible();
  });
});
