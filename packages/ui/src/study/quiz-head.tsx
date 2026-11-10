import { ArrowBendDownRight, CaretRight } from "../design/icons";

/**
 * The top of a quiz child: where it came from, with "回到上课".
 *
 * @remarks
 * Prototype 1A (design-language "学习模式 · ML3 学习循环"): a `--code` band, "测验 · 来自上课「课名」，
 * 带着这节课的上下文", the link at its right. Without the lesson's title, "来自上课会话".
 *
 * @sideEffects none; calls `onBack` when the link is clicked.
 * @param props - The lesson's title, and how to go back to the lesson, if the transcript can.
 * @returns The band.
 */
export function QuizHead({
  lessonTitle,
  onBack,
}: {
  readonly lessonTitle: string | null;
  readonly onBack: (() => void) | null;
}) {
  return (
    <div
      data-testid="quiz-head"
      className="flex min-w-0 items-center gap-2 rounded-xl bg-[var(--code)] px-3 py-2 text-[length:var(--fs-meta)] whitespace-nowrap text-[var(--text-muted)]"
    >
      <ArrowBendDownRight size={14} aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">
        测验 · 来自上课
        {lessonTitle === null ? (
          "会话"
        ) : (
          <>
            「<b className="font-medium text-[var(--text-2)]">{lessonTitle}</b>」
          </>
        )}
        ，带着这节课的上下文
      </span>
      {onBack === null ? null : (
        <button
          type="button"
          onClick={onBack}
          className="ml-auto shrink-0 pl-3 text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline"
        >
          回到上课
        </button>
      )}
    </div>
  );
}

/**
 * The row the lesson's turns a quiz child copied fold into: "› 这节课的 N 轮 · 来自上课会话".
 *
 * @remarks
 * Prototype 1A: clicked, the turns show in place, as they were, and the chevron turns down.
 *
 * @sideEffects none; calls `onToggle` when clicked.
 * @param props - How many turns, whether they show, and how to show or hide them.
 * @returns The row.
 */
export function CopiedTurns({
  count,
  shown,
  onToggle,
}: {
  readonly count: number;
  readonly shown: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={shown}
      data-testid="copied-turns"
      onClick={onToggle}
      className="flex min-h-[30px] items-center gap-1.5 self-start text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:text-[var(--text-2)]"
    >
      <CaretRight
        size={12}
        aria-hidden
        className={`text-[var(--text-dim)] transition-transform ${shown ? "rotate-90" : ""}`}
      />
      这节课的 {count} 轮<span className="text-[var(--text-dim)]">· 来自上课会话</span>
    </button>
  );
}
