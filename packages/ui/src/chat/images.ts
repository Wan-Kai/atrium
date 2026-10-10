/** The longest edge an image is sent at; models shrink larger ones anyway (SPEC-0001, "附件"). */
const LONGEST_EDGE = 2048;
/** Base64 characters an upload may have, so one WebSocket message stays under 1 MiB. */
const MAX_CHARS = 1_000_000;
/** The WebP qualities tried, best first. */
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];
/** Each smaller try keeps this much of the edge. */
const SHRINK = 0.75;
/** No image is made smaller than this on its longest edge. */
const SMALLEST_EDGE = 256;

/** An image ready to upload. */
export interface CompressedImage {
  readonly mimeType: "image/webp";
  /** Base64, without a `data:` prefix. */
  readonly data: string;
  /** A data URL to show it with. */
  readonly preview: string;
}

/**
 * An image that does not fit an upload however much it is shrunk.
 *
 * @remarks
 * The UI says the image is too large (SPEC-0001, "附件").
 *
 * @sideEffects none
 */
export class ImageTooLargeError extends Error {
  override readonly name = "ImageTooLargeError";
}

/**
 * Compresses a pasted, dropped or chosen image for upload.
 *
 * @remarks
 * SPEC-0001 ("附件"): the longest edge at most 2048 px, as WebP; still over the limit, the
 * quality goes down, then the size, until it fits, and an image that never fits is refused. The
 * limit keeps the base64 within one WebSocket message.
 *
 * @sideEffects Decodes and draws the image off screen.
 * @param image - The image.
 * @param maxChars - The most base64 characters it may take; tests lower it.
 * @returns The compressed image.
 * @throws {ImageTooLargeError} When it cannot be made small enough.
 * @throws {Error} When it is not an image the browser can read.
 */
export async function compressImage(image: Blob, maxChars = MAX_CHARS): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(image);
  try {
    let scale = Math.min(1, LONGEST_EDGE / Math.max(bitmap.width, bitmap.height));
    // Tried at its own size first, however small; then smaller, down to `SMALLEST_EDGE`.
    for (let first = true; first || Math.max(bitmap.width, bitmap.height) * scale >= SMALLEST_EDGE; first = false) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
      for (const quality of QUALITIES) {
        const data = await base64Of(await canvas.convertToBlob({ type: "image/webp", quality }));
        if (data.length <= maxChars) return { mimeType: "image/webp", data, preview: `data:image/webp;base64,${data}` };
      }
      scale *= SHRINK;
    }
    throw new ImageTooLargeError("the image does not fit an upload");
  } finally {
    bitmap.close();
  }
}

/**
 * A blob as base64.
 *
 * @remarks
 * Through a data URL, which the browser encodes natively.
 *
 * @sideEffects Reads the blob.
 * @param blob - The blob.
 * @returns Its base64, without a `data:` prefix.
 */
async function base64Of(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(typeof reader.result === "string" ? reader.result : ""));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("could not read the image")));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}
