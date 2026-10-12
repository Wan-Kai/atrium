import { Check, Copy } from "../design/icons";
import { type ReactNode, useState } from "react";

/** The footer's quiet buttons: "返回", "我已经装好了", "取消" and the like. */
export const FOOT_GHOST =
  "inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-[11px] px-3 text-[var(--text-muted)] transition-[transform,background] duration-150 hover:bg-[var(--hover)] hover:text-[var(--text-2)] active:scale-[0.97] disabled:opacity-45";

/** The footer's main button, which Enter presses. */
export const FOOT_PRIMARY =
  "atrium-onboard-primary inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-[11px] px-4 font-medium transition-transform duration-150 active:scale-[0.97]";

/** A small capsule under a showcase: a command's tab, or "复制". */
export const CHIP =
  "inline-flex h-6 items-center gap-1 rounded-[var(--r-pill)] px-2.5 text-[length:var(--fs-sm)] text-[var(--text-muted)] shadow-[inset_0_0_0_0.5px_var(--line)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] aria-pressed:bg-[var(--selected)] aria-pressed:text-[var(--text)] aria-pressed:shadow-none";

/**
 * One step of first launch: its eyebrow, title and lead over its showcase, and its footer.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 窗口与版式"). Returns the window's middle and bottom rows, so the footer
 * stays put while the middle scrolls; the middle slides in from the side it comes from, again
 * each time `screen` changes.
 *
 * @sideEffects none
 * @param props - Which screen this is and whether it was reached going back, the texts, the
 * showcase, and the footer's buttons.
 * @returns The rows.
 */
export function StepLayout({
  screen,
  back,
  eyebrow,
  title,
  lead,
  footer,
  children,
}: {
  readonly screen: string;
  readonly back: boolean;
  readonly eyebrow: string;
  readonly title: string;
  readonly lead: ReactNode;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <div className="relative grid min-h-0 place-items-center overflow-auto px-8 py-2">
        <section
          key={screen}
          aria-labelledby="first-launch-title"
          data-back={back ? "" : undefined}
          className="atrium-onboard-screen w-[560px] max-w-full"
        >
          <div className="mb-2.5 text-center text-[length:var(--fs-sm)] font-semibold tracking-[0.06em] text-[var(--text-dim)]">
            {eyebrow}
          </div>
          <h1
            id="first-launch-title"
            className="atrium-title m-0 text-center text-[30px] leading-[1.2] font-semibold tracking-[-0.02em]"
          >
            {title}
          </h1>
          <p className="mx-auto mt-2.5 mb-7 max-w-[480px] text-center text-[15px] leading-[1.55] text-[var(--text-muted)]">
            {lead}
          </p>
          {children}
        </section>
      </div>
      <footer className="atrium-onboard-foot relative flex items-center gap-2 px-6 shadow-[inset_0_0.5px_0_var(--line)]">
        {footer}
      </footer>
    </>
  );
}

/**
 * The ⏎ hint on the footer's main button.
 *
 * @remarks
 * Enter presses the main button wherever the focus is not in a field (SPEC-0001, "首次启动").
 *
 * @sideEffects none
 * @returns The hint.
 */
export function EnterHint() {
  return (
    <kbd
      aria-hidden
      className="inline-grid h-5 min-w-5 place-items-center rounded-[6px] px-[5px] font-sans text-[11px] font-semibold"
    >
      ⏎
    </kbd>
  );
}

/**
 * A small ring that spins, for something under way.
 *
 * @remarks
 * In the footer's main button while a job runs.
 *
 * @sideEffects none
 * @returns The ring.
 */
export function FootSpinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.6px] border-current border-r-transparent"
    />
  );
}

/**
 * A "复制" chip that copies a text and says "已复制" once it did.
 *
 * @remarks
 * Commands to run in the terminal (SPEC-0001, "首次启动"). A clipboard that refuses leaves the
 * text on screen to copy by hand.
 *
 * @sideEffects Writes the clipboard when pressed.
 * @param props - The text, and what the chip says to assistive technology.
 * @returns The chip.
 */
export function CopyChip({ text, label = "复制" }: { readonly text: string; readonly label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={CHIP}
      aria-label={copied ? "已复制" : label}
      onClick={() => {
        // Fire and forget: the text stays on screen to copy by hand.
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}
