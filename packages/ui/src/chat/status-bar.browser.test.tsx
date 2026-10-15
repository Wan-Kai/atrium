import { type SessionMetrics, type StatusBarChoices, UNKNOWN_METRICS } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { StatusBar } from "./status-bar";

/** A session with every figure known. */
const KNOWN: SessionMetrics = {
  turns: 3,
  steps: 7,
  tokens: { input: 300_000, output: 50_000, cacheRead: 900_000, cacheWrite: 50_000 },
  cost: 0.454,
  reasoning: 12_000,
  branchTokens: 800_000,
  context: { tokens: 84_000, window: 200_000, system: 3000, tools: 2500 },
  timing: { modelMs: 42_300, ttftMs: 820, tps: 48.4 },
};

/**
 * A status bar with these figures and choices, in a page tall enough for its cards.
 *
 * @remarks
 * The bar sits at the bottom, as under the input box, so its cards open upwards into view; a
 * button at the top is somewhere else to click.
 *
 * @sideEffects Renders.
 * @param metrics - The figures.
 * @param choices - The groups switched from their default.
 * @returns The screen and the choices sent.
 */
async function bar(metrics: SessionMetrics = KNOWN, choices: StatusBarChoices = {}) {
  const onChoose = vi.fn<(choices: StatusBarChoices) => void>();
  const screen = await render(
    <div style={{ display: "flex", height: 700, flexDirection: "column", justifyContent: "space-between" }}>
      <button type="button">elsewhere</button>
      <StatusBar metrics={metrics} choices={choices} onChoose={onChoose} />
    </div>,
  );
  return { screen, onChoose };
}

/** The figures with `tokens` of a context of 100 used. */
function at(tokens: number): SessionMetrics {
  return { ...KNOWN, context: { tokens, window: 100, system: null, tools: null } };
}

/**
 * The shadow of the element holding another, where a line under a row is drawn.
 *
 * @sideEffects none
 * @param element - The element inside.
 * @returns The holder's `box-shadow`, or `null` without a holder.
 */
function shadowAround(element: Element): string | null {
  const holder = element.parentElement;
  return holder === null ? null : getComputedStyle(holder).boxShadow;
}

