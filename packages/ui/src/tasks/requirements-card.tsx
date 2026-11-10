import type { TaskRequirements } from "@atrium/protocol";
import { useState } from "react";
import { CaretRight } from "../design/icons";

/** The sections of the summary after the goal, in the order the designer writes them (SPEC-0006, "任务对话"). */
const SECTIONS = [
  ["decisions", "已定"],
  ["constraints", "约束"],
  ["nonGoals", "不做"],
  ["openQuestions", "待定"],
  ["acceptance", "验收"],
] as const;

/**
 * Whether the summary has anything to show.
 *
 * @remarks
 * Before the task conversation has written one, all of it is empty and the card is left out.
 *
 * @sideEffects none
 * @param requirements - The summary.
 * @returns Whether it does.
 */
function hasRequirements(requirements: TaskRequirements): boolean {
  return requirements.goal.trim() !== "" || SECTIONS.some(([key]) => requirements[key].length > 0);
}

/**
 * The requirements summary at the top of the task conversation (设计稿第 4 屏).
 *
 * @remarks
 * Model text, so it is shown as a quote and as text, never as markup (SPEC-0006, "T8 定下的细节"): the goal is
 * the quote's first lines, and the sections open under "展开". It sits above the transcript, not in it, so it stays
 * in view while the task is being designed.
 *
 * @sideEffects Keeps whether it is open.
 * @param props - The summary.
 * @returns The card, or nothing while the summary is empty.
 */
export function RequirementsCard({ requirements }: { readonly requirements: TaskRequirements }) {
  const [open, setOpen] = useState(false);
  if (!hasRequirements(requirements)) return null;
  const filled = SECTIONS.filter(([key]) => requirements[key].length > 0);
  return (
    <div
      data-testid="requirements"
      className="mx-4 mb-1 shrink-0 rounded-[var(--r-card)] bg-[var(--surface-1)] px-3.5 py-2.5 shadow-[var(--card-shadow)] dark:bg-[var(--surface-2)]"
    >
      <div className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
        <span>需求摘要 · 任务对话整理的</span>
        <span className="flex-1" />
        {filled.length === 0 ? null : (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-0.5 text-[var(--tint)] hover:underline"
          >
            {open ? "收起" : "展开"}
            <CaretRight size={10} className={open ? "rotate-90" : ""} aria-hidden />
          </button>
        )}
      </div>
      {requirements.goal.trim() === "" ? null : (
        <p
          data-testid="requirements-goal"
          className="mt-1 text-[length:var(--fs-meta)] leading-[1.5] whitespace-pre-wrap text-[var(--text)]"
        >
          {requirements.goal}
        </p>
      )}
      {open ? (
        <div data-testid="requirements-sections" className="mt-2 flex max-h-[240px] flex-col gap-2 overflow-y-auto">
          {filled.map(([key, title]) => (
            <div key={key}>
              <p className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">{title}</p>
              <ul className="m-0 list-none p-0">
                {requirements[key].map((line) => (
                  <li key={line} className="text-[length:var(--fs-sm)] leading-[1.5] text-[var(--text-2)]">
                    · {line}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
