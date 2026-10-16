import type { PlanUsage, Plans } from "@atrium/protocol";
import { useEffect, useState } from "react";
import { useClock } from "../state/clock";
import { foundAgo, partName, planName, planNearLimit, plansInOrder, resetText, windowName } from "./status-figures";

/**
 * One subscription's usage: its name, how long ago it was found, and each window with its products.
 *
 * @remarks
 * SPEC-0001 ("M1.14 的套餐总览"): the subscription the session's model is on is marked "当前";
 * each window as M1.13 drew it, a window at 80% or more orange; a window split by product lists
 * each product's share under its bar, without a bar of its own, for they are parts of the window
 * rather than limits.
 *
 * @sideEffects none
 * @param props - The usage, whether it is the session's model's, and the time now.
 * @returns The section.
 */
function PlanSection({
  plan,
  current,
  now,
}: {
  readonly plan: PlanUsage;
  readonly current: boolean;
  readonly now: number;
}) {
  return (
    <section
      aria-label={planName(plan)}
      className="py-2.5 first:pt-0 last:pb-0 [&+&]:shadow-[inset_0_0.5px_0_var(--line)]"
    >
      <div className="mb-2 flex items-baseline gap-1.5">
        <span className="font-medium text-[var(--text)]">{planName(plan)}</span>
        {current ? <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">当前</span> : null}
        <span className="ml-auto text-[length:var(--fs-sm)] text-[var(--text-dim)]">{foundAgo(plan.at, now)}</span>
      </div>
      {plan.windows.map((window, at) => {
        const used = Math.round(window.usedPercent);
        const near = planNearLimit(used);
        return (
          <div
            // By place too: two windows may be as long and of one model.
            key={`${String(at)}\n${String(window.seconds)}`}
            className="mb-2.5 last:mb-0"
            data-testid="plan-window"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[var(--text-2)]">{windowName(window)}</span>
              <span className="flex-1" />
              <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                {resetText(window.resetsAt, now)}
              </span>
              <span className="w-[34px] text-right text-[length:var(--fs-sm)] text-[var(--text-2)]">{used}%</span>
            </div>
            <div className="mt-1.5 h-[5px] overflow-hidden rounded-[var(--r-pill)] bg-[var(--line)]">
              <i
                className="block h-full rounded-[var(--r-pill)]"
                style={{ width: `${String(used)}%`, background: near ? "var(--attn)" : "var(--tint)" }}
              />
            </div>
            {window.parts.length === 0 ? null : (
              <ul className="mt-1.5" aria-label={`${windowName(window)}按产品`}>
                {window.parts.map((part, place) => (
                  <li
                    // By place too: a provider may name two products alike.
                    key={`${String(place)}\n${part.name}`}
                    className="flex h-5 items-center gap-2 pl-2.5 text-[length:var(--fs-sm)]"
                  >
                    <span className="flex-1 text-[var(--text-muted)]">{partName(part.name)}</span>
                    <span className="w-[34px] text-right text-[var(--text-dim)]">{Math.round(part.usedPercent)}%</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * Every subscription's usage, a section each, the session's model's first.
 *
 * @remarks
 * SPEC-0001 ("M1.14 的套餐总览"): the status bar's plan card and the settings' "套餐用量" draw
 * the same. The times go on with the clock, drawn again each minute while it is there, though no
 * new usage comes.
 *
 * @sideEffects Draws itself again every minute while mounted.
 * @param props - Every subscription's usage, and the provider of the session's model, if any.
 * @returns The sections.
 */
export function PlanSections({ plans, provider }: { readonly plans: Plans; readonly provider: string | null }) {
  const clock = useClock();
  const [, setMinutes] = useState(0);
  useEffect(() => clock.every(60_000, () => setMinutes((minutes) => minutes + 1)), [clock]);
  const now = clock.now();
  return (
    <>
      {plansInOrder(plans, provider).map((plan) => (
        <PlanSection key={plan.provider} plan={plan} current={plan.provider === provider} now={now} />
      ))}
    </>
  );
}
