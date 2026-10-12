import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ArrowUp, Check, DotsThree, MagnifyingGlass, MetaLogo, Square } from "./icons";

/**
 * Renders an icon and returns its SVG.
 *
 * @remarks
 * The icons draw nothing but an SVG.
 *
 * @sideEffects Renders.
 * @param icon - The icon element.
 * @returns The SVG.
 */
async function svgOf(icon: React.ReactElement): Promise<SVGSVGElement> {
  const screen = await render(icon);
  const svg = screen.container.querySelector("svg");
  expect(svg).not.toBeNull();
  return svg as SVGSVGElement;
}

/**
 * The line widths of an SVG's shapes.
 *
 * @remarks
 * Each shape carries its own width.
 *
 * @sideEffects none
 * @param svg - The SVG.
 * @returns The widths.
 */
function widths(svg: SVGSVGElement): string[] {
  return [...svg.querySelectorAll("path, circle, rect")].map((shape) => shape.getAttribute("stroke-width") ?? "");
}

describe("icons", () => {
  it("draw a line 1.75 wide, follow the text's size when not given one, and take the SVG's attributes", async () => {
    const svg = await svgOf(<MagnifyingGlass className="search" aria-label="搜索" />);

    expect(widths(svg)).toStrictEqual(["1.75", "1.75"]);
    expect(svg.getAttribute("width")).toBe("1em");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("class")).toBe("search");
    expect(svg.getAttribute("aria-label")).toBe("搜索");
  });

  it("draw bold lines wider, each icon as wide as it is set", async () => {
    expect(widths(await svgOf(<Check size={12} weight="bold" />))).toStrictEqual(["2.25"]);
    expect(new Set(widths(await svgOf(<DotsThree weight="bold" />)))).toStrictEqual(new Set(["2.5"]));
    expect(new Set(widths(await svgOf(<ArrowUp weight="bold" />)))).toStrictEqual(new Set(["2.5"]));
  });

  it("fill a filled shape, keeping its outline", async () => {
    const svg = await svgOf(<Square size={12} weight="fill" />);

    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("width")).toBe("12");
    expect(new Set(widths(svg))).toStrictEqual(new Set(["1.75"]));
  });

  it("draw Meta's mark from Tabler's shape, at the same width", async () => {
    const svg = await svgOf(<MetaLogo size={20} />);

    expect(widths(svg)).toStrictEqual(["1.75"]);
    expect(svg.innerHTML).toContain('d="M12 10.174Q14.649 5.999 16.648 6c2');
  });
});
