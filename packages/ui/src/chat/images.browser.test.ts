import { describe, expect, it } from "vitest";
import { ImageTooLargeError, compressImage } from "./images";

/**
 * A PNG of the given size, noisy so it does not compress to nothing.
 *
 * @remarks
 * Drawn on a canvas, as a screenshot would arrive.
 *
 * @sideEffects Creates a canvas.
 * @param width - Its width.
 * @param height - Its height.
 * @returns The image.
 */
async function png(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  const pixels = context.createImageData(width, height);
  let seed = 7;
  for (let index = 0; index < pixels.data.length; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    pixels.data[index] = index % 4 === 3 ? 255 : seed % 256;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/** The size of a WebP given as base64. */
async function sizeOf(data: string): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(await (await fetch(`data:image/webp;base64,${data}`)).blob());
  return { width: bitmap.width, height: bitmap.height };
}

describe("compressImage", () => {
  it("makes a WebP no longer than 2048 px and small enough for one message", async () => {
    const compressed = await compressImage(await png(4000, 1000));

    expect(compressed.mimeType).toBe("image/webp");
    expect(compressed.data.length).toBeLessThanOrEqual(1_000_000);
    expect(await sizeOf(compressed.data)).toStrictEqual({ width: 2048, height: 512 });
    expect(compressed.preview.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("keeps a small image's size", async () => {
    const compressed = await compressImage(await png(300, 200));
    const tiny = await compressImage(await png(40, 30));

    expect(await sizeOf(compressed.data)).toStrictEqual({ width: 300, height: 200 });
    expect(await sizeOf(tiny.data)).toStrictEqual({ width: 40, height: 30 });
  });

  it("lowers the quality, then the size, until it fits", async () => {
    const roomy = await compressImage(await png(1200, 1200));
    const tight = await compressImage(await png(1200, 1200), 60_000);

    expect(tight.data.length).toBeLessThanOrEqual(60_000);
    expect(tight.data.length).toBeLessThan(roomy.data.length);
  });

  it("gives up on an image that will not fit", async () => {
    await expect(compressImage(await png(800, 800), 10)).rejects.toBeInstanceOf(ImageTooLargeError);
  });

  it("refuses what is not an image", async () => {
    await expect(compressImage(new Blob(["not an image"], { type: "text/plain" }))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });
});
