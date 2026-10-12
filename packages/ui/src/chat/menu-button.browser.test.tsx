import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { MENU_ITEM, MenuButton } from "./menu-button";

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
