import { type ComponentProps, useLayoutEffect, useRef, useState } from "react";
import { defaultComponents, type ExtraProps } from "streamdown";

/** How tall a table grows before it folds, in pixels; `styles.css` folds it at the same height. */
const TABLE_MAX_HEIGHT = 640;

/** Streamdown's table: its copy and fullscreen buttons over the table. */
const StreamdownTable = defaultComponents.table;

/**
 * How many rows of a table end below the fold.
 *
 * @remarks
 * Measured from the table's top, so the count is the same folded or open.
 *
 * @sideEffects Reads layout.
 * @param table - The table.
 * @returns The rows not wholly shown while folded; 0 when the table fits.
 */
function rowsBelowFold(table: HTMLTableElement): number {
  const top = table.getBoundingClientRect().top;
  return [...table.tBodies]
    .flatMap((body) => [...body.rows])
    .filter((row) => row.getBoundingClientRect().bottom - top > TABLE_MAX_HEIGHT).length;
}

/**
 * Scrolls the view back to a table that folded with its top out of sight.
 *
 * @remarks
 * Folding from "收起" deep in a long table leaves the view past it. Only the nearest scrolling
 * ancestor moves, unlike `scrollIntoView`, which could shift the panes around the transcript.
 *
 * @sideEffects Scrolls the table's scrolling ancestor.
 * @param element - The folded table.
 */
function bringTopIntoView(element: HTMLElement): void {
  for (let view = element.parentElement; view !== null; view = view.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(view).overflowY)) continue;
    const above = view.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (above > 0) view.scrollTop -= above;
    return;
  }
}

/**
 * A table in a reply, folded at 640px with "还有 N 行" under it.
 *
 * @remarks
 * A table scrolling inside its own 640px gave no sign there was more: macOS hides the scrollbar
 * until scrolling, and the cut often fell on a row line (design-language, "代码块、表格、Mermaid
 * 图"). Folded, it is cut and faded with the rows left counted; opened, it lies in the reply and
 * scrolls with it, "收起" sticking to the bottom of the view. A table streaming in folds the same
 * way. Streamdown's table and buttons are kept; `styles.css` draws the fold.
 *
 * @sideEffects Observes the table's size; folding scrolls the table back into view.
 * @param props - The table's props from the renderer.
 * @returns The table, and the fold button when it is taller than 640px.
 */
export function ReplyTable(props: ComponentProps<"table"> & ExtraProps) {
  const root = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(0);
  const [open, setOpen] = useState(false);
  const folding = useRef(false);

  useLayoutEffect(() => {
    const table = root.current?.querySelector("table");
    if (table === null || table === undefined) return undefined;
    const observer = new ResizeObserver(() => setBelow(rowsBelowFold(table)));
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

  // After every render: the one that folded the table is the one to scroll back from.
  useLayoutEffect(() => {
    if (!folding.current) return;
    folding.current = false;
    if (root.current !== null) bringTopIntoView(root.current);
  });

  const folded = below > 0 && !open;
  return (
    <div ref={root} className="atrium-table" data-folded={folded || undefined}>
      <StreamdownTable {...props} />
      {below > 0 && (
        <button
          type="button"
          className="atrium-table-fold"
          aria-expanded={open}
          onClick={() => {
            folding.current = open;
            setOpen(!open);
          }}
        >
          <span>{open ? "收起" : `还有 ${below} 行`}</span>
        </button>
      )}
    </div>
  );
}
