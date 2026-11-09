import type { AtriumClient } from "@atrium/client";
import type { ScheduleSummary } from "@atrium/protocol";
import { useEffect, useReducer, useRef, useState } from "react";
import { type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { Clock, Warning } from "../design/icons";
import { RunningDots } from "../design/running-dots";
import { useClock } from "../state/clock";
import type { TaskArea } from "../state/task-area";
import { describeTaskCommandError } from "./review-words";
import { nextWords, resultWords, ruleSubWords, whenWords } from "./schedule-words";

/** The colour each result tone takes. */
const TONES = {
  danger: "text-[var(--danger)]",
  run: "text-[var(--tint)]",
  dim: "text-[var(--text-dim)]",
  plain: "text-[var(--text-muted)]",
} as const;

/** The class of a row's text-link actions (设计稿第 3 屏: "linkish"). */
const LINK =
  "whitespace-nowrap text-[length:var(--fs-meta)] text-[var(--tint)] hover:underline disabled:cursor-default disabled:opacity-50";

/** The class of the delete question's buttons: 28px pills, as the task bar's. */
const CONFIRM_BUTTON =
  "atrium-press inline-flex h-7 items-center rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] whitespace-nowrap";

/**
 * One rule's row (设计稿第 3 屏).
 *
 * @remarks
 * Name with project and place under it, when it runs, when next, what became of the last run, and the actions.
 * A running rule offers 立即跑一次, 暂停 and 修改; a paused one 恢复, 修改 and 删除 (the draft shows 删除 only there), and
 * deleting asks again first, on its own line under the row inside the same card, so the name keeps its width (2026-11-09 用户定). 修改 opens the rule's template task, whose tab holds its conversation. A
 * command's failure is worded under the row.
 *
 * @sideEffects Sends `run_schedule_now`, `pause_schedule`, `resume_schedule`, `edit_schedule` and `delete_schedule`;
 * `onOpenTask` opens a task's tab.
 * @param props - The client, the rule, the project's name, the time now, and how to open a task.
 * @returns The row.
 */
function RuleRow({
  client,
  rule,
  project,
  now,
  onOpenTask,
}: {
  readonly client: AtriumClient;
  readonly rule: ScheduleSummary;
  readonly project: string;
  readonly now: number;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  /** Closing the question without deleting puts the focus back on "删除", which was disabled and not focusable while it was open. */
  const refocus = useRef(false);
  const result = resultWords(rule);
  useEffect(() => {
    if (!asking && refocus.current) {
      refocus.current = false;
      deleteButton.current?.focus();
    }
  }, [asking]);

  /**
   * Closes the delete question without deleting.
   *
   * @remarks
   * Escape and "不了" both: the focus goes back to "删除", where the user was, not to the page.
   *
   * @sideEffects Closes the question; asks for the focus to return to "删除" once it can take it.
   */
  const dismiss = (): void => {
    refocus.current = true;
    setAsking(false);
  };

  /**
   * Runs a command once, worded on failure.
   *
   * @remarks
   * A second press while one is on its way does nothing; the rule's own push shows the result.
   *
   * @sideEffects Sends the command; updates the row's state.
   * @param command - The command.
   * @param then - What to do with its answer.
   */
  const run = <T,>(command: () => Promise<T>, then?: (answer: T) => void): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    // Fire and forget: a failure is worded under the row.
    void (async () => {
      try {
        const answer = await command();
        setBusy(false);
        then?.(answer);
      } catch (error) {
        setBusy(false);
        setFailure(describeTaskCommandError(error));
      }
    })();
  };
  return (
    <div data-testid="rule-entry" data-rule={rule.id}>
      <div
        data-testid="rule-row"
        data-paused={rule.paused}
        className={`grid grid-cols-[20px_minmax(0,1fr)_128px_112px_96px_minmax(176px,auto)] items-center gap-x-3 rounded-[var(--r-md)] px-2.5 py-2 hover:bg-[var(--hover)] ${rule.paused ? "text-[var(--text-dim)]" : ""}`}
      >
        <Clock size={14} aria-label="定时规则" className="shrink-0 text-[var(--text-dim)]" />
        <span className="min-w-0" data-testid="rule-name">
          <span className={`block truncate text-[length:var(--fs-meta)] ${rule.paused ? "" : "text-[var(--text)]"}`}>
            {rule.name === "" ? "（还没起名）" : rule.name}
          </span>
          <span className="block text-[length:var(--fs-sm)] break-words text-[var(--text-dim)]">
            {ruleSubWords(rule, project)}
          </span>
        </span>
        <span className="truncate text-[length:var(--fs-meta)] text-[var(--text-muted)]" data-testid="rule-when">
          {whenWords(rule.when)}
        </span>
        <span className="truncate text-[length:var(--fs-sm)] text-[var(--text-dim)]" data-testid="rule-next">
          {nextWords(rule.nextAt, now)}
        </span>
        <span
          className={`flex min-w-0 items-center gap-1.5 text-[length:var(--fs-meta)] ${TONES[result.tone]}`}
          data-testid="rule-result"
        >
          {result.icon === "run" ? <RunningDots size={14} /> : null}
          {result.icon === "alert" ? <Warning size={14} /> : null}
          <span className="truncate">{result.text}</span>
        </span>
        <span className="flex items-center justify-end gap-3" data-testid="rule-actions">
          {rule.paused ? (
            <button
              type="button"
              disabled={busy}
              className={LINK}
              onClick={() => run(() => client.resumeSchedule(rule.id))}
            >
              恢复
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                className={LINK}
                onClick={() => run(() => client.runScheduleNow(rule.id))}
              >
                立即跑一次
              </button>
              <button
                type="button"
                disabled={busy}
                className={LINK}
                onClick={() => run(() => client.pauseSchedule(rule.id))}
              >
                暂停
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            className={LINK}
            onClick={() =>
              run(
                () => client.editSchedule(rule.id),
                (answer) => onOpenTask(answer.taskId),
              )
            }
          >
            修改
          </button>
          {rule.paused ? (
            <button
              ref={deleteButton}
              type="button"
              disabled={busy || asking}
              className={`${LINK} !text-[var(--danger)]`}
              onClick={() => setAsking(true)}
            >
              删除
            </button>
          ) : null}
        </span>
      </div>
      {asking ? (
        <span
          role="group"
          aria-label="删除这条规则？"
          data-testid="confirm-asking"
          className="flex items-center justify-end gap-2 px-2.5 pb-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") dismiss();
          }}
        >
          <span className="text-[length:var(--fs-meta)] whitespace-nowrap text-[var(--danger)]">删除这条规则？</span>
          <button
            type="button"
            autoFocus
            onClick={() => {
              setAsking(false);
              run(() => client.deleteSchedule(rule.id));
            }}
            className={`${CONFIRM_BUTTON} bg-[var(--danger)] font-medium text-white`}
          >
            确定
          </button>
          <button
            type="button"
            onClick={dismiss}
            className={`${CONFIRM_BUTTON} text-[var(--text-2)] hover:bg-[var(--hover)]`}
          >
            不了
          </button>
        </span>
      ) : null}
      {failure === null ? null : (
        <p
          role="alert"
          data-testid="rule-failure"
          className="px-2.5 pb-1.5 text-[length:var(--fs-sm)] text-[var(--danger)]"
        >
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * The "定时" tab: one row for each schedule rule, or the empty state, or why there are none to show (SPEC-0006, "界面 ·
 * 定时标签"; 设计稿第 3 屏).
 *
 * @remarks
 * There is no "新建": a rule comes from a conversation, with `/task`. The tab watches the rules while it is on top.
 * Rows are in the order the rules were made. If the host cannot read the rules file (`schedule_file_unreadable`), or
 * the watch fails for any reason, the tab says so in place of the list instead of waiting for it for good
 * (SPEC-0006, "T9 / T10 审查后用户定").
 *
 * @sideEffects Watches the rules on the host (`list_schedules`), let go of when the tab is left; redraws every half
 * minute so that "下次" stays right.
 * @param props - The client and the area's state.
 * @returns The tab.
 */
export function ScheduleTab({ client, area }: { readonly client: AtriumClient; readonly area: StoreApi<TaskArea> }) {
  const schedules = useStore(client.schedules);
  const index = useStore(client.index);
  const clock = useClock();
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  /** Why the rules could not be read, in words; `null` while they can. */
  const [unreadable, setUnreadable] = useState<string | null>(null);
  useEffect(() => clock.every(30_000, refresh), [clock]);
  useEffect(() => {
    // Fire and forget: the answer lands in the store; a lost connection asks again when it is back.
    client.watchSchedules(true).then(
      () => setUnreadable(null),
      (error: unknown) => setUnreadable(describeTaskCommandError(error)),
    );
    return () => void client.watchSchedules(false).catch(() => undefined);
  }, [client]);
  const now = clock.now();
  return (
    <section aria-label="定时" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-6 py-6">
        <div className="flex items-center gap-3 px-2.5">
          <h2 className="text-[length:var(--fs)] font-semibold text-[var(--text)]">定时</h2>
          <span className="rounded-[var(--r-pill)] bg-[var(--surface-2)] px-2 text-[length:var(--fs-sm)] leading-[20px] text-[var(--text-muted)] tabular-nums">
            {unreadable === null ? schedules.schedules.length : 0}
          </span>
          <span className="flex-1" />
          <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">
            在对话里说清「每天几点做什么」再{" "}
            <code className="font-[family-name:var(--font-mono)] text-[var(--tint)]">/task</code>
            ，就生成定时规则
          </span>
        </div>
        {unreadable !== null ? (
          <p
            role="alert"
            data-testid="schedules-unreadable"
            className="px-2.5 py-8 text-[length:var(--fs-meta)] text-[var(--danger)]"
          >
            {unreadable}
          </p>
        ) : schedules.status !== "ready" ? (
          <p role="status" className="px-2.5 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
            正在读取定时规则…
          </p>
        ) : schedules.schedules.length === 0 ? (
          <p role="status" className="px-2.5 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
            还没有定时规则。在对话里说清「每天几点做什么」再 /task，就生成定时规则。
          </p>
        ) : (
          <div
            data-testid="rule-card"
            className="mt-3 rounded-[var(--r-card)] bg-[var(--surface-1)] px-2 py-2 shadow-[var(--card-shadow)]"
          >
            {schedules.schedules.map((rule) => (
              <RuleRow
                key={rule.id}
                client={client}
                rule={rule}
                project={index.projects.find((one) => one.id === rule.projectId)?.name ?? "项目"}
                now={now}
                onOpenTask={(taskId) => area.getState().openTask(taskId)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
