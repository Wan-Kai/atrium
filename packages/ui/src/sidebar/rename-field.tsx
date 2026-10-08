import { useEffect, useRef, useState } from "react";

/**
 * A text field for renaming something in place.
 *
 * @remarks
 * Enter or leaving the field saves, Escape cancels. An empty name saves as `null`, which for a
 * workspace means "back to the branch's name" (SPEC-0001, "命名"); callers that need a name
 * ignore it.
 *
 * @sideEffects Focuses and selects its text when it appears.
 * @param props - The current name, its label, and what to do on saving or cancelling.
 * @returns The field.
 */
export function RenameField({
  initial,
  label,
  onDone,
}: {
  readonly initial: string;
  readonly label: string;
  /** Called once, with the new name, `null` for an empty one, or `undefined` when cancelled. */
  readonly onDone: (name: string | null | undefined) => void;
}) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
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
    <input
      ref={field}
      aria-label={label}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(trimmed());
        if (event.key === "Escape") finish(undefined);
      }}
      onBlur={() => finish(trimmed())}
      className="h-6 min-w-0 flex-1 rounded-[var(--r-sm)] bg-[var(--main)] px-1.5 text-[length:var(--fs)] text-[var(--text)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] outline-none"
    />
  );
}
