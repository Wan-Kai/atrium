import { describe, expect, it, onTestFinished } from "vitest";
import { render } from "vitest-browser-react";
import { FileIcon } from "./file-icon";
import "../styles.css";

/**
 * The icons shown, by name, once each has loaded.
 *
 * @remarks
 * Only the shown ones count: where the theme has a light variant, both are in the page.
 *
 * @sideEffects none
 * @param container - What holds the icons.
 * @returns Each shown icon's name, and whether its picture loaded.
 */
async function shown(container: Element): Promise<[string, boolean][]> {
  const icons = [...container.querySelectorAll<HTMLImageElement>('[data-testid="file-icon"]')];
  await Promise.all(icons.map((icon) => icon.decode().catch(() => undefined)));
  return icons
    .filter((icon) => getComputedStyle(icon).display !== "none")
    .map((icon) => [icon.getAttribute("data-icon") ?? "", icon.naturalWidth > 0]);
}

describe("FileIcon", () => {
  it("shows the theme's icon, its light variant in the light appearance, loaded from the app's files", async () => {
    const screen = await render(
      <div>
        <FileIcon path="src/panes.ts" size={16} />
        <FileIcon path="pnpm-lock.yaml" size={16} />
      </div>,
    );

    expect(await shown(screen.container)).toStrictEqual([
      ["typescript", true],
      ["pnpm_light", true],
    ]);
    document.documentElement.classList.add("dark");
    onTestFinished(() => document.documentElement.classList.remove("dark"));
    expect(await shown(screen.container)).toStrictEqual([
      ["typescript", true],
      ["pnpm", true],
    ]);
  });

  it("is decoration, at the size asked for", async () => {
    const screen = await render(<FileIcon path="a.md" size={13} />);
    const icons = screen.container.querySelectorAll("img");
    const icon = icons[0];

    expect([
      icon?.getAttribute("alt"),
      icon?.getAttribute("aria-hidden"),
      icon?.width,
      icon?.height,
      icons.length,
    ]).toStrictEqual(["", "true", 13, 13, 1]);
  });
});