describe("StatusBar", () => {
  it("shows the session's statistics, tokens and context by default, the cost only when chosen", async () => {
    const { screen } = await bar();

    const groups = screen.getByRole("group", { name: "状态栏" }).getByRole("button");
    expect(groups.elements().map((element) => element.textContent)).toStrictEqual([
      "3 轮 7 步·48 tok/s",
      "1.3M tok·缓存命中 72%",
      "42%",
      "",
    ]);
    await expect.element(screen.getByRole("button", { name: "自定义状态栏" })).toBeVisible();
  });

  it("shows the groups chosen, the cost among them, and none switched off", async () => {
    const { screen } = await bar(KNOWN, { cost: true, tokens: false });

    const groups = screen.getByRole("group", { name: "状态栏" }).getByRole("button");
    expect(groups.elements().map((element) => element.textContent)).toStrictEqual([
      "3 轮 7 步·48 tok/s",
      "42%",
      "≈ $0.45",
      "",
    ]);
  });

  it("shows a dash for every figure not known yet", async () => {
    const { screen } = await bar(UNKNOWN_METRICS, { cost: true });

    const groups = screen.getByRole("group", { name: "状态栏" }).getByRole("button");
    expect(groups.elements().map((element) => element.textContent)).toStrictEqual([
      "— 轮 — 步·— tok/s",
      "— tok·缓存命中 —",
      "—",
      "—",
      "",
    ]);
  });

  it("opens a group's card on hover, with the figures behind its summary", async () => {
    const { screen } = await bar();

    await userEvent.hover(screen.getByRole("button", { name: /缓存命中/ }));

    const card = screen.getByRole("tooltip").filter({ hasText: "Token 用量" });
    await expect.element(card).toBeVisible();
    expect(card.element().textContent).toBe(
      "Token 用量1,300,000 tok缓存命中72%未缓存输入300,000 tok缓存读取900,000 tok缓存写入50,000 tok输出50,000 tok其中推理12,000 tok当前分支800,000 tok本会话累计：整个会话文件，含其他分支和压缩消耗",
    );
    // Hidden cards are left out of the accessibility tree.
    await expect
      .element(screen.getByRole("tooltip", { includeHidden: true }).filter({ hasText: "会话统计" }))
      .not.toBeVisible();
  });

  it("hides a card once the pointer leaves, though a click left its group focused, and shows it on keyboard focus", async () => {
    const { screen } = await bar();
    const tokens = screen.getByRole("button", { name: /缓存命中/ });
    const card = screen.getByRole("tooltip", { includeHidden: true }).filter({ hasText: "Token 用量" });
    await userEvent.click(tokens);
    await expect.element(card).toBeVisible();

    await userEvent.hover(screen.getByRole("button", { name: /轮/ }));
    await expect.element(tokens).toHaveFocus();
    await expect.element(card).not.toBeVisible();

    await userEvent.keyboard("{Tab}{Shift>}{Tab}{/Shift}");
    await expect.element(tokens).toHaveFocus();
    await expect.element(card).toBeVisible();
  });

  it("leaves out reasoning when no reply reported it", async () => {
    const { screen } = await bar({ ...KNOWN, reasoning: null });

    await userEvent.hover(screen.getByRole("button", { name: /缓存命中/ }));

    await expect.element(screen.getByRole("tooltip").filter({ hasText: "Token 用量" })).toBeVisible();
    expect(screen.getByRole("tooltip").filter({ hasText: "Token 用量" }).element().textContent).not.toContain(
      "其中推理",
    );
  });

  it("times the session in its card, in seconds and tokens a second", async () => {
    const { screen } = await bar();

    await userEvent.hover(screen.getByRole("button", { name: /轮/ }));

    const card = screen.getByRole("tooltip").filter({ hasText: "会话统计" });
    await expect.element(card).toBeVisible();
    expect(card.element().textContent).toBe(
      "会话统计模型用时42.3 秒首 token 平均（TTFT）0.8 秒输出速度（TPS）48 tok/s轮和步数整个会话文件，含其他分支；用时和速度是 Atrium 这次运行时测的",
    );
  });

  it("splits the context in its card: the system prompt, the tools and the conversation", async () => {
    const { screen } = await bar();

    await userEvent.hover(screen.getByRole("button", { name: "42%" }));

    const card = screen.getByRole("tooltip").filter({ hasText: "上下文已用" });
    await expect.element(card).toBeVisible();
    expect(card.element().textContent).toBe(
      "上下文已用 42%~84K / 200K系统提示词~3K工具定义~3K对话消息~79K接近上限时 pi 会自动压缩",
    );
    // No line under the title row.
    expect(shadowAround(card.getByText("~84K / 200K").element())).toBe("none");
  });

  it("says why the context is not known: no window, or a compaction just now", async () => {
    const { screen } = await bar({ ...KNOWN, context: { tokens: null, window: 200_000, system: 3000, tools: 2500 } });
    await userEvent.hover(screen.getByRole("button", { name: "—" }));
    await expect.element(screen.getByText("刚压缩过，下一次回复后更新")).toBeVisible();

    await screen.rerender(<StatusBar metrics={{ ...KNOWN, context: null }} choices={{}} onChoose={() => undefined} />);
    // The group drawn again is hovered again.
    await userEvent.unhover(screen.getByRole("button", { name: "—" }));
    await userEvent.hover(screen.getByRole("button", { name: "—" }));

    await expect.element(screen.getByText("当前模型没有给出上下文窗口")).toBeVisible();
  });

  it("shows the context's total alone before pi stated a system prompt", async () => {
    const { screen } = await bar({ ...KNOWN, context: { tokens: 84_000, window: 200_000, system: null, tools: null } });

    await userEvent.hover(screen.getByRole("button", { name: "42%" }));

    const card = screen.getByRole("tooltip").filter({ hasText: "上下文已用" });
    await expect.element(card).toBeVisible();
    expect(card.element().textContent).toBe("上下文已用 42%~84K / 200K接近上限时 pi 会自动压缩");
  });

  it("colours the context yellow past 70% and red past 85%", async () => {
    /** The context's colour at `tokens` of 100. */
    const colorAt = async (tokens: number) => {
      await screen.rerender(<StatusBar metrics={at(tokens)} choices={{}} onChoose={() => undefined} />);
      const group = screen.getByRole("button", { name: `${tokens}%` });
      await expect.element(group).toBeVisible();
      return getComputedStyle(group.element()).color;
    };
    const { screen } = await bar(at(70));
    const calmColor = await colorAt(70);
    const warnColor = await colorAt(71);
    const dangerColor = await colorAt(86);

    const root = getComputedStyle(document.documentElement);
    expect([calmColor, warnColor, dangerColor]).toStrictEqual([
      colorOf(root.getPropertyValue("--text-muted")),
      colorOf(root.getPropertyValue("--attn-text")),
      colorOf(root.getPropertyValue("--danger")),
    ]);
  });

  it("explains the cost in its card", async () => {
    const { screen } = await bar(KNOWN, { cost: true });

    await userEvent.hover(screen.getByRole("button", { name: "≈ $0.45" }));

    const card = screen.getByRole("tooltip").filter({ hasText: "费用" });
    await expect.element(card).toBeVisible();
    expect(card.element().textContent).toBe("费用≈ $0.45计算方式按 API 价格折算订阅用户不实际付费");
  });
});

