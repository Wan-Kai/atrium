import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { MENU_ITEM, MenuButton } from "./menu-button";

beforeEach(() => page.viewport(1280, 820));

/**
 * Renders a menu button with one item, beside some text to click on, inside a panel listening for Escape.
 *
 * @remarks
 * The panel stands for what holds a menu, such as the settings, which closes on Escape too.
 *
 * @sideEffects Renders.
 * @returns The screen, what the item was chosen with, and the panel's Escapes.
 */
async function menu() {
  const chosen = vi.fn<() => void>();
  const panelEscape = vi.fn<() => void>();
  const screen = await render(
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") panelEscape();
      }}
    >
      <p>别处</p>
      <MenuButton label="菜单" content="···">
        {(close) => (
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              close();
              chosen();
            }}
          >
            一项
          </button>
        )}
      </MenuButton>
    </div>,
  );
  return { screen, chosen, panelEscape };
}

describe("MenuButton", () => {
  it.each([
    { variant: "regular", props: {}, width: 176 },
    { variant: "field", props: { field: true }, width: 224 },
    { variant: "chip", props: { chip: true }, width: 224 },
  ])("keeps the $variant menu's ideal width when an item has a long name", async ({ props, width }) => {
    const screen = await render(
      <div style={{ position: "fixed", left: 400, top: 400, width: 80 }}>
        <MenuButton {...props} label="长名称菜单" content="选择">
          {() => (
            <button type="button" role="menuitem" className={MENU_ITEM}>
              {"无空格长名称".repeat(80)}
            </button>
          )}
        </MenuButton>
        <div aria-hidden style={{ position: "fixed", left: 800, top: 400, width: 80 }}>
          <div className="relative">
            <span className="block h-7">旧绝对定位参照</span>
            <div data-testid="legacy-menu" className="absolute top-full right-0 p-1" style={{ minWidth: width }}>
              <button type="button" tabIndex={-1} className={MENU_ITEM}>
                {"无空格长名称".repeat(80)}
              </button>
            </div>
          </div>
        </div>
      </div>,
    );
    await screen.getByRole("button", { name: "长名称菜单" }).click();
    const panel = screen.getByRole("menu").element();
    expect(screen.getByTestId("legacy-menu").element().getBoundingClientRect().width).toBe(width);
    expect(panel.getBoundingClientRect().width).toBe(width);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  });

  it("keeps an explicitly wide menu body wider than the ordinary minimum", async () => {
    const screen = await render(
      <div style={{ position: "fixed", left: 400, top: 200, width: 80 }}>
        <MenuButton label="历史宽列表" content="历史">
          {() => <div style={{ width: 288 }}>历史内容</div>}
        </MenuButton>
      </div>,
    );
    await screen.getByRole("button", { name: "历史宽列表" }).click();
    expect(screen.getByRole("menu").element().getBoundingClientRect().width).toBe(296);
  });

  it("keeps a long menu inside the viewport and outside its clipping parent, following resize", async () => {
    await page.viewport(480, 340);
    const screen = await render(
      <div
        style={{
          position: "fixed",
          right: 4,
          bottom: 4,
          width: 80,
          height: 40,
          overflow: "hidden",
          filter: "opacity(1)",
        }}
      >
        <MenuButton label="边缘菜单" content="···">
          {(close) =>
            Array.from({ length: 30 }, (_, at) => (
              <button key={at} type="button" role="menuitem" className={MENU_ITEM} onClick={close}>
                操作 {at}
              </button>
            ))
          }
        </MenuButton>
      </div>,
    );
    await screen.getByRole("button", { name: "边缘菜单" }).click();
    const panel = screen.getByRole("menu").element();
    await expect.poll(() => Math.round(panel.getBoundingClientRect().top)).toBeGreaterThanOrEqual(12);
    expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(468);
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(328);
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
    const first = screen.getByRole("menuitem", { name: "操作 0", exact: true }).element();
    const box = first.getBoundingClientRect();
    expect(first.contains(document.elementFromPoint(box.left + 8, box.top + 8))).toBe(true);
    await page.viewport(360, 280);
    await expect.poll(() => panel.getBoundingClientRect().right).toBeLessThanOrEqual(348);
    await expect.poll(() => panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(268);
    await screen.getByRole("menuitem", { name: "操作 29", exact: true }).click();
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    await page.viewport(1280, 820);
  });
  it("opens below its button and closes once an item is chosen", async () => {
    const { screen, chosen } = await menu();
    const button = screen.getByRole("button", { name: "菜单" });

    await expect.element(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect.element(button).toHaveAttribute("aria-expanded", "true");
    await screen.getByRole("menuitem", { name: "一项" }).click();

    expect(chosen).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape, keeping it from what holds the menu, and on a click elsewhere", async () => {
    const { screen, panelEscape } = await menu();
    const button = screen.getByRole("button", { name: "菜单" });

    await button.click();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    expect(panelEscape).not.toHaveBeenCalled();
    await button.click();
    // A press inside the menu, not on its item, keeps it open.
    screen
      .getByRole("menu")
      .element()
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.element(screen.getByRole("menu")).toBeVisible();
    await screen.getByText("别处").click();
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
  });
});
