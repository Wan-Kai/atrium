import type { CatalogModel } from "@atrium/protocol";
import { useId } from "react";
import { Lightning } from "../design/icons";

/**
 * The Fast button left of the model button, with its card on hover.
 *
 * @remarks
 * SPEC-0001 ("输入框", "Fast"): a round button styled as "+", an outlined grey bolt while off and a
 * filled one in the tint colour while on. The card above it says whether Fast is on, about how
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
  return (
    <div className="group/fast relative">
      <button
        type="button"
        aria-label="Fast"
        aria-pressed={enabled}
        aria-describedby={cardId}
        disabled={disabled}
        onClick={() => onToggle(!enabled)}
        className={`flex size-8 shrink-0 items-center justify-center rounded-full disabled:opacity-50 ${
          enabled
            ? "bg-[var(--linked)] text-[var(--tint)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--tint)_35%,transparent)]"
            : "text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        }`}
      >
        <Lightning size={15} weight={enabled ? "fill" : "regular"} />
      </button>
      <div
        role="tooltip"
        id={cardId}
        className="invisible absolute bottom-full left-1/2 z-30 mb-2 w-[220px] -translate-x-1/2 rounded-[12px] bg-[var(--surface-1)] px-3 py-2.5 opacity-0 shadow-[var(--float-shadow)] transition-[opacity,visibility] delay-100 duration-150 group-focus-within/fast:visible group-focus-within/fast:opacity-100 group-hover/fast:visible group-hover/fast:opacity-100 group-hover/fast:delay-[120ms] dark:bg-[var(--surface-2)]"
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
