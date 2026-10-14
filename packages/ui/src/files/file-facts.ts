/** Past these a file shows without colours (SPEC-0001, "M1.12 的文件与更改 · 查看标签"). */
const HIGHLIGHT_LIMITS = { lines: 5000, bytes: 200 * 1024 } as const;

/**
 * A file's size as the viewer's top row writes it.
 *
 * @remarks
 * Bytes under a KB, then KB and MB with one decimal, as Finder rounds them (by 1024).
 *
 * @sideEffects none
 * @param bytes - The size.
 * @returns The text.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A text's lines, without the empty one after a last line break.
 *
 * @remarks
 * As an editor numbers them: `a\n` is one line, an empty file none.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The lines.
 */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

/**
 * Whether a file is small enough to colour.
 *
 * @remarks
 * See `HIGHLIGHT_LIMITS`.
 *
 * @sideEffects none
 * @param lines - Its lines.
 * @param bytes - Its size.
 * @returns Whether to colour it.
 */
export function highlightable(lines: number, bytes: number): boolean {
  return lines <= HIGHLIGHT_LIMITS.lines && bytes <= HIGHLIGHT_LIMITS.bytes;
}
