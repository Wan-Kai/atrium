import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { FastToggle } from "./fast-toggle";

afterEach(() => page.viewport(1280, 820));

describe("FastToggle's hint bounds", () => {
  it("avoids the viewport's top and left edges without changing the Fast action", async () => {
    await page.viewport(360, 300);
    const calls: boolean[] = [];
    const screen = await render(
      <div style={{ position: "fixed", top: 16, left: 0 }}>
        <FastToggle
          enabled={false}
          fast={{ speed: 2, moreUsage: true }}
          disabled={false}
          onToggle={(value) => calls.push(value)}
        />
      </div>,
    );
    await screen.getByRole("button", { name: "Fast", exact: true }).hover();
    const hint = screen.getByRole("tooltip");
    await expect.element(hint).toBeVisible();
    await expect.poll(() => hint.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(12);
    expect(hint.element().getBoundingClientRect().left).toBeGreaterThanOrEqual(12);
    expect(hint.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(288);
    await screen.getByRole("button", { name: "Fast", exact: true }).click();
    expect(calls).toStrictEqual([true]);
  });
});