describe("StatusBar's panel", () => {
  it("lists every group with how it looks now and a switch, and switches one", async () => {
    const { screen, onChoose } = await bar();

    await screen.getByRole("button", { name: "自定义状态栏" }).click();

    const panel = screen.getByRole("dialog", { name: "状态栏" });
    await expect.element(panel).toBeVisible();
    const switches = panel.getByRole("switch");
    expect(
      switches.elements().map((element) => [element.getAttribute("aria-label"), element.ariaChecked]),
    ).toStrictEqual([
      ["会话统计", "true"],
      ["Token 用量", "true"],
      ["上下文", "true"],
      ["费用", "false"],
    ]);
    expect(panel.getByRole("switch", { name: "费用" }).element().textContent).toBe(
      "费用按 API 价格折算，订阅不实际付费≈ $0.45",
    );
    await panel.getByRole("switch", { name: "费用" }).click();
    await panel.getByRole("switch", { name: "会话统计" }).click();

    expect(onChoose.mock.calls).toStrictEqual([[{ cost: true }], [{ session: false }]]);
  });

  it("goes back to the defaults", async () => {
    const { screen, onChoose } = await bar(KNOWN, { cost: true, session: false });

    await screen.getByRole("button", { name: "自定义状态栏" }).click();
    await screen.getByRole("button", { name: "恢复默认" }).click();

    expect(onChoose.mock.calls).toStrictEqual([[{}]]);
  });

  it("closes on Escape, keeping the Escape from anything else, and on a click outside", async () => {
    const { screen } = await bar();
    const outside = vi.fn<(event: KeyboardEvent) => void>();
    document.addEventListener("keydown", outside);
    const settings = screen.getByRole("button", { name: "自定义状态栏" });

    await settings.click();
    await expect.element(settings).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("dialog", { name: "状态栏" })).not.toBeInTheDocument();
    await settings.click();
    await screen.getByRole("button", { name: "elsewhere" }).click();

    await expect.element(screen.getByRole("dialog", { name: "状态栏" })).not.toBeInTheDocument();
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outside);
  });
});

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
