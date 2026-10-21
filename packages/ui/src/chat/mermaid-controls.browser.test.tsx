import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Markdown } from "./markdown";
import "../styles.css";

const SOURCE =
  "flowchart LR\nA[接收用户请求] --> B[完整检查所有参数]\nB --> C[执行主要任务]\nC --> D[汇总处理结果]\nD --> E[返回最终结果]";

/** Requires a real fixture node instead of skipping assertions when it is absent.
 * @remarks Test guards belong outside the unconditional behavior assertions.
 * @sideEffects none
 * @param value - The selected value.
 * @returns The present value.
 * @throws {Error} When the expected fixture is missing.
 */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture value");
  return value;
}

/** Reads the public current-scale output, including after a native theme remount.
 * @remarks Keeping no stale output reference makes the native lifecycle observable.
 * @sideEffects none
 * @param root - The rendered conversation.
 * @returns The displayed integer percentage.
 */
function percent(root: ParentNode): number {
  const ratio = present(root.querySelector('output[aria-label="图表缩放比例"]'));
  return Number.parseInt(present(ratio.textContent), 10);
}

/** Requires the actual observed browser resource.
 * @remarks The lifecycle test spies on the real disconnect, not a fake observer.
 * @sideEffects none
 * @param value - An observer recorded by the native observe spy.
 * @returns The native observer.
 * @throws {Error} When this component never acquired its resource.
 */
function nativeObserver(value: unknown): MutationObserver {
  if (!(value instanceof MutationObserver)) throw new Error("Missing native scale observer");
  return value;
}

/** Renders a real, wider-than-column diagram through the production Markdown path.
 * @remarks Geometry comes from actual Mermaid/Streamdown, not a fake zoom label.
 * @sideEffects Resizes the page and draws a local diagram.
 * @param width - The actual reply column width, including nested/narrow content.
 * @returns The screen, fixture column and rendered SVG.
 */
async function example(width = 520) {
  await page.viewport(1000, 800);
  const screen = await render(
    <div data-testid="mermaid-example" style={{ width }}>
      <Markdown text={`\`\`\`mermaid\n${SOURCE}\n\`\`\``} streaming={false} />
    </div>,
  );
  await expect.element(screen.getByRole("img", { name: "Mermaid chart", exact: true })).toBeVisible();
  await expect.element(screen.getByLabelText("图表缩放比例")).toBeVisible();
  const svg = present(screen.container.querySelector<SVGSVGElement>("svg[id^='mermaid']"));
  const host = present(screen.container.querySelector<HTMLDivElement>('[data-testid="mermaid-example"]'));
  return { screen, svg, host };
}

