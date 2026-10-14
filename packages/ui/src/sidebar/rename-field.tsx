import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The class of a key written in the hint. */
const KEYCAP =
  "rounded-[4px] bg-[var(--surface-2)] px-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line)]";

/**
 * One thing the rename field's hint says: a key, in a keycap, and what it does.
 *
 * @remarks
 * design-language ("改名框").
 *
 * @sideEffects none
 * @param props - The key and what it does.
 * @returns The words.
 */
function KeyHint({ keyName, does }: { readonly keyName: string; readonly does: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className={KEYCAP}>{keyName}</kbd>
      {does}
    </span>
  );
}

/**
 * Where the hint goes, beside the field on the page.
 *
 * @remarks
 * The hint floats on the page rather than in the row, as the row's list may clip it (the tab bar
 * scrolls sideways); so it follows the field as the page scrolls or resizes.
 *
 * @sideEffects Listens for scrolling and resizing on the window while mounted.
 * @param field - The field.
 * @param above - Whether the hint goes above the field rather than below.
 * @returns The hint's left edge, and its top or, above, its bottom; `null` before the field is laid
 * out.
 */
function useHintPlace(
  field: RefObject<HTMLInputElement | null>,
  above: boolean,
): { readonly left: number; readonly top?: number; readonly bottom?: number } | null {
  const [place, setPlace] = useState<{ readonly left: number; readonly top?: number; readonly bottom?: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    /**
     * Places the hint 4px off the field.
     *
     * @remarks
     * See `useHintPlace`.
     *
     * @sideEffects Updates the place.
     */
    const follow = (): void => {
      const rect = field.current?.getBoundingClientRect();
      if (rect === undefined) return;
      setPlace(
        above
          ? { left: rect.left, bottom: window.innerHeight - rect.top + 4 }
          : { left: rect.left, top: rect.bottom + 4 },
      );
    };
    follow();
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [field, above]);
  return place;
}

/**
 * A text field for renaming something in place, with a hint of how to save and cancel.
 *
 * @remarks
 * design-language ("改名框"): it lies over the name, its text where the name's was, and the hint
 * floats 4px below it, or above where there is no room below. Enter or leaving the field saves,
 * Escape cancels. An empty name saves as `null`, which for a workspace means "back to the
 * branch's name" (SPEC-0001, "命名"); callers that need a name ignore it.
 *
 * @sideEffects Focuses and selects its text when it appears; shows its hint in `document.body`.
 * @param props - The current name, its label, what an empty name goes back to, what the empty
 * field says, whether the hint goes above, and what to do on saving or cancelling.
 * @returns The field.
 */
export function RenameField({
  initial,
  label,
  restores,
  placeholder,
  above = false,
  onDone,
}: {
  readonly initial: string;
  readonly label: string;
  /** What the hint says an empty name goes back to, where it goes back to something. */
  readonly restores?: string;
  /** What the field says while empty. */
  readonly placeholder?: string;
  readonly above?: boolean;
  /** Called once, with the new name, `null` for an empty one, or `undefined` when cancelled. */
  readonly onDone: (name: string | null | undefined) => void;
}) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const hint = useId();
  const place = useHintPlace(field, above);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  /**
   * Ends editing once.
   *
   * @remarks
   * Blur follows Enter and Escape, which must not save a second time.
   *
   * @sideEffects Calls `onDone`.
   * @param result - What to report.
   */
  const finish = (result: string | null | undefined): void => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  /**
   * The name typed, without surrounding spaces.
   *
   * @remarks
   * Empty means no name.
   *
   * @sideEffects none
   * @returns The name, or `null`.
   */
  const trimmed = (): string | null => (value.trim() === "" ? null : value.trim());

  return (
    <>
      <input
        ref={field}
        aria-label={label}
        aria-describedby={hint}
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") finish(trimmed());
          if (event.key === "Escape") finish(undefined);
        }}
        onBlur={() => finish(trimmed())}
        className="-mx-1.5 h-[26px] min-w-0 flex-1 rounded-[var(--r-sm)] bg-[var(--main)] px-1.5 text-[var(--text)] placeholder:text-[var(--text-dim)] [box-shadow:inset_0_0_0_1px_var(--tint),var(--focus-ring)] outline-none"
      />
      {createPortal(
        <div
          id={hint}
          style={place ?? { visibility: "hidden" }}
          className="pointer-events-none fixed z-50 flex items-center gap-2.5 whitespace-nowrap rounded-[var(--r-sm)] bg-[var(--surface-1)] px-2 py-[3px] text-[length:var(--fs-xs)] text-[var(--text-muted)] shadow-[var(--float-shadow)] dark:bg-[var(--surface-2)]"
        >
          <KeyHint keyName="⏎" does="保存" />
          <KeyHint keyName="esc" does="取消" />
          {restores === undefined ? null : <span>{restores}</span>}
        </div>,
        document.body,
      )}
    </>
  );
}
