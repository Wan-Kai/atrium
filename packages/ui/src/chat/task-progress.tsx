import { use, useState } from "react";
import { CaretRight, Flowchart } from "../design/icons";
import {
  type MarkNotice,
  type ProgressNotice,
  clockWords,
  progressWords,
  summaryWords,
} from "../tasks/task-progress-model";
import { Fold } from "./fold";
import { RailMarks } from "./steps";
import { TaskLinksContext } from "./task-links";

/**
 * A run of progress lines between two turns of a task conversation, as a process on the rail.
 *
 * @remarks
 * SPEC-0006 ("任务对话的进度和记录折叠"; design-language, "过程轨道"): the group going on is open, a rail with a step
 * for each line, its time at the right; an earlier group is one grey line "› 任务进度 · 3 个节点通过 · 10:02–10:44",
 * which opens again when pressed, as a finished turn's process does. A line that failed has its node marked ×, one
 * that waits for you is orange. The user's choice of open or folded stays through later lines; without one, the
 * group follows whether it is the latest.
 *
 * @sideEffects none
 * @param props - The group's lines and whether it is the latest group.
 * @returns The group.
 */
export function TaskProgressGroup({
  notices,
  last,
}: {
  readonly notices: readonly ProgressNotice[];
  readonly last: boolean;
}) {
  const links = use(TaskLinksContext);
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? last;
  const first = notices[0];
  const end = notices.at(-1);
  const range =
    first === undefined || end === undefined
      ? ""
      : first.timestamp === end.timestamp || clockWords(first.timestamp) === clockWords(end.timestamp)
        ? clockWords(first.timestamp)
        : `${clockWords(first.timestamp)}–${clockWords(end.timestamp)}`;
  return (
    <div data-testid="task-progress" data-open={open} data-item-id={first?.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className="atrium-press-row flex min-h-[30px] w-full items-center gap-1.5 text-left text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:text-[var(--text-2)]"
      >
        <CaretRight
          size={12}
          className={`atrium-fold-chevron flex-none text-[var(--text-dim)] ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 truncate">
          {open ? (
            <>
              任务进度 <span className="text-[var(--text-dim)]">{range}</span>
            </>
          ) : (
            summaryWords(notices)
          )}
        </span>
      </button>
      <Fold open={open} testId="task-progress-steps">
        {notices.map((notice, index) => {
          const words = progressWords(notice, notice.node === null ? undefined : links.nodeName(notice.node));
          return (
            <div
              key={notice.id}
              data-fold-row
              data-testid="task-progress-row"
              data-tone={words.tone}
              className="relative min-w-0 pl-[30px]"
            >
              <RailMarks
                node={words.tone === "fail" ? "fail" : words.tone === "wait" ? "ask" : "dot"}
                first={index === 0}
                last={index === notices.length - 1}
              />
              <div
                className={`flex min-h-[30px] items-center gap-2 text-[length:var(--fs-meta)] ${
                  words.tone === "fail"
                    ? "text-[var(--danger)]"
                    : words.tone === "wait"
                      ? "text-[var(--attn-text)]"
                      : "text-[var(--text-2)]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{words.text}</span>
                <span className="flex-none text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
                  {clockWords(notice.timestamp)}
                </span>
              </div>
            </div>
          );
        })}
      </Fold>
    </div>
  );
}

/**
 * The line in a conversation a task was made from: "已转为任务「名字」 · 初始图等你确认 · 打开 ›", or that it was dropped.
 *
 * @remarks
 * 设计稿第 1 屏: a centred system line with the graph icon. The name and the state are the task's now, from the
 * window's links; the mark of an abandoned task reads "任务已放弃", and one whose task is not in the list (yet)
 * "已转为任务" with nothing to open.
 *
 * @sideEffects none; pressing "打开" opens the task's tab.
 * @param props - The mark.
 * @returns The line.
 */
export function TaskMarkLine({ notice }: { readonly notice: MarkNotice }) {
  const links = use(TaskLinksContext);
  const task = links.task(notice.taskId);
  const abandoned = notice.state === "abandoned";
  return (
    <div
      data-testid="notice"
      data-item-id={notice.id}
      data-mark={abandoned ? "abandoned" : "converted"}
      className="flex w-full items-center justify-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]"
    >
      <Flowchart size={12} />
      {abandoned ? (
        "任务已放弃"
      ) : task === undefined ? (
        "已转为任务"
      ) : (
        <>
          <span>已转为任务「{task.name}」</span>
          <span>· {task.status} ·</span>
          <button
            type="button"
            onClick={() => links.openTask(notice.taskId)}
            className="text-[var(--tint)] hover:underline"
          >
            打开 ›
          </button>
        </>
      )}
    </div>
  );
}
