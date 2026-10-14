import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { createPanes, memoryStorage } from "../state/panes";
import { createWorkspaceViews } from "../state/workspace-views";
import { fakeClient } from "../test/fake-client";
import { ChangesPane } from "./changes-pane";

const W = "wks_0000000000000001";
const PANE_CURVE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** The panel's 320px, as its CSS fits it to the room. */
const FITTED = "max(240px, min(320px, 100% - 440px))";

/**
 * The pane beside a conversation, the two sharing a room of the width given.
 *
 * @sideEffects Renders into the page.
 * @param options - The room's width, the workspace, and whether the panel starts open.
 * @returns The screen, the client, the panes, the pane, and how to show another workspace or a chat.
 */
async function pane({
  room = 1200,
  workspaceId = W,
  open = true,
}: { room?: number; workspaceId?: string | null; open?: boolean } = {}) {
  const { client } = fakeClient();
  const panes = createPanes(memoryStorage());
  const views = createWorkspaceViews(memoryStorage());
  panes.getState().setPanelOpen(open);
  /**
   * The room, with the pane in it.
   *
   * @sideEffects none
   * @param shown - The workspace shown, or `null` for a chat.
   * @returns The elements.
   */
  const at = (shown: string | null) => (
    <div style={{ position: "relative", display: "flex", width: room, height: 600, overflowX: "clip" }}>
      <div style={{ flex: 1, minWidth: 0 }} />
      <ChangesPane client={client} workspaceId={shown} panes={panes} views={views} />
    </div>
  );
  const screen = await render(at(workspaceId));
  return {
    screen,
    client,
    panes,
    element: screen.getByTestId("changes-pane").element(),
    show: (shown: string | null) => screen.rerender(at(shown)),
  };
}

/**
 * The widths a CSS transition on an element goes between.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Each transition's property and its first and last widths.
 */
function widthFrames(element: Element): unknown[] {
  return element
    .getAnimations()
    .map((animation) => [
      (animation as CSSTransition).transitionProperty,
      (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame["width"]),
    ]);
}

/**
 * Drags the separator sideways by the distance given.
 *
 * @remarks
 * As a mouse would: pressed on the separator, moved and let go over the window.
 *
 * @sideEffects Dispatches events.
 * @param separator - The separator.
 * @param by - How far to move it, rightwards.
 */
function drag(separator: Element, by: number): void {
  const rect = separator.getBoundingClientRect();
  const at = (x: number) => ({ clientX: x, clientY: rect.top + 20, bubbles: true, pointerId: 1, isPrimary: true });
  separator.dispatchEvent(new PointerEvent("pointerdown", at(rect.left + 4)));
  window.dispatchEvent(new PointerEvent("pointermove", at(rect.left + 4 + by / 2)));
  window.dispatchEvent(new PointerEvent("pointermove", at(rect.left + 4 + by)));
  window.dispatchEvent(new PointerEvent("pointerup", at(rect.left + 4 + by)));
}

/**
 * What the pane's and the panel's own transitions move.
 *
 * @sideEffects none
 * @param element - The pane.
 * @param panel - The panel in it.
 * @returns The properties each moves.
 */
function moves(element: Element, panel: Element): string[][] {
  return [element, panel.parentElement as Element].map((each) =>
    each.getAnimations().map((animation) => (animation as CSSTransition).transitionProperty),
  );
}

/**
 * Where the panel is a third of the way through the pane's transitions, and whether it shows past the pane.
 *
 * @sideEffects Pauses the pane's transitions there.
 * @param element - The pane.
 * @param panel - The panel in it.
 * @returns How far the panel's left edge is from the pane's, its width, whether the pane is between 0 and the
 * panel's width, and whether the panel is what shows 20px right of the pane.
 */
function midway(element: Element, panel: Element): unknown[] {
  for (const transition of element.getAnimations({ subtree: true })) {
    transition.pause();
    transition.currentTime = 80;
  }
  const [box, shown] = [element.getBoundingClientRect(), panel.getBoundingClientRect()];
  return [
    Math.abs(Math.round(shown.left - box.left)),
    Math.round(shown.width),
    box.width > 0,
    box.width < shown.width,
    panel.contains(document.elementFromPoint(box.right + 20, box.top + 300)),
  ];
}

