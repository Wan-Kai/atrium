import type { ReactNode } from "react";
import { type Token, tokenStyle } from "./highlight";
import type { FileLineRange } from "../state/workspace-views";

/**
 * A line's text, in its tokens' colours when it has them.
 *
 * @remarks
 * The colours follow the appearance through CSS (`.code-tokens`), so nothing redraws when it
 * changes.
 *
 * @sideEffects none
 * @param props - The text, and its tokens if coloured.
 * @returns The text.
 */
export function LineText({ text, tokens }: { readonly text: string; readonly tokens: readonly Token[] | undefined }) {
  if (tokens === undefined) return text;
  return tokens.map((token, index) => (
    // Tokens never move within a line.
    // oxlint-disable-next-line react/no-array-index-key -- see above.
    <span key={index} style={tokenStyle(token)}>
      {token[0]}
    </span>
  ));
}

/** How many lines are laid out together (design-language, "查看标签"). */
const CHUNK_LINES = 64;
/** A line's height until its group is drawn: 12px at a line height of 1.7, rounded. */
const LINE_PX = 20;

/**
 * Lines in groups of 64, each group laid out and painted only while near the view.
 *
 * @remarks
 * design-language ("查看标签"): a viewer tab widens and narrows every frame as the sidebar folds,
 * and would otherwise lay out every one of its lines each time. A group not drawn yet counts 20px
 * a line; once drawn, its height is remembered.
 *
 * @sideEffects none
 * @param props - How many lines, and how to draw the line at an index, keyed by it.
 * @returns The groups.
 */
export function LineChunks({
  count,
  renderLine,
  revealLine,
}: {
  readonly count: number;
  readonly renderLine: (index: number) => ReactNode;
  readonly revealLine?: number;
}) {
  return Array.from({ length: Math.ceil(count / CHUNK_LINES) }, (_, chunk) => {
    const start = chunk * CHUNK_LINES;
    const size = Math.min(CHUNK_LINES, count - start);
    return (
      <div
        key={start}
        className="[content-visibility:auto]"
        style={{
          containIntrinsicHeight: `auto ${size * LINE_PX}px`,
          ...(revealLine !== undefined && revealLine > start && revealLine <= start + size
            ? { contentVisibility: "visible" }
            : {}),
        }}
      >
        {Array.from({ length: size }, (_line, offset) => renderLine(start + offset))}
      </div>
    );
  });
}

/**
 * A file's lines, numbered, as the file tab shows them.
 *
 * @remarks
 * design-language ("查看标签"): monospaced 12px, line height 1.7; a 48px column of numbers that
 * cannot be selected; not wrapped, scrolling sideways, unless wrapping is on, which breaks
 * anywhere. Drawn in groups (`LineChunks`).
 *
 * @sideEffects none
 * @param props - The lines, their tokens if coloured, and whether to wrap.
 * @returns The lines.
 */
export function CodeLines({
  lines,
  tokens,
  wrap,
  highlight,
}: {
  readonly lines: readonly string[];
  readonly tokens: readonly (readonly Token[])[] | null;
  readonly wrap: boolean;
  readonly highlight?: FileLineRange;
}): ReactNode {
  return (
    <div
      data-testid="code-lines"
      className={`code-tokens pt-1.5 pb-6 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] leading-[1.7] text-[var(--text)] ${wrap ? "" : "min-w-max"}`}
    >
      <LineChunks
        count={lines.length}
        {...(highlight === undefined ? {} : { revealLine: highlight.start })}
        renderLine={(index) => {
          const target = highlight !== undefined && index + 1 >= highlight.start && index + 1 <= highlight.end;
          return (
            // Lines never move within a reading.
            <div
              key={index}
              data-line-number={index + 1}
              data-line-target={target ? "true" : undefined}
              className="flex"
              style={
                target
                  ? {
                      backgroundColor: "color-mix(in srgb, var(--tint) 12%, transparent)",
                      boxShadow: "inset 2px 0 var(--tint)",
                    }
                  : undefined
              }
            >
              <span className="w-12 flex-none pr-3 text-right text-[var(--text-dim)] select-none">{index + 1}</span>
              <span className={`flex-1 ${wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"}`}>
                <LineText text={lines[index] ?? ""} tokens={tokens?.[index]} />
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}