describe("Mermaid B controls", () => {
  it("does not offer zoom for a still-open fence or a diagram that failed to render", async () => {
    const screen = await render(<Markdown text={"```mermaid\ngraph LR\nA -->"} streaming />);
    expect(screen.container.querySelector('output[aria-label="图表缩放比例"]')).toBeNull();
    expect(screen.getByRole("button", { name: "拉近", exact: true }).elements()).toHaveLength(0);
    await screen.rerender(<Markdown text={"```mermaid\nthis is not a valid diagram @@@\n```"} streaming={false} />);
    await expect.element(screen.getByText("Mermaid Error:", { exact: false })).toBeVisible();
    expect(screen.container.querySelector('output[aria-label="图表缩放比例"]')).toBeNull();
    expect(screen.getByRole("button", { name: "拉近", exact: true }).elements()).toHaveLength(0);
  });

  it("shows the real ratio in a persistent top-right toolbar and changes actual diagram geometry", async () => {
    const { screen, svg } = await example();
    await vi.waitFor(() => expect(percent(screen.container)).toBeGreaterThan(0));
    const initial = percent(screen.container);
    const viewport = present(svg.closest('[role="application"]'));
    await Promise.all(viewport.getAnimations().map((animation) => animation.finished));
    const width = svg.getBoundingClientRect().width;
    expect(initial).toBeLessThan(100);
    const plus = screen.getByRole("button", { name: "拉近", exact: true });
    const minus = screen.getByRole("button", { name: "拉远", exact: true });
    await expect.element(plus).toBeVisible();
    expect(plus.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(svg.getBoundingClientRect().top);
    await plus.click();
    await vi.waitFor(() => expect(percent(screen.container)).toBe(initial + 10));
    await vi.waitFor(() => expect(svg.getBoundingClientRect().width).toBeGreaterThan(width + 1));
    await screen.getByRole("button", { name: "适应窗口", exact: true }).click();
    await vi.waitFor(() => expect(percent(screen.container)).toBe(initial));
    await vi.waitFor(() => expect(svg.getBoundingClientRect().width).toBeCloseTo(width, 0));
    (minus.element() as HTMLButtonElement).focus();
    await userEvent.tab();
    await expect.element(plus).toHaveFocus();
    await userEvent.tab();
    await expect.element(screen.getByRole("button", { name: "适应窗口", exact: true })).toHaveFocus();
  });

  it("keeps original source copying and removes inline zoom while reading source", async () => {
    const { screen } = await example();
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    onTestFinished(() => copied.mockRestore());
    await screen.getByRole("button", { name: "复制", exact: true }).click();
    // Streamdown supplies the code body's terminating LF; keep the existing Mermaid copy value.
    expect(copied).toHaveBeenLastCalledWith(`${SOURCE}\n`);
    await screen.getByRole("button", { name: "看源码" }).click();
    expect(screen.container.querySelector('output[aria-label="图表缩放比例"]')).toBeNull();
    expect(screen.getByRole("button", { name: "拉近", exact: true }).elements()).toHaveLength(0);
    expect([...screen.container.querySelectorAll("pre code > span")].map((line) => line.textContent)).toStrictEqual(
      SOURCE.split("\n"),
    );
    await screen.getByRole("button", { name: "看图" }).click();
    await expect.element(screen.getByRole("button", { name: "拉近", exact: true })).toBeVisible();
  });

  it("tracks native wheel and bounds, then fits the resized viewport and follows a theme remount", async () => {
    const { screen, svg, host } = await example();
    const initial = percent(screen.container);
    const canvas = present(svg.closest('[role="application"]'));
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(percent(screen.container)).toBe(initial + 10));
    const plus = screen.getByRole("button", { name: "拉近", exact: true });
    const minus = screen.getByRole("button", { name: "拉远", exact: true });
    for (let index = 0; index < 35; index += 1) (plus.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(percent(screen.container)).toBe(300));
    await expect.element(plus).toBeDisabled();
    for (let index = 0; index < 35; index += 1) (minus.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(percent(screen.container)).toBe(10));
    await expect.element(minus).toBeDisabled();
    host.style.width = "300px";
    await screen.getByRole("button", { name: "适应窗口", exact: true }).click();
    await vi.waitFor(() => expect(percent(screen.container)).toBeLessThan(initial));
    document.documentElement.classList.add("dark");
    onTestFinished(() => document.documentElement.classList.remove("dark"));
    await vi.waitFor(() => expect(svg.isConnected).toBe(false));
    await vi.waitFor(() => expect(percent(screen.container)).toBeGreaterThan(0));
    await expect.element(screen.getByRole("button", { name: "拉近", exact: true })).toBeEnabled();
  });

  it("keeps every toolbar control inside a narrow nested reply column", async () => {
    const { screen } = await example(240);
    const block = present(screen.container.querySelector(".atrium-mermaid-controls"));
    const bounds = block.getBoundingClientRect();
    const actions = ["看源码", "复制", "拉远", "拉近", "适应窗口", "放大"];
    for (const name of actions) {
      const button = screen.getByRole("button", { name, exact: true });
      await expect.element(button).toBeVisible();
      const rect = button.element().getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(26);
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
    }
    expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
  });

  it("disconnects the actual scale observer when the diagram leaves the conversation", async () => {
    const observed = vi.spyOn(MutationObserver.prototype, "observe");
    onTestFinished(() => observed.mockRestore());
    const { screen } = await example();
    const block = screen.container.querySelector(".atrium-mermaid-controls");
    const own = observed.mock.calls.findIndex(([target]) => target === block);
    expect(own).toBeGreaterThanOrEqual(0);
    const observer = nativeObserver(observed.mock.contexts[own]);
    const disconnect = vi.spyOn(observer, "disconnect");
    onTestFinished(() => disconnect.mockRestore());
    await screen.unmount();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith();
  });
});