describe("ChangesPane", () => {
  it("opens from nothing in 0.24 s, the panel at its width from the start, and closes back to nothing before it goes", async () => {
    const { screen, panes, element } = await pane({ open: false });
    expect([element.getBoundingClientRect().width, element.childElementCount]).toStrictEqual([0, 0]);

    panes.getState().setPanelOpen(true);

    const panel = screen.getByRole("complementary", { name: "文件与更改" });
    await expect.element(panel).toBeInTheDocument();
    const style = getComputedStyle(element);
    expect([style.transitionProperty, style.transitionDuration, style.transitionTimingFunction]).toStrictEqual([
      "width",
      "0.24s",
      PANE_CURVE,
    ]);
    expect(widthFrames(element)).toStrictEqual([["width", ["0px", FITTED]]]);
    expect(panel.element().getBoundingClientRect().width).toBe(320);
    await expect.poll(() => element.getBoundingClientRect().width).toBe(320);
    panes.getState().setPanelOpen(false);

    await expect.poll(() => widthFrames(element)).toStrictEqual([["width", [FITTED, "0px"]]]);
    // A transition inside the panel ending first leaves it be.
    panel.element().dispatchEvent(new TransitionEvent("transitionend", { bubbles: true, propertyName: "opacity" }));
    expect(panel.element().isConnected).toBe(true);
    await expect.element(panel).not.toBeInTheDocument();
    expect(element.getBoundingClientRect().width).toBe(0);
  });

  it("shows the panel at once, not sliding in, when open from the first frame", async () => {
    const { screen, element } = await pane();
    const panel = screen.getByRole("complementary", { name: "文件与更改" }).element();

    expect(moves(element, panel)).toStrictEqual([[], []]);
  });

  it("goes when closed just as it starts opening", async () => {
    const { screen, panes, element } = await pane({ open: false });
    const panel = screen.getByRole("complementary", { name: "文件与更改" });
    // Its style drawn closed, so opening moves it from there.
    expect(getComputedStyle(element).width).toBe("0px");
    panes.getState().setPanelOpen(true);
    await expect.poll(() => element.getAnimations().length).toBe(1);
    // Still at 0 wide: closing leaves nothing to move, so the opening is cancelled, not ended.
    const opening = element.getAnimations().at(0) as Animation;
    opening.pause();
    opening.currentTime = 0;

    panes.getState().setPanelOpen(false);

    await expect.element(panel).not.toBeInTheDocument();
    expect(element.getBoundingClientRect().width).toBe(0);
  });

  it("slides the panel out with its edge as it closes and in as it opens, cut off at the room's edge", async () => {
    await page.viewport(1280, 800);
    const { screen, panes, element } = await pane({ room: 700 });
    const panel = screen.getByRole("complementary", { name: "文件与更改" }).element();
    await expect.poll(() => element.getBoundingClientRect().width).toBe(260);

    panes.getState().setPanelOpen(false);
    await expect.poll(() => moves(element, panel)).toStrictEqual([["width"], ["translate"]]);
    const closing = midway(element, panel);
    (element.getAnimations().at(0) as Animation).finish();
    await expect.element(screen.getByRole("complementary", { name: "文件与更改" })).not.toBeInTheDocument();
    panes.getState().setPanelOpen(true);
    const reopened = screen.getByRole("complementary", { name: "文件与更改" });
    await expect.element(reopened).toBeInTheDocument();
    await expect.poll(() => moves(element, reopened.element())).toStrictEqual([["width"], ["translate"]]);
    const opening = midway(element, reopened.element());

    expect([closing, opening]).toStrictEqual([
      [0, 260, true, true, false],
      [0, 260, true, true, false],
    ]);
  });

  it("widens as its edge is dragged left, from 240px to what leaves the conversation 440px, back to 320px on a double click", async () => {
    const { screen, panes, element } = await pane({ room: 1200 });
    const separator = screen.getByRole("separator", { name: "右栏的宽度" });
    const widths: unknown[] = [element.getBoundingClientRect().width];

    for (const by of [-100, -1000, 2000]) {
      drag(separator.element(), by);
      await expect.poll(() => element.getBoundingClientRect().width).toBe(panes.getState().panelWidth);
      widths.push(panes.getState().panelWidth);
    }
    await separator.dblClick();
    await expect.poll(() => element.getBoundingClientRect().width).toBe(320);
    widths.push(panes.getState().panelWidth);

    expect(widths).toStrictEqual([320, 420, 760, 240, 320]);
    expect(separator.element().getAttribute("aria-valuenow")).toBe("320");
  });

  it("follows the pointer at once while dragged, its line showing, and moves smoothly again once let go", async () => {
    const { screen, element } = await pane();
    const separator = screen.getByRole("separator", { name: "右栏的宽度" }).element();
    const rect = separator.getBoundingClientRect();
    const line = () => getComputedStyle(separator, "::after");
    expect([line().opacity, line().width, line().backgroundColor]).toStrictEqual(["0", "2px", "rgb(47, 111, 237)"]);

    separator.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left - 40, bubbles: true }));

    await expect.poll(() => element.getBoundingClientRect().width).toBe(360);
    await expect.poll(() => line().opacity).toBe("1");
    expect([getComputedStyle(element).transitionDuration, element.getAnimations()]).toStrictEqual(["0s", []]);
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: rect.left - 40, bubbles: true }));
    await expect.poll(() => separator.hasAttribute("data-dragging")).toBe(false);
    expect(getComputedStyle(element).transitionDuration).toBe("0.24s");
  });

  it("steps 16px with the arrow keys on its edge", async () => {
    const { screen, panes } = await pane();
    const separator = screen.getByRole("separator", { name: "右栏的宽度" });
    const widths: number[] = [];

    for (const key of ["{ArrowLeft}", "{ArrowRight}", "{ArrowRight}", "{ArrowUp}"]) {
      separator.element().focus();
      await userEvent.keyboard(key);
      widths.push(panes.getState().panelWidth);
    }

    expect(widths).toStrictEqual([336, 320, 304, 304]);
  });

  it("narrows to leave the conversation 440px while the room is short, keeping the width chosen, and drags from the width shown", async () => {
    const { screen, panes, element } = await pane({ room: 720 });
    const narrowed = [element.getBoundingClientRect().width, panes.getState().panelWidth];

    drag(screen.getByRole("separator", { name: "右栏的宽度" }).element(), 20);

    expect([narrowed, panes.getState().panelWidth]).toStrictEqual([[280, 320], 260]);
  });

  it("keeps 240px when the room has not even that beside the conversation's 440px", async () => {
    const { element } = await pane({ room: 600 });

    expect(element.getBoundingClientRect().width).toBe(240);
  });

  it("stops following the pointer once gone mid-drag", async () => {
    const { screen, panes } = await pane();
    const separator = screen.getByRole("separator", { name: "右栏的宽度" }).element();
    const rect = separator.getBoundingClientRect();
    separator.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left, bubbles: true }));

    await screen.unmount();
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left - 100, bubbles: true }));

    expect(panes.getState().panelWidth).toBe(320);
  });

  it("hides at once in a chat, showing nothing, and opens again back in a workspace", async () => {
    const { screen, show, element } = await pane();
    const panel = screen.getByRole("complementary", { name: "文件与更改" });
    await expect.element(panel).toBeVisible();

    await show(null);

    expect([element.getBoundingClientRect().width, element.childElementCount, element.getAnimations()]).toStrictEqual([
      0,
      0,
      [],
    ]);
    await show(W);
    await expect.element(panel).toBeVisible();
    expect(widthFrames(element)).toStrictEqual([["width", ["0px", FITTED]]]);
  });

  it("keeps each workspace's mode its own", async () => {
    const { screen, client, show } = await pane();
    const dirty = { stat: { added: 1, removed: 0 }, dirty: true, ahead: 0, branch: "feat", base: "origin/main" };
    client.changes(W).setState(dirty);
    client.changes("wks_0000000000000002").setState(dirty);
    const mode = screen.getByRole("button", { name: "比较" });
    await mode.click();
    await screen.getByRole("menuitemradio", { name: /已提交/ }).click();
    await expect.element(mode).toHaveTextContent("已提交");

    await show("wks_0000000000000002");
    await expect.element(mode).toHaveTextContent("未提交");
    await show(W);

    await expect.element(mode).toHaveTextContent("已提交");
  });
});
