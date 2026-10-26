import { type CSSProperties, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { type FloatingLayerOptions, useFloatingLayer } from "./floating-layer";

/**
 * Hosts a real anchored layer under a clipping, transformed ancestor.
 * @remarks Tests use the same DOM ownership as nested menus, not a portal or mocked layout.
 * @sideEffects The floating hook observes and positions the surface.
 * @param props - Anchor position, content size and floating preferences.
 * @returns The test surface.
 */
function Harness({
  left = 100,
  top = 300,
  width = 180,
  minimum = 0,
  height = 100,
  rows = 1,
  options = {},
  parentHeight = 28,
}: {
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly minimum?: number;
  readonly height?: number;
  readonly rows?: number;
  readonly options?: FloatingLayerOptions;
  readonly parentHeight?: number;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useFloatingLayer(anchor, layer, options);
  const placement: CSSProperties = { position: "fixed", top, left, width: 100, height: parentHeight };
  return (
    <div data-testid="owner" style={{ ...placement, overflow: "hidden", filter: "opacity(1)" }}>
      <button ref={anchor} type="button" style={{ position: "absolute", bottom: 0, width: 100, height: 28 }}>
        anchor
      </button>
      <div
        ref={layer}
        role="dialog"
        aria-label="surface"
        data-testid="surface"
        className="absolute bottom-full left-1/2 -translate-x-1/2"
        style={{ width, minWidth: minimum, maxHeight: height, overflow: "auto", background: "white", color: "black" }}
      >
        {Array.from({ length: rows }, (_, index) => (
          <button key={index} type="button" style={{ display: "block", height, width: "100%" }}>
            row {index}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Rounds a surface's physical edges for deterministic viewport assertions.
 * @remarks Fractional font geometry is not the behavior these tests target.
 * @sideEffects none
 * @param element - The element to measure.
 * @returns Its edges and size.
 */
function box(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * Hosts a scrolling parent panel whose row opens its own top-layer menu.
 * @remarks The child is mounted after the parent, as actual row menus are opened.
 * @sideEffects Opens the nested surface when its trigger is clicked.
 * @returns The nested test surface.
 */
function NestedHarness() {
  const anchor = useRef<HTMLButtonElement>(null);
  const parent = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useFloatingLayer(anchor, parent);
  useFloatingLayer(trigger, menu, { enabled: open, side: "bottom", flip: true });
  return (
    <div style={{ position: "fixed", left: 100, top: 300 }}>
      <button ref={anchor} type="button" style={{ height: 28 }}>
        parent
      </button>
      <div
        ref={parent}
        role="dialog"
        aria-label="parent panel"
        style={{ width: 220, height: 80, overflow: "auto", background: "white" }}
      >
        <div style={{ height: 40 }}>A child conversation</div>
        <button ref={trigger} type="button" onClick={() => setOpen(!open)} style={{ height: 28 }}>
          row menu
        </button>
        {open ? (
          <div ref={menu} role="menu" style={{ width: 160, height: 100, background: "white" }}>
            <button type="button">child action</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Uses the app's actual theme utilities on an otherwise undecorated div.
 * @remarks Popover's user-agent paint must not replace inherited or utility colours and spacing.
 * @sideEffects The floating hook installs the surface.
 * @returns The theme test surface.
 */
function ThemeHarness() {
  const anchor = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useFloatingLayer(anchor, layer);
  return (
    <div style={{ position: "fixed", left: 100, top: 300, color: "rgb(1, 2, 3)" }}>
      <button ref={anchor} type="button">
        theme anchor
      </button>
      <div
        ref={layer}
        role="dialog"
        aria-label="theme surface"
        className="w-[180px] bg-[var(--surface-1)] p-3 text-[var(--text-muted)]"
      >
        Theme content
      </div>
    </div>
  );
}

/**
 * Applies an intrinsic panel's measured width after it has already opened.
 * @remarks CapsuleUnit learns its bar's remaining width in a layout effect, not its first render.
 * @sideEffects Installs the anchored surface.
 * @param props - Whether the bar's width has arrived and whether the name is long.
 * @returns The intrinsic surface.
 */
function IntrinsicHarness({ measured, long = false }: { readonly measured: boolean; readonly long?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useFloatingLayer(anchor, layer, measured ? { maxWidth: "440px" } : {});
  return (
    <div style={{ position: "fixed", left: 200, top: 300 }}>
      <button ref={anchor} type="button">
        intrinsic anchor
      </button>
      <div
        ref={layer}
        role="dialog"
        aria-label="intrinsic surface"
        style={measured ? { width: "max-content", minWidth: 300, maxWidth: 440 } : undefined}
      >
        <div className="flex min-w-0">
          <span className="min-w-0 truncate">{long ? "Long conversation title ".repeat(30) : "short"}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Hosts a regular aria-modal overlay and a menu whose anchor belongs to it.
 * @remarks Production settings and confirmation dialogs are ordinary DOM overlays, not native dialogs.
 * @sideEffects Installs the modal-owned floating menu.
 * @returns The modal overlay.
 */
function ModalHarness() {
  const anchor = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useFloatingLayer(anchor, layer);
  return (
    <div data-testid="modal-overlay" style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,.4)" }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="modal surface"
        style={{ position: "fixed", left: 350, top: 200, width: 300, height: 300, background: "white" }}
      >
        <button ref={anchor} type="button" style={{ marginTop: 180, height: 28 }}>
          modal anchor
        </button>
        <div ref={layer} role="menu" aria-label="modal menu" style={{ width: 180, height: 100, background: "white" }}>
          <button type="button">modal action</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Creates a visible modal overlay outside the React tree hosting an existing background layer.
 * @remarks Direct DOM changes exercise the helper's modal observer without a background rerender.
 * @sideEffects Adds an overlay to the document and registers its removal after the test.
 * @returns The overlay and the aria-modal element.
 */
function customModal() {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.4)";
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.style.cssText = "position:fixed;left:350px;top:200px;width:300px;height:300px;background:white";
  overlay.append(modal);
  document.body.append(overlay);
  onTestFinished(() => overlay.remove());
  return { overlay, modal };
}

/**
 * Waits for layout observers to finish their initial frame before spying on unrelated mutations.
 * @remarks A two-frame checkpoint drains ResizeObserver work without arbitrary sleeps.
 * @sideEffects Schedules animation frames.
 * @returns A promise resolved after those frame checkpoints.
 */
function frames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * Hosts an intrinsic menu at the window's right edge without an authored width.
 * @remarks Native popover fit-content sizing must not depend on its previous clamped left edge.
 * @sideEffects Installs the floating menu.
 * @param props - A rerender marker, intentionally unrelated to the menu's content.
 * @returns The intrinsic menu and its natural-width reference.
 */
function AutoWidthHarness({ revision = 0 }: { readonly revision?: number }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useFloatingLayer(anchor, layer);
  const text = "several separate words make this menu wider";
  return (
    <div data-revision={revision} style={{ position: "fixed", top: 300, left: 740 }}>
      <button ref={anchor} type="button" style={{ width: 40 }}>
        auto anchor
      </button>
      <div ref={layer} role="menu" aria-label="auto width" style={{ minWidth: 100, padding: 12, background: "white" }}>
        {text}
      </div>
      <div
        data-testid="natural-width"
        style={{ position: "fixed", left: 12, top: 12, width: "max-content", padding: 12, visibility: "hidden" }}
      >
        {text}
      </div>
    </div>
  );
}

/**
 * Identifies the helper's modal ownership observer among browser-test observers.
 * @remarks Other test infrastructure may also use MutationObserver while rendering.
 * @sideEffects none
 * @param observation - The target and observer configuration.
 * @returns Whether the observer watches modal ownership on this document.
 */
function modalObservation([target, configuration]: Parameters<MutationObserver["observe"]>): boolean {
  return target === document.documentElement && configuration?.attributeFilter?.includes("aria-modal") === true;
}

beforeEach(() => page.viewport(800, 600));
afterEach(async () => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
  await page.viewport(800, 600);
});

describe("useFloatingLayer", () => {
  it("keeps the preferred side and gap, escapes a clipping ancestor, and retains DOM ownership", async () => {
    const screen = await render(<Harness />);
    const anchor = screen.getByRole("button", { name: "anchor" }).element();
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    const owner = screen.getByTestId("owner").element();

    expect(box(surface)).toStrictEqual({ top: 192, left: 100, right: 280, bottom: 292, width: 180, height: 100 });
    expect(anchor.getBoundingClientRect().top - surface.getBoundingClientRect().bottom).toBe(8);
    expect(surface.matches(":popover-open")).toBe(true);
    expect(owner.contains(surface)).toBe(true);
    expect(surface.contains(document.elementFromPoint(150, 230))).toBe(true);
  });

  it("keeps a long panel above its anchor, inside every edge, with its first and last rows reachable", async () => {
    const screen = await render(<Harness left={760} top={100} height={40} rows={10} options={{ maxHeight: "none" }} />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();

    expect(box(surface)).toStrictEqual({ top: 12, left: 608, right: 788, bottom: 92, width: 180, height: 80 });
    expect(surface.scrollTop).toBe(0);
    expect(surface.scrollHeight).toBe(400);
    const reachedEnd = new Promise<void>((resolve) =>
      surface.addEventListener("scroll", () => resolve(), { once: true }),
    );
    surface.scrollTop = surface.scrollHeight;
    expect(surface.scrollTop).toBe(320);
    await reachedEnd;
    await frames();
    expect(surface.scrollTop).toBe(320);
    expect(box(screen.getByRole("button", { name: "row 9" }).element()).bottom).toBe(92);
    window.dispatchEvent(new Event("resize"));
    await frames();
    expect(surface.scrollTop).toBe(320);
    expect(box(screen.getByRole("button", { name: "row 9" }).element()).bottom).toBe(92);
    const reachedStart = new Promise<void>((resolve) =>
      surface.addEventListener("scroll", () => resolve(), { once: true }),
    );
    surface.scrollTop = 0;
    await reachedStart;
    await frames();
    expect(surface.scrollTop).toBe(0);
    expect(box(screen.getByRole("button", { name: "row 0" }).element()).top).toBe(12);
  });

  it("flips a short menu only when its preferred side is too small and its opposite has more room", async () => {
    const screen = await render(<Harness left={100} top={70} options={{ flip: true }} />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(box(surface)).toStrictEqual({ top: 106, left: 100, right: 280, bottom: 206, width: 180, height: 100 });

    await screen.rerender(<Harness left={100} top={300} options={{ flip: true }} />);
    expect(box(surface).bottom).toBe(292);
  });

  it("preserves a flipped surface's scroll position across native scrolling and outside remeasurement", async () => {
    const screen = await render(
      <Harness top={100} height={40} rows={20} options={{ flip: true, maxHeight: "none" }} />,
    );
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(box(surface)).toStrictEqual({ top: 136, left: 100, right: 280, bottom: 588, width: 180, height: 452 });
    const reachedEnd = new Promise<void>((resolve) =>
      surface.addEventListener("scroll", () => resolve(), { once: true }),
    );
    surface.scrollTop = surface.scrollHeight;
    await reachedEnd;
    await frames();
    expect(surface.scrollTop).toBe(348);
    expect(box(screen.getByRole("button", { name: "row 19" }).element()).bottom).toBe(588);

    const scrolled = vi.fn<() => void>();
    surface.addEventListener("scroll", scrolled);
    window.dispatchEvent(new Event("resize"));
    await frames();
    expect(surface.scrollTop).toBe(348);
    expect(box(screen.getByRole("button", { name: "row 19" }).element()).bottom).toBe(588);
    const settled = scrolled.mock.calls.length;
    await frames();
    expect(scrolled).toHaveBeenCalledTimes(settled);
    surface.removeEventListener("scroll", scrolled);
  });

  it("keeps the preferred side when its bounded frame fits even though its scrolling content does not", async () => {
    await page.viewport(800, 1000);
    const screen = await render(
      <Harness top={420} height={50} rows={20} options={{ flip: true, maxHeight: "360px" }} />,
    );
    const surface = screen.getByRole("dialog", { name: "surface" }).element();

    expect(surface.scrollHeight).toBe(1000);
    expect(box(surface)).toStrictEqual({ top: 52, left: 100, right: 280, bottom: 412, width: 180, height: 360 });
  });

  it("bounds an oversized panel's width while respecting end and center alignment", async () => {
    const screen = await render(<Harness left={700} width={1200} options={{ side: "bottom", align: "end" }} />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(box(surface)).toStrictEqual({ top: 336, left: 12, right: 788, bottom: 436, width: 776, height: 100 });

    await screen.rerender(<Harness left={400} options={{ align: "center" }} />);
    expect(box(surface)).toStrictEqual({ top: 192, left: 360, right: 540, bottom: 292, width: 180, height: 100 });
  });

  it("fits side hints vertically and flips them away from a window edge", async () => {
    const screen = await render(
      <Harness left={40} top={550} options={{ side: "left", align: "center", flip: true }} />,
    );
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(box(surface)).toStrictEqual({ top: 488, left: 148, right: 328, bottom: 588, width: 180, height: 100 });

    await screen.rerender(<Harness left={450} top={30} options={{ side: "left", align: "end" }} />);
    expect(box(surface)).toStrictEqual({ top: 12, left: 262, right: 442, bottom: 112, width: 180, height: 100 });
  });

  it("preserves a caller's intrinsic width and minimum when measured sizing arrives after opening", async () => {
    const screen = await render(<IntrinsicHarness measured={false} />);
    const surface = screen.getByRole("dialog", { name: "intrinsic surface" }).element();
    await screen.rerender(<IntrinsicHarness measured />);
    expect(box(surface).width).toBe(300);
    await screen.rerender(<IntrinsicHarness measured long />);
    expect(box(surface).width).toBe(440);
  });

  it("lets available width and the caller's smaller maximum cap an ideal minimum", async () => {
    const screen = await render(<Harness width={600} minimum={300} options={{ maxWidth: "250px" }} />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(box(surface).width).toBe(250);
    await page.viewport(220, 600);
    await vi.waitFor(() => expect(box(surface).width).toBe(196));
    expect(box(surface).left).toBe(12);
    expect(box(surface).right).toBe(208);
  });

  it("retains CSS size limits across resizing and matches a candidate list to its anchor", async () => {
    const screen = await render(
      <Harness width={600} height={40} rows={20} options={{ maxHeight: "20vh", maxWidth: "250px" }} />,
    );
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(box(surface).width).toBe(250);
    expect(box(surface).height).toBe(120);

    await page.viewport(500, 400);
    await vi.waitFor(() => expect(box(surface).height).toBe(80));
    expect(box(surface).width).toBe(250);
    await screen.rerender(
      <Harness width={600} height={40} rows={20} options={{ matchWidth: true, maxHeight: "20vh" }} />,
    );
    expect(box(surface).width).toBe(100);
    expect(box(surface).height).toBe(80);
  });

  it("follows ancestor resizing, captured scrolling and content changes without a React update", async () => {
    const screen = await render(<Harness top={200} height={40} rows={1} options={{ maxHeight: "none" }} />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    const owner = screen.getByTestId("owner").element();
    expect(box(surface).bottom).toBe(192);

    owner.style.height = "128px";
    await vi.waitFor(() => expect(box(surface).bottom).toBe(292));
    owner.style.top = "180px";
    owner.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(box(surface).bottom).toBe(272);
    const row = screen.getByRole("button", { name: "row 0" }).element();
    row.style.height = "140px";
    await vi.waitFor(() => expect([box(surface).height, box(surface).bottom]).toStrictEqual([140, 272]));
  });

  it("reacts to a shrinking window without changing the preferred direction", async () => {
    const screen = await render(
      <Harness left={650} top={200} height={40} rows={20} options={{ side: "bottom", maxHeight: "none" }} />,
    );
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(box(surface)).toStrictEqual({ top: 236, left: 608, right: 788, bottom: 588, width: 180, height: 352 });

    await page.viewport(500, 400);
    await vi.waitFor(() =>
      expect(box(surface)).toStrictEqual({ top: 236, left: 308, right: 488, bottom: 388, width: 180, height: 152 }),
    );
  });

  it("leaves focus and event bubbling with the caller rather than introducing modal behavior", async () => {
    const screen = await render(<Harness options={{ enabled: false }} />);
    const anchor = screen.getByRole("button", { name: "anchor" }).element();
    const owner = screen.getByTestId("owner").element();
    const received = vi.fn<() => void>();
    owner.addEventListener("pointerdown", received);
    anchor.focus();

    await screen.rerender(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(document.activeElement).toBe(anchor);
    expect(surface.matches(":popover-open")).toBe(true);
    surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(received).toHaveBeenCalledTimes(1);
    owner.removeEventListener("pointerdown", received);
  });

  it("keeps a nested menu outside its parent's scroll clipping and inside the parent's DOM ownership", async () => {
    const screen = await render(<NestedHarness />);
    await screen.getByRole("button", { name: "row menu" }).click();
    const parent = screen.getByRole("dialog", { name: "parent panel" }).element();
    const menu = screen.getByRole("menu").element();
    const menuBox = box(menu);

    expect(parent.contains(menu)).toBe(true);
    expect(menu.matches(":popover-open")).toBe(true);
    expect(menuBox.bottom).toBeGreaterThan(box(parent).bottom);
    expect(menu.contains(document.elementFromPoint(menuBox.left + 10, menuBox.bottom - 10))).toBe(true);
    expect(document.querySelectorAll("[data-atrium-floating-reset]")).toHaveLength(1);
  });

  it("resolves intrinsic width independently of its previous clamped left edge", async () => {
    const screen = await render(<AutoWidthHarness />);
    const surface = screen.getByRole("menu", { name: "auto width" }).element();
    const natural = box(screen.getByTestId("natural-width").element()).width;
    const expected = { left: 788 - natural, right: 788, width: natural };
    const first = box(surface);
    expect({ left: first.left, right: first.right, width: first.width }).toStrictEqual(expected);
    await screen.rerender(<AutoWidthHarness revision={1} />);
    const second = box(surface);
    expect({ left: second.left, right: second.right, width: second.width }).toStrictEqual(expected);
    await frames();
    expect(box(surface)).toStrictEqual(second);
  });

  it("keeps floating surfaces out of native window drag regions", async () => {
    const screen = await render(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(getComputedStyle(surface).getPropertyValue("-webkit-app-region")).toBe("no-drag");
  });

  it("preserves utility padding and live theme colours rather than native popover decoration", async () => {
    const screen = await render(<ThemeHarness />);
    const surface = screen.getByRole("dialog", { name: "theme surface" }).element();
    const light = getComputedStyle(surface);
    expect([light.paddingTop, light.paddingRight, light.borderWidth, light.backgroundColor, light.color]).toStrictEqual(
      ["12px", "12px", "0px", "rgb(255, 255, 255)", "rgb(110, 110, 116)"],
    );
    expect(surface.matches(":popover-open")).toBe(true);

    document.documentElement.classList.add("dark");
    const dark = getComputedStyle(surface);
    expect([dark.paddingTop, dark.backgroundColor, dark.color]).toStrictEqual([
      "12px",
      "rgb(33, 33, 35)",
      "rgb(173, 178, 184)",
    ]);
  });

  it("suspends an open background layer under an aria-modal overlay and restores it after removal", async () => {
    const screen = await render(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    expect(surface.matches(":popover-open")).toBe(true);
    const { overlay } = customModal();

    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(false));
    expect(overlay.contains(document.elementFromPoint(150, 230))).toBe(true);
    await screen.rerender(<Harness width={200} />);
    expect(surface.matches(":popover-open")).toBe(false);
    expect(overlay.contains(document.elementFromPoint(150, 230))).toBe(true);
    overlay.remove();
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(true));
    expect(surface.contains(document.elementFromPoint(150, 230))).toBe(true);
  });

  it("keeps modal-owned menus usable while background layers remain suspended", async () => {
    const background = await render(<Harness />);
    const surface = background.getByRole("dialog", { name: "surface" }).element();
    const screen = await render(<ModalHarness />);
    const menu = screen.getByRole("menu", { name: "modal menu" }).element();
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(false));
    expect(menu.matches(":popover-open")).toBe(true);
    const rect = menu.getBoundingClientRect();
    expect(menu.contains(document.elementFromPoint(rect.left + 10, rect.top + 10))).toBe(true);
    await screen.getByRole("button", { name: "modal action" }).click();
    await screen.unmount();
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(true));
  });

  it("does not promote a newly mounted background layer above an existing modal", async () => {
    const { overlay } = customModal();
    const screen = await render(<Harness />);
    const surface = screen.getByTestId("surface").element();
    expect(surface.matches(":popover-open")).toBe(false);
    expect(overlay.contains(document.elementFromPoint(150, 230))).toBe(true);
    overlay.remove();
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(true));
  });

  it("tracks modal display, ancestor visibility and aria-modal changes without remounting", async () => {
    const screen = await render(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    const { overlay, modal } = customModal();
    modal.style.display = "none";
    await frames();
    expect(surface.matches(":popover-open")).toBe(true);
    modal.style.display = "block";
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(false));
    overlay.hidden = true;
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(true));
    overlay.hidden = false;
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(false));
    modal.setAttribute("aria-modal", "false");
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(true));
    modal.setAttribute("aria-modal", "true");
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(false));
  });

  it("suspends an inert anchor's layer and resumes it when the inert state is removed", async () => {
    const screen = await render(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    const owner = screen.getByTestId("owner").element();
    owner.setAttribute("inert", "");
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(false));
    owner.removeAttribute("inert");
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(true));
  });

  it("respects a native modal opened after the background layer and resumes after close", async () => {
    const screen = await render(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    const modal = document.createElement("dialog");
    modal.style.cssText = "width:300px;height:300px;background:white";
    document.body.append(modal);
    onTestFinished(() => modal.remove());
    modal.showModal();
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(false));
    await screen.rerender(<Harness width={200} />);
    expect(surface.matches(":popover-open")).toBe(false);
    modal.close();
    await vi.waitFor(() => expect(surface.matches(":popover-open")).toBe(true));
  });

  it("ignores unrelated streaming DOM changes instead of forcing floating layout work", async () => {
    const screen = await render(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    const stream = document.createElement("div");
    stream.style.cssText = "position:fixed;top:10px;left:10px;width:40px;height:40px;overflow:hidden";
    document.body.append(stream);
    onTestFinished(() => stream.remove());
    await frames();
    const measured = vi.spyOn(surface, "getBoundingClientRect");
    stream.append(document.createElement("span"));
    stream.firstElementChild!.textContent = "streamed response";
    stream.firstElementChild!.setAttribute("class", "text-sm");
    await frames();
    expect(measured).not.toHaveBeenCalled();
    expect(surface.matches(":popover-open")).toBe(true);
  });

  it("releases observers, listeners, its reset and native popover state when disabled or unmounted", async () => {
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
    const modalObserves = vi.spyOn(MutationObserver.prototype, "observe");
    const modalDisconnects = vi.spyOn(MutationObserver.prototype, "disconnect");
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const screen = await render(<Harness />);
    const surface = screen.getByRole("dialog", { name: "surface" }).element();
    const scroll = added.mock.calls.find(([name]) => name === "scroll");
    const resize = added.mock.calls.find(([name]) => name === "resize");
    expect(observe.mock.calls.map(([element]) => element)).toContain(surface);
    const modalIndex = modalObserves.mock.calls.findIndex(modalObservation);
    expect(modalIndex).toBeGreaterThanOrEqual(0);
    const modalWatcher = modalObserves.mock.contexts[modalIndex]!;
    expect(document.querySelectorAll("[data-atrium-floating-reset]")).toHaveLength(1);

    await screen.rerender(<Harness options={{ enabled: false }} />);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(modalDisconnects.mock.contexts).toContain(modalWatcher);
    expect(removed.mock.calls).toContainEqual(scroll);
    expect(removed.mock.calls).toContainEqual(resize);
    expect(surface.matches(":popover-open")).toBe(false);
    expect(surface.hasAttribute("popover")).toBe(false);
    expect(surface.style.maxHeight).toBe("100px");
    expect(document.querySelectorAll("[data-atrium-floating-reset]")).toHaveLength(0);

    await screen.rerender(<Harness />);
    expect(surface.matches(":popover-open")).toBe(true);
    const replacementIndex = modalObserves.mock.calls.findLastIndex(modalObservation);
    const replacementWatcher = modalObserves.mock.contexts[replacementIndex]!;
    await screen.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(modalDisconnects.mock.contexts).toContain(replacementWatcher);
    expect(document.querySelectorAll("[data-atrium-floating-reset]")).toHaveLength(0);
  });
});
