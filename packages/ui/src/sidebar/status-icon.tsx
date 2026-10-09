import { CircleNotch } from "@phosphor-icons/react";

/**
 * A session's or workspace's status icon; nothing when idle.
 *
 * @remarks
 * M1.5 knows only "running": a turning arc in the tint color (design-language, "会话状态").
 * Waiting and error states come with M1.6 and M1.9. A plain line icon, colored, with no
 * background; the label says the state for screen readers and on hover.
 *
 * @sideEffects none
 * @param props - Whether it runs.
 * @returns The icon, or nothing.
 */
export function StatusIcon({ running }: { readonly running: boolean }) {
  if (!running) return null;
  return (
    <span
      role="img"
      aria-label="运行中"
      title="运行中"
      className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--tint)]"
    >
      <CircleNotch size={14} className="animate-spin [animation-duration:900ms] motion-reduce:animate-none" />
    </span>
  );
}
