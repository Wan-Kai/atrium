import { type ReactNode, useEffect, useRef, useState } from "react";

/** The class of an item in a {@link MenuButton}'s menu. */
export const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-[var(--r)] px-2.5 py-1.5 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)]";

/**
 * A button that opens a small menu below it.
 *
 * @remarks
 * Closes on choosing, on Escape and on a click elsewhere. Its Escape goes no further, so a panel
 * holding the menu stays open.
 *
 * @sideEffects Listens for clicks and keys on the document while open.
 * @param props - The button's content, label, size and alignment, and the menu's items given a way to close it.
 * @returns The button and menu.
 */
export function MenuButton({
  label,
  content,
  align = "end",
  compact = false,
  children,
}: {
  readonly label: string;
  readonly content: ReactNode;
  /** Which edge of the button the menu lines up with. */
  readonly align?: "start" | "end";
  /** A small icon button, as in an info row. */
  readonly compact?: boolean;
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    /**
     * Closes the menu on a click outside it.
     *
     * @remarks
     * See `MenuButton`.
     *
     * @sideEffects May close the menu.
     * @param event - The pointer event.
     */
    const close = (event: Event): void => {
      if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) setOpen(false);
    };
    /**
     * Closes the menu on Escape, before anything else hears it.
     *
     * @remarks
     * Caught on its way down, so what holds the menu does not take the Escape for itself.
     *
     * @sideEffects May close the menu; stops the event.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={
          compact
            ? "rounded-[var(--r)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
            : "flex h-7 items-center gap-1.5 rounded-[var(--r)] px-2 text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
        }
      >
        {content}
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute top-full z-10 mt-1 min-w-44 rounded-[var(--r-btn)] bg-[var(--surface-1)] p-1 shadow-[var(--float-shadow)] ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
