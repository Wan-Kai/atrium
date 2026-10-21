/** Dimensions of an image or its available viewport, in CSS pixels. */
interface Size {
  /** Horizontal extent. */
  readonly width: number;
  /** Vertical extent. */
  readonly height: number;
}

/** An image's displacement from the viewport center. */
interface Offset {
  /** Horizontal displacement. */
  readonly x: number;
  /** Vertical displacement. */
  readonly y: number;
}

/**
 * Resolves image scale and bounded displacement inside the preview canvas.
 *
 * @remarks Fit can go below the manual 25 percent minimum to keep a large original fully visible.
 * @sideEffects none
 * @param image - Positive natural image dimensions.
 * @param viewport - Available canvas dimensions.
 * @param scale - Requested original-relative scale, or null for fit.
 * @param offset - Requested displacement from the canvas center.
 * @returns The scale and displacement to display.
 */
export function imagePreviewLayout(image: Size, viewport: Size, scale: number | null, offset: Offset) {
  const width = Math.max(1, viewport.width - 48);
  const height = Math.max(1, viewport.height - 48);
  const resolvedScale =
    scale === null ? Math.min(1, width / image.width, height / image.height) : Math.max(0.25, Math.min(4, scale));
  const maxX = Math.max(0, (image.width * resolvedScale - width) / 2);
  const maxY = Math.max(0, (image.height * resolvedScale - height) / 2);
  return {
    scale: resolvedScale,
    x: scale === null || maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, offset.x)),
    y: scale === null || maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, offset.y)),
  };
}
