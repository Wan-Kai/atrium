import { describe, expect, it } from "vitest";
import { imagePreviewLayout } from "./image-preview-layout";

describe("imagePreviewLayout", () => {
  it("fits with 24 px padding without enlarging small originals", () => {
    expect(
      imagePreviewLayout({ width: 100, height: 80 }, { width: 800, height: 600 }, null, { x: 0, y: 0 }),
    ).toStrictEqual({ scale: 1, x: 0, y: 0 });
    expect(
      imagePreviewLayout({ width: 1600, height: 800 }, { width: 848, height: 648 }, null, { x: 99, y: -99 }),
    ).toStrictEqual({ scale: 0.5, x: 0, y: 0 });
  });

  it("allows a complete fit below 25 percent for very large originals", () => {
    expect(
      imagePreviewLayout({ width: 8000, height: 4000 }, { width: 848, height: 648 }, null, { x: 0, y: 0 }),
    ).toStrictEqual({ scale: 0.1, x: 0, y: 0 });
  });

  it("clamps manual scale to 25–400 percent and panning to the image edges", () => {
    expect(
      imagePreviewLayout({ width: 400, height: 300 }, { width: 848, height: 648 }, 10, { x: 9999, y: -9999 }),
    ).toStrictEqual({ scale: 4, x: 400, y: -300 });
    expect(
      imagePreviewLayout({ width: 400, height: 300 }, { width: 848, height: 648 }, 0, { x: 9999, y: -9999 }),
    ).toStrictEqual({ scale: 0.25, x: 0, y: 0 });
  });

  it("centers fit exactly despite floating point overshoot and normalizes zero pan offsets", () => {
    expect(
      imagePreviewLayout({ width: 25, height: 25 }, { width: 55, height: 55 }, null, { x: 999, y: -999 }),
    ).toStrictEqual({ scale: 0.28, x: 0, y: 0 });
    expect(
      imagePreviewLayout({ width: 100, height: 100 }, { width: 848, height: 648 }, 1, { x: -999, y: -999 }),
    ).toStrictEqual({ scale: 1, x: 0, y: 0 });
    expect(
      imagePreviewLayout({ width: 400, height: 300 }, { width: 848, height: 648 }, 4, { x: -999, y: 999 }),
    ).toStrictEqual({ scale: 4, x: -400, y: 300 });
  });

  it("fits tall images and handles a viewport smaller than its padding", () => {
    expect(
      imagePreviewLayout({ width: 100, height: 1000 }, { width: 848, height: 548 }, null, { x: 0, y: 0 }),
    ).toStrictEqual({ scale: 0.5, x: 0, y: 0 });
    expect(
      imagePreviewLayout({ width: 100, height: 100 }, { width: 20, height: 20 }, null, { x: 0, y: 0 }),
    ).toStrictEqual({ scale: 0.01, x: 0, y: 0 });
  });
});
