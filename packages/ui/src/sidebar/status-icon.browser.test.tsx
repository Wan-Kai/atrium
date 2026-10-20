import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { StatusIcon } from "./status-icon";

describe("StatusIcon", () => {
  it("shows a running session as the running dots in the tint colour, and no other status so", async () => {
    const screen = await render(
      <>
        <StatusIcon status="running" />
        <StatusIcon status="asking" />
        <StatusIcon status="auth" />
        <StatusIcon status="error" />
      </>,
    );
    const icons = [...screen.container.querySelectorAll("span[role=img]")];

    expect(
      icons.map((icon) => [
        icon.getAttribute("aria-label"),
        icon.querySelector('[data-testid="running-dots"]')?.getAttribute("width"),
      ]),
    ).toStrictEqual([
      ["运行中", "14"],
      ["待回答", undefined],
      ["待授权", undefined],
      ["出错", undefined],
    ]);
    const tint = document.createElement("span");
    tint.style.color = "var(--tint)";
    document.body.append(tint);
    expect(getComputedStyle(icons[0] as Element).color).toBe(getComputedStyle(tint).color);
    tint.remove();
  });
});
