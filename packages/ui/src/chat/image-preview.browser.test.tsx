import { useState } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ImagePreview } from "./image-preview";

/**
 * Creates a real PNG with known natural dimensions.
 * @remarks The browser must decode actual image bytes, not mocked load events.
 * @sideEffects Allocates a temporary canvas.
 * @param width - Natural width.
 * @param height - Natural height.
 * @returns A PNG data address.
 */
function png(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("No canvas context");
  context.fillStyle = "#2f6fed";
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
}

/**
 * Hosts a controlled preview above a focusable conversation surface.
 * @remarks A real trigger verifies focus restoration and modal isolation.
 * @sideEffects Mounts and removes the preview; calls the close recorder.
 * @param props - Image and callback.
 * @returns The test surface.
 */
function Harness({ src, closed }: { readonly src: string; readonly closed: () => void }) {
  const [shown, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        查看图片
      </button>
      <button type="button">背景操作</button>
      {shown && (
        <ImagePreview
          src={src}
          alt="布局预览"
          onClose={() => {
            closed();
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Opens a preview at a deterministic application-window size.
 * @remarks Each test drives a real native modal in Chromium.
 * @sideEffects Resizes the browser and renders the controlled harness.
 * @param src - Image address.
 * @returns The render result and close recorder.
 */
async function openPreview(src = png(1600, 1000)) {
  await page.viewport(1000, 800);
  const closed = vi.fn<() => void>();
  const screen = await render(<Harness src={src} closed={closed} />);
  await screen.getByRole("button", { name: "查看图片" }).click();
  return { screen, closed };
}

/**
 * Reads the displayed image and canvas rectangles.
 * @remarks Geometry assertions verify original-relative zoom rather than labels alone.
 * @sideEffects none
 * @param root - The rendered test root.
 * @returns The image element and canvas.
 */
function geometry(root: HTMLElement) {
  const image = root.ownerDocument.querySelector<HTMLImageElement>(".atrium-image-preview img");
  const canvas = root.ownerDocument.querySelector<HTMLElement>(".atrium-image-preview-canvas");
  if (image === null || canvas === null) throw new Error("Missing preview geometry");
  return { image, canvas };
}

/**
 * Dispatches a trusted mouse event through Chromium.
 * @remarks Real pointer capture requires a browser-owned active pointer.
 * @sideEffects Moves or presses the browser mouse.
 * @param type - Mouse phase.
 * @param x - Horizontal viewport position.
 * @param y - Vertical viewport position.
 */
async function mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) {
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
  });
}

afterEach(async () => {
  await mouse("mouseReleased", 10, 10);
});

describe("ImagePreview", () => {
  it("keeps the modal outside an enclosing link's native activation subtree", async () => {
    const screen = await render(
      <a href="#preview-target">
        <ImagePreview src={png(100, 80)} alt="关联图" onClose={() => undefined} />
      </a>,
    );
    await expect.element(screen.getByText("100 × 80")).toBeVisible();
    const dialog = screen.getByRole("dialog", { name: "图片预览" }).element();
    expect(dialog.closest("a, button")).toBeNull();
    const activated = vi.fn<(event: Event) => void>((event) => event.preventDefault());
    screen.container.querySelector("a")?.addEventListener("click", activated);
    await screen.getByRole("region", { name: "图片画布" }).click();
    expect(activated).not.toHaveBeenCalled();
  });
  it("fills the application window with the chosen dark canvas and fits the original", async () => {
    const { screen } = await openPreview();
    await expect.element(screen.getByText("1600 × 1000")).toBeVisible();
    const dialog = screen.getByRole("dialog", { name: "图片预览" }).element();
    expect(dialog.matches(":modal")).toBe(true);
    expect(dialog.getBoundingClientRect().toJSON()).toMatchObject({ x: 0, y: 0, width: 1000, height: 800 });
    const { image, canvas } = geometry(screen.container);
    const expected = Math.min((canvas.clientWidth - 48) / 1600, (canvas.clientHeight - 48) / 1000);
    expect(image.getBoundingClientRect().width).toBeCloseTo(1600 * expected, 1);
    expect(image.getBoundingClientRect().height).toBeCloseTo(1000 * expected, 1);
    expect(getComputedStyle(canvas).backgroundColor).toBe("rgb(17, 17, 20)");
    await expect.element(screen.getByRole("button", { name: "关闭预览" })).toHaveFocus();
    await expect.element(screen.getByText("布局预览")).toBeVisible();
    expect(screen.getByText("布局预览").element().getBoundingClientRect().left).toBeGreaterThanOrEqual(120);
  });

  it("keeps long names truncated and controls accessible in a narrow dark window", async () => {
    await page.viewport(360, 500);
    const name = "非常长的布局预览名称".repeat(12);
    const screen = await render(
      <div className="dark">
        <ImagePreview src={png(100, 80)} alt={name} onClose={() => undefined} />
      </div>,
    );
    await expect.element(screen.getByText("100 × 80")).toBeVisible();
    const title = screen.getByText(name).element() as HTMLElement;
    expect(title.getBoundingClientRect().left).toBeGreaterThanOrEqual(120);
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
    const fitButton = screen.getByRole("button", { name: "适应窗口" });
    await expect.element(fitButton).toBeVisible();
    const controls = document.querySelectorAll<HTMLButtonElement>(".atrium-image-preview-controls button");
    expect(controls).toHaveLength(4);
    expect([...controls].map((button) => button.getBoundingClientRect().right <= 360)).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(getComputedStyle(geometry(screen.container).canvas).backgroundColor).toBe("rgb(17, 17, 20)");
  });

  it("keeps Tab and programmatic focus inside, blocks background clicks and swallows Escape", async () => {
    const { screen, closed } = await openPreview(png(100, 80));
    await expect.element(screen.getByText("100 × 80")).toBeVisible();
    const escaped = vi.fn<() => void>();
    window.addEventListener("keydown", escaped);
    onTestFinished(() => window.removeEventListener("keydown", escaped));
    const background = screen.getByRole("button", { name: "背景操作" }).element() as HTMLButtonElement;
    const clicked = vi.fn<() => void>();
    background.addEventListener("click", clicked);
    onTestFinished(() => background.removeEventListener("click", clicked));
    background.focus();
    expect(document.activeElement?.closest("dialog")).not.toBeNull();
    for (let index = 0; index < 9; index += 1) {
      await userEvent.tab();
      expect(document.activeElement?.closest("dialog")).not.toBeNull();
    }
    for (let index = 0; index < 9; index += 1) {
      await userEvent.tab({ shift: true });
      expect(document.activeElement?.closest("dialog")).not.toBeNull();
    }
    const backgroundRect = background.getBoundingClientRect();
    await mouse("mousePressed", backgroundRect.x + 2, backgroundRect.y + 2);
    await mouse("mouseReleased", backgroundRect.x + 2, backgroundRect.y + 2);
    expect(clicked).not.toHaveBeenCalled();
    escaped.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(escaped).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledExactlyOnceWith();
    await expect.element(screen.getByRole("dialog", { name: "图片预览" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "查看图片" })).toHaveFocus();
  });

  it("does not enlarge a small image and restores the trigger after the close button", async () => {
    const { screen, closed } = await openPreview(png(100, 80));
    await expect.element(screen.getByText("100 × 80")).toBeVisible();
    expect(geometry(screen.container).image.getBoundingClientRect().width).toBe(100);
    await expect.element(screen.getByText("100%", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "关闭预览" }).click();
    expect(closed).toHaveBeenCalledExactlyOnceWith();
    await expect.element(screen.getByRole("button", { name: "查看图片" })).toHaveFocus();
    await screen.getByRole("button", { name: "背景操作" }).click();
  });

  it("clamps keyboard and button zoom to 25–400 percent relative to original pixels", async () => {
    const { screen } = await openPreview(png(400, 300));
    await expect.element(screen.getByText("400 × 300")).toBeVisible();
    for (let index = 0; index < 16; index += 1) await userEvent.keyboard("+");
    await expect.element(screen.getByText("400%", { exact: true })).toBeVisible();
    expect(geometry(screen.container).image.getBoundingClientRect().width).toBe(1600);
    await expect.element(screen.getByRole("button", { name: "放大", exact: true })).toBeDisabled();
    for (let index = 0; index < 17; index += 1) await userEvent.keyboard("-");
    await expect.element(screen.getByText("25%", { exact: true })).toBeVisible();
    expect(geometry(screen.container).image.getBoundingClientRect().width).toBe(100);
    await expect.element(screen.getByRole("button", { name: "缩小", exact: true })).toBeDisabled();
    await screen.getByRole("button", { name: "放大", exact: true }).click();
    await expect.element(screen.getByText("50%", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "缩小", exact: true }).click();
    await expect.element(screen.getByText("25%", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "适应窗口" }).click();
    await expect.element(screen.getByText("100%", { exact: true })).toBeVisible();
  });

  it("follows a real pointer drag, bounds arrow panning, and stops on pointer cancellation", async () => {
    const { screen } = await openPreview(png(400, 300));
    await expect.element(screen.getByText("400 × 300")).toBeVisible();
    for (let index = 0; index < 12; index += 1) await userEvent.keyboard("+");
    const { image, canvas } = geometry(screen.container);
    const initial = image.getBoundingClientRect();
    await mouse("mousePressed", 500, 400);
    expect(canvas.hasPointerCapture(1)).toBe(true);
    await mouse("mouseMoved", 580, 450);
    await vi.waitFor(() => expect(image.getBoundingClientRect().x).toBeCloseTo(initial.x + 80, 1));
    expect(image.getBoundingClientRect().y).toBeCloseTo(initial.y + 50, 1);
    canvas.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    expect(canvas.hasPointerCapture(1)).toBe(false);
    const cancelled = image.getBoundingClientRect();
    await mouse("mouseMoved", 640, 500);
    expect(image.getBoundingClientRect().toJSON()).toStrictEqual(cancelled.toJSON());
    await mouse("mouseReleased", 640, 500);
    canvas.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(image.getBoundingClientRect().x).toBeCloseTo(cancelled.x - 40, 1);
    await userEvent.keyboard("{ArrowUp}");
    expect(image.getBoundingClientRect().y).toBeCloseTo(cancelled.y - 40, 1);
    for (let index = 0; index < 30; index += 1) await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    expect(image.getBoundingClientRect().left).toBeCloseTo(24, 1);
    expect(image.getBoundingClientRect().top).toBeCloseTo(canvas.getBoundingClientRect().top + 24, 1);
    await userEvent.keyboard("0");
    expect(image.getBoundingClientRect().width).toBe(400);
    expect(image.getBoundingClientRect().x).toBe(300);
  });

  it("recomputes fit when the viewport changes and preserves manual zoom", async () => {
    const { screen } = await openPreview();
    await expect.element(screen.getByText("1600 × 1000")).toBeVisible();
    await page.viewport(600, 500);
    const { image, canvas } = geometry(screen.container);
    await vi.waitFor(() =>
      expect(image.getBoundingClientRect().width).toBeCloseTo(
        1600 * Math.min((canvas.clientWidth - 48) / 1600, (canvas.clientHeight - 48) / 1000),
        1,
      ),
    );
    await userEvent.keyboard("+");
    const manualWidth = image.getBoundingClientRect().width;
    await page.viewport(900, 700);
    await vi.waitFor(() => expect(canvas.clientWidth).toBe(900));
    expect(image.getBoundingClientRect().width).toBeCloseTo(manualWidth, 1);
    await screen.getByRole("button", { name: "适应窗口" }).click();
    expect(image.getBoundingClientRect().width).toBeCloseTo(
      1600 * Math.min((canvas.clientWidth - 48) / 1600, (canvas.clientHeight - 48) / 1000),
      1,
    );
  });

  it("keeps very large images fully fitted below 25 percent until explicit manual zoom", async () => {
    const { screen } = await openPreview(png(8000, 4000));
    await expect.element(screen.getByText("8000 × 4000")).toBeVisible();
    const { image, canvas } = geometry(screen.container);
    const initial = image.getBoundingClientRect().toJSON();
    expect(image.getBoundingClientRect().width / 8000).toBeLessThan(0.25);
    canvas.focus();
    await userEvent.keyboard("-");
    expect(image.getBoundingClientRect().toJSON()).toStrictEqual(initial);
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    expect(image.getBoundingClientRect().toJSON()).toStrictEqual(initial);
    await mouse("mousePressed", 500, 400);
    await mouse("mouseMoved", 580, 450);
    await mouse("mouseReleased", 580, 450);
    expect(image.getBoundingClientRect().toJSON()).toStrictEqual(initial);
    await screen.getByRole("button", { name: "放大", exact: true }).click();
    await expect.element(screen.getByText("25%", { exact: true })).toBeVisible();
    expect(image.getBoundingClientRect().width).toBe(2000);
  });

  it("shows a readable failure without a broken image and offers a retry", async () => {
    const { screen, closed } = await openPreview("data:image/png;base64,broken");
    await expect.element(screen.getByText("读不了这张图片，请重试。")).toBeVisible();
    expect(document.querySelector(".atrium-image-preview img")).toBeNull();
    await expect.element(screen.getByRole("button", { name: "放大", exact: true })).toBeDisabled();
    await screen.getByRole("button", { name: "重试" }).click();
    await expect.element(screen.getByText("读不了这张图片，请重试。")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "关闭预览" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(closed).toHaveBeenCalledExactlyOnceWith();
  });

  it("closes the native modal and releases capture on unmount without leaking keyboard handlers", async () => {
    const { screen, closed } = await openPreview(png(400, 300));
    await expect.element(screen.getByText("400 × 300")).toBeVisible();
    const dialog = screen.getByRole("dialog", { name: "图片预览" }).element() as HTMLDialogElement;
    const { canvas } = geometry(screen.container);
    await mouse("mousePressed", 500, 400);
    expect(canvas.hasPointerCapture(1)).toBe(true);
    await screen.rerender(<button type="button">切换后的会话</button>);
    expect(dialog.open).toBe(false);
    expect(dialog.matches(":modal")).toBe(false);
    expect(canvas.hasPointerCapture(1)).toBe(false);
    await userEvent.keyboard("{Escape}+");
    expect(closed).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "切换后的会话" }).click();
    await expect.element(screen.getByRole("button", { name: "切换后的会话" })).toHaveFocus();
  });
});
