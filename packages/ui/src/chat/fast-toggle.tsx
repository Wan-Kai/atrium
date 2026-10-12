import type { CatalogModel } from "@atrium/protocol";
import { useId, useState } from "react";
import { Lightning } from "../design/icons";

/**
 * The Fast button left of the model button, with its card on hover.
 *
 * @remarks
 * SPEC-0001 ("输入框", "Fast"): the bolt alone, with no circle, background or outline around it; an
 * outlined grey bolt while off and a filled one in the tint colour while on. The button keeps a
 * 32px square to press, with the pointing hand over it while it can be pressed. Turning on plays a
 * short acceleration: the bolt dashes forward with three speed lines behind it (design-language,
 * "Fast 按钮"); a button that appears already on does not, so the boost marks the switch itself.
 * The card above it says whether Fast is on, about how
 * much faster ("更快" when unknown) and whether it uses more credits, as Codex's model list says,
 * and that it applies from the next request; it shows as the status bar's cards do, on hover and
 * on keyboard focus. Only shown for a model with Fast, which its caller decides.
 *
 * @sideEffects none
 * @param props - Whether Fast is on, what Fast does for the model, whether it is disabled, and
 * what pressing does.
 * @returns The button.
 */
export function FastToggle({
  enabled,
  fast,
  disabled,
  onToggle,
}: {
  readonly enabled: boolean;
  readonly fast: NonNullable<CatalogModel["fast"]>;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const cardId = useId();
  // Counts the switches to on seen while shown; each restarts the boost through its key. Adjusted
  // while rendering, as React suggests for state that follows a prop, so no frame shows the bolt
  // turned on without it.
  const [shown, setShown] = useState(enabled);
  const [boosts, setBoosts] = useState(0);
  if (enabled !== shown) {
    setShown(enabled);
    if (enabled) setBoosts((count) => count + 1);
  }
  return (
    <div className="group/fast relative">
      <button
        type="button"
        aria-label="Fast"
        aria-pressed={enabled}
        aria-describedby={cardId}
        disabled={disabled}
        onClick={() => onToggle(!enabled)}
        className={`flex size-8 shrink-0 items-center justify-center transition-colors duration-200 enabled:cursor-pointer disabled:opacity-50 ${
          enabled ? "text-[var(--tint)]" : "text-[var(--text-muted)] hover:text-[var(--text)]"
        }`}
      >
        <span
          key={boosts}
          data-boost={enabled && boosts > 0 ? "" : undefined}
          className="atrium-fast-bolt relative flex"
        >
          <Lightning size={15} weight={enabled ? "fill" : "regular"} />
          <span aria-hidden="true" className="atrium-fast-streak" />
          <span aria-hidden="true" className="atrium-fast-streak" />
          <span aria-hidden="true" className="atrium-fast-streak" />
        </span>
      </button>
      <div
        role="tooltip"
        id={cardId}
        className="invisible absolute bottom-full left-1/2 z-30 mb-2 w-[220px] -translate-x-1/2 rounded-[12px] bg-[var(--surface-1)] px-3 py-2.5 opacity-0 shadow-[var(--float-shadow)] transition-[opacity,visibility] delay-100 duration-150 group-has-[:focus-visible]/fast:visible group-has-[:focus-visible]/fast:opacity-100 group-hover/fast:visible group-hover/fast:opacity-100 group-hover/fast:delay-[120ms] dark:bg-[var(--surface-2)]"
      >
        <p className="text-[length:var(--fs-meta)] font-semibold text-[var(--text)]">
          {enabled ? "Fast 已开启" : "Fast 未开启"}
        </p>
        <div className="my-1.5 h-px bg-[var(--line)]" />
        <p className="text-[length:var(--fs-sm)] leading-relaxed text-[var(--text-muted)]">
          {fast.speed === null ? "更快" : `约 ${String(fast.speed)} 倍速度`}
          {fast.moreUsage ? "，额度消耗增加" : null}
          <br />
          从下一次请求开始生效
        </p>
      </div>
    </div>
  );
}
