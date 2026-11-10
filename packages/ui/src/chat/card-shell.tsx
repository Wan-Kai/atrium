import type { KeyboardEvent, ReactNode, Ref } from "react";

/** The footer's buttons: 28px pills (design-language, "提问卡片" and "审核卡片"). */
export const CARD_BUTTON =
  "atrium-press inline-flex h-7 items-center gap-1 rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] whitespace-nowrap disabled:cursor-default";

/** A key's mark in a card's hints. */
export const CARD_KEY =
  "rounded-[4px] px-1 font-[family-name:var(--font-mono)] text-[length:var(--fs-xs)] text-[var(--text-muted)] shadow-[inset_0_0_0_0.5px_var(--line-strong)]";

/**
 * The shell the cards above the input box share: the question card and the review card.
 *
 * @remarks
 * Design-language ("卡片外壳"): one surface, the same corners, shadow and margins, so a question and a review
 * stacked above the box look like two of a kind. The shell owns the look and the keyboard hook; what goes inside
 * (the top line, the body, the footer) is the card's own. SPEC-0006 ("审核卡片") and SPEC-0003 ("界面").
 *
 * @sideEffects none; `onKeyDown` is called for keys inside the card.
 * @param props - The card's test id and name, its keys, a handle to the element, and what it holds.
 * @returns The shell.
 */
export function CardShell({
  testId,
  label,
  onKeyDown,
  shellRef,
  attrs,
  emphasis = false,
  children,
}: {
  readonly testId: string;
  readonly label: string;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly shellRef?: Ref<HTMLElement>;
  readonly attrs?: Readonly<Record<`data-${string}`, string>>;
  /** Rings the card in the attention colour: something in it deserves a second look (设计稿第 7 屏 37). */
  readonly emphasis?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      ref={shellRef}
      data-testid={testId}
      aria-label={label}
      onKeyDown={onKeyDown}
      {...attrs}
      className={`atrium-question-card mt-3 mb-2 flex max-h-[60vh] flex-col rounded-[var(--r-card)] bg-[var(--surface-1)] px-3.5 py-3 shadow-[var(--card-shadow)] dark:bg-[var(--surface-2)] ${emphasis ? "outline-1 -outline-offset-1 outline-[var(--attn)] outline-solid" : ""}`}
    >
      {children}
    </section>
  );
}

/**
 * The tabs that stand in for the cards waiting above the box when there is more than one.
 *
 * @remarks
 * SPEC-0006 ("几张卡片同时在"): one card is open at a time and the others are capsules in a row above it, in the
 * order they came, pressing one switches. With one card there is nothing to switch and nothing is drawn.
 *
 * @sideEffects Calls `onPick` with the card's key when one is pressed.
 * @param props - The cards' keys and labels, the key open, and what pressing does.
 * @returns The row, or nothing for fewer than two cards.
 */
export function CardTabs({
  cards,
  open,
  onPick,
}: {
  readonly cards: readonly { readonly key: string; readonly label: string }[];
  readonly open: string;
  readonly onPick: (key: string) => void;
}) {
  if (cards.length < 2) return null;
  return (
    <div role="tablist" aria-label="等你处理的卡片" className="mt-3 -mb-1 flex flex-wrap items-center gap-1">
      {cards.map((card) => (
        <button
          key={card.key}
          type="button"
          role="tab"
          aria-selected={card.key === open}
          data-card={card.key}
          onClick={() => onPick(card.key)}
          className={`atrium-press inline-flex h-[26px] max-w-[260px] items-center rounded-[var(--r-pill)] px-2.5 text-[length:var(--fs-sm)] ${
            card.key === open
              ? "bg-[var(--selected)] font-medium text-[var(--text)]"
              : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
          }`}
        >
          <span className="truncate">{card.label}</span>
        </button>
      ))}
    </div>
  );
}
