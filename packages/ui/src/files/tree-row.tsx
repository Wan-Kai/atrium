import type { ReactNode } from "react";
import { CaretDown, CircleNotch } from "../design/icons";

/**
 * A row of the right panel's trees: what goes in its slot, its name, and what follows.
 *
 * @remarks
 * design-language ("右栏（文件与更改）"): 28px high, 12px further in for each level from 6px; the
 * 16px slot holds a directory's arrow or a file's type icon, the name follows 6px on, cut short
 * when long; hovered `--hover`, selected `--selected`.
 *
 * @sideEffects none; clicking calls the handlers.
 * @param props - The level, the slot, the name, what follows it, whether it is selected or
 * expanded, its full description, and what a click and a double click do.
 * @returns The row.
 */
export function TreeRow({
  depth,
  slot,
  name,
  after,
  selected = false,
  expanded,
  title,
  onClick,
  onDoubleClick,
}: {
  readonly depth: number;
  readonly slot: ReactNode;
  readonly name: ReactNode;
  readonly after?: ReactNode;
  readonly selected?: boolean;
  /** A directory's state; left out for a file. */
  readonly expanded?: boolean;
  readonly title: string;
  readonly onClick: () => void;
  readonly onDoubleClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-expanded={expanded}
      aria-current={selected || undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ paddingLeft: 6 + depth * 12 }}
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] pr-1.5 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)] aria-[current]:bg-[var(--selected)] aria-[current]:text-[var(--text)]"
    >
      <span className="flex size-4 flex-none items-center justify-center">{slot}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {after}
    </button>
  );
}

/**
 * A directory row's arrow, turned while folded, or a spinner while it loads.
 *
 * @remarks
 * design-language ("右栏（文件与更改）"): 12px, `--text-dim`, turning −90° in 0.15s.
 *
 * @sideEffects none
 * @param props - Whether the directory is expanded, and whether it is loading.
 * @returns The arrow.
 */
export function TreeArrow({ expanded, loading = false }: { readonly expanded: boolean; readonly loading?: boolean }) {
  if (loading) return <CircleNotch size={12} className="animate-spin text-[var(--text-dim)]" />;
  return (
    <CaretDown
      size={12}
      className={`text-[var(--text-dim)] transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`}
    />
  );
}
