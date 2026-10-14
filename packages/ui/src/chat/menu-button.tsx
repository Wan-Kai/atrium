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
 * @param props - The button's content, label, look, alignment and whether it can be pressed, and the
 * menu's items given a way to close it.
 * @returns The button and menu.
 */
export function MenuButton({
  label,
  content,
  align = "end",
  compact = false,
  field = false,
  chip = false,
  disabled = false,
  children,
}: {
  readonly label: string;
  readonly content: ReactNode;
  /** Which edge of the button the menu lines up with. */
  readonly align?: "start" | "end";
  /** A small icon button, as in an info row. */
  readonly compact?: boolean;
  /** A framed button showing the choice, as in the settings; its menu scrolls when long. */
  readonly field?: boolean;
  /**
   * A choice above the input box, as on the new-workspace page: shaped as the model button, its
   * menu opening upwards and scrolling when long (design-language, "新建工作区页").
   */
  readonly chip?: boolean;
  readonly disabled?: boolean;
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
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className={
          chip
            ? "flex h-[26px] max-w-[240px] items-center gap-1.5 whitespace-nowrap rounded-[var(--r-btn)] px-2 text-[length:var(--fs-meta)] text-[var(--text-2)] enabled:hover:bg-[var(--hover)] disabled:text-[var(--text-dim)] aria-expanded:bg-[var(--hover)]"
            : field
              ? "flex h-7 max-w-[300px] items-center gap-1.5 whitespace-nowrap rounded-[var(--r)] pr-2 pl-2.5 text-[length:var(--fs-meta)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--selected)] hover:text-[var(--text)] aria-expanded:shadow-[inset_0_0_0_0.5px_var(--line-strong),var(--focus-ring)]"
              : compact
                ? "rounded-[var(--r)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
                : "flex h-7 items-center gap-1.5 rounded-[var(--r)] px-2 text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
        }
      >
        {content}
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute z-10 min-w-44 rounded-[var(--r-btn)] bg-[var(--surface-1)] p-1 shadow-[var(--float-shadow)] ${
            chip ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "end" ? "right-0" : "left-0"} ${
            field || chip ? "max-h-[360px] min-w-56 overflow-y-auto dark:bg-[var(--surface-2)]" : ""
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
