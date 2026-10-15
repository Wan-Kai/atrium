import type { Control, DiffStat, Interaction, InteractionAnswer } from "@atrium/protocol";
import { ArrowBendDownRight, CaretUp, GitDiff, Question, WarningCircle, X } from "../design/icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DiffCounts } from "../files/diff-parts";

/** What the run control UI can ask of the session. */
export interface RunActions {
  readonly resume: () => void;
  readonly clear: () => void;
  readonly update: (itemId: string, text: string) => void;
  readonly remove: (itemId: string) => void;
  readonly steerQueued: (itemId: string) => void;
  readonly answer: (interactionId: string, answer: InteractionAnswer) => void;
  readonly retry: () => void;
}

/** A small rounded button, as the prototype's `.pill`. */
const PILL =
  "inline-flex h-6 items-center gap-1 rounded-[var(--r-pill)] px-[11px] text-[length:var(--fs-sm)] whitespace-nowrap text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]";

/** A floating capsule above the input box, as the prototype's `.tpill`. */
const CAPSULE =
  "pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--surface-1)] px-[11px] text-[length:var(--fs-sm)] whitespace-nowrap tabular-nums text-[var(--text-2)] shadow-[0_0_0_0.5px_var(--line),0_6px_16px_-8px_rgba(0,0,0,0.22)] dark:bg-[var(--surface-2)]";

/**
 * One queued message in the queue panel: its text, or a field while being edited.
 *
 * @remarks
 * "编辑" turns the text into a field; "完成" or Enter saves it, Esc gives up. "插话" sends it as a
 * steer and shows only while a run goes on (SPEC-0001, "胶囊条").
 *
 * @sideEffects Calls the actions as the user acts.
 * @param props - The item, whether a run goes on, and the actions.
 * @returns The row.
 */
function QueueRow({
  item,
  running,
  actions,
}: {
  readonly item: Control["queue"][number];
  readonly running: boolean;
  readonly actions: RunActions;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /**
   * Saves the edited text, unless it is empty or unchanged.
   *
   * @remarks
   * An empty text would be refused; the item keeps its text then.
   *
   * @sideEffects May call `update`; leaves editing.
   */
  const save = (): void => {
    if (draft !== null && draft.trim() !== "" && draft !== item.text) actions.update(item.id, draft);
    setDraft(null);
  };
  return (
    <div
      className="flex h-[34px] items-center gap-1.5 rounded-[var(--r-md)] pr-1 pl-2.5 text-[length:var(--fs-meta)] hover:bg-[var(--hover)]"
      data-testid="queued"
    >
      {draft === null ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-[var(--text-2)]">{item.text === "" ? "图片" : item.text}</span>
          {item.images > 0 ? (
            <span className="shrink-0 text-[length:var(--fs-xs)] text-[var(--text-dim)]">{item.images} 张图片</span>
          ) : null}
        </span>
      ) : (
        <input
          aria-label="编辑排队的消息"
          value={draft}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field appears because the user asked to edit.
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") save();
            if (event.key === "Escape") setDraft(null);
          }}
          className="h-[26px] min-w-0 flex-1 rounded-[var(--r-sm)] bg-[var(--main)] px-2 outline-none shadow-[inset_0_0_0_1px_var(--tint)]"
        />
      )}
      {running ? (
        <button
          type="button"
          className={`${PILL} text-[var(--tint)]`}
          title="在 agent 下一步之前送达，不会立刻打断"
          onClick={() => actions.steerQueued(item.id)}
        >
          <ArrowBendDownRight size={11} />
          插话
        </button>
      ) : null}
      <button type="button" className={PILL} onClick={() => (draft === null ? setDraft(item.text) : save())}>
        {draft === null ? "编辑" : "完成"}
      </button>
      <button
        type="button"
        aria-label="删除"
        className="flex size-6 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        onClick={() => actions.remove(item.id)}
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * The capsule bar above the input box: the queue and the steers on their way.
 *
 * @remarks
 * SPEC-0001 ("胶囊条"): "● 排队 N" opens the queue panel above it, and opens by itself when a
 * message joins the queue; a paused queue says so, with "继续发送" in the panel.
 * "N 条插话将在下一步前送达" lists the steers pi has not delivered yet. "+A −D" on the right is the
 * workspace's git changes, opening the changes panel ("工作区改动"). Nothing shows when all three
 * are empty.
 *
 * @sideEffects Calls the actions as the user acts.
 * @param props - The run control, whether a run goes on, the actions, and the workspace's changes.
 * @returns The bar, or nothing.
 */
export function ControlTrack({
  control,
  running,
  actions,
  changes,
}: {
  readonly control: Control;
  readonly running: boolean;
  readonly actions: RunActions;
  /** The workspace's git changes, when it has some, and the changes panel (SPEC-0001, "工作区改动"). */
  readonly changes?: { readonly stat: DiffStat; readonly open: boolean; readonly onToggle: () => void };
}) {
  const [open, setOpen] = useState(false);
  const count = control.queue.length;
  const before = useRef(count);
  useEffect(() => {
    // A message joining the queue shows the panel; an emptied queue has none to show.
    // oxlint-disable-next-line react-hooks-js/set-state-in-effect -- follows the queue the host sends.
    if (count > before.current) setOpen(true);
    before.current = count;
  }, [count]);
  if (count === 0 && control.steers.length === 0 && changes === undefined) return null;
  const paused = control.paused !== null;
  return (
    <>
      {open && count > 0 ? (
        <div
          role="dialog"
          aria-label="排队"
          className="absolute right-0 bottom-[calc(100%+44px)] left-0 z-10 max-h-[46vh] overflow-auto rounded-[var(--r-card)] bg-[var(--surface-1)] p-1.5 shadow-[var(--float-shadow)] dark:bg-[var(--surface-2)]"
        >
          <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <span>
              排队 {count} · {paused ? "已暂停" : "本次运行结束后依次发送"}
            </span>
            <span className="flex gap-3">
              {paused ? (
                <button type="button" className="text-[var(--tint)]" onClick={actions.resume}>
                  继续发送
                </button>
              ) : null}
              <button type="button" className="hover:text-[var(--text-muted)]" onClick={actions.clear}>
                清空
              </button>
            </span>
          </div>
          {control.queue.map((item) => (
            <QueueRow key={item.id} item={item} running={running} actions={actions} />
          ))}
        </div>
      ) : null}
      <div className="pointer-events-none absolute right-1 bottom-[calc(100%+8px)] left-1 flex gap-1.5">
        {count > 0 ? (
          <button type="button" aria-expanded={open} className={CAPSULE} onClick={() => setOpen(!open)}>
            <span className={`size-1.5 rounded-full ${paused ? "bg-[var(--attn)]" : "bg-[var(--tint)]"}`} />
            排队 {count}
            {paused ? " · 已暂停" : ""}
            <CaretUp size={10} className={`text-[var(--text-dim)] ${open ? "rotate-180" : ""}`} />
          </button>
        ) : null}
        {control.steers.length > 0 ? (
          <span className={`${CAPSULE} text-[var(--tint)]`} data-testid="steers">
            <ArrowBendDownRight size={12} />
            {control.steers.length} 条插话将在下一步前送达
          </span>
        ) : null}
        {changes === undefined ? null : <ChangesCapsule {...changes} />}
      </div>
    </>
  );
}

/**
 * The workspace's changes capsule alone, as the empty state shows it with no session open.
 *
 * @remarks
 * Where the capsule bar would be (SPEC-0001, "工作区改动").
 *
 * @sideEffects none
 * @param props - The changes and the panel.
 * @returns The capsule.
 */
export function ChangesTrack({
  changes,
}: {
  readonly changes: { readonly stat: DiffStat; readonly open: boolean; readonly onToggle: () => void };
}) {
  return (
    <div className="pointer-events-none absolute right-1 bottom-[calc(100%+8px)] left-1 flex gap-1.5">
      <ChangesCapsule {...changes} />
    </div>
  );
}

/**
 * The "+A −D" capsule that opens the changes panel.
 *
 * @remarks
 * On the bar's right (SPEC-0001, "工作区改动").
 *
 * @sideEffects Calls `onToggle` when clicked.
 * @param props - The counts, whether the panel is open, and how to toggle it.
 * @returns The capsule.
 */
function ChangesCapsule({
  stat,
  open,
  onToggle,
}: {
  readonly stat: DiffStat;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="查看改动"
      title="查看改动"
      aria-expanded={open}
      className={`${CAPSULE} ml-auto`}
      onClick={onToggle}
    >
      <GitDiff size={12} className="text-[var(--text-dim)]" />
      <DiffCounts {...stat} />
    </button>
  );
}

/**
 * Seconds left until a deadline, counting down once a second.
 *
 * @remarks
 * For an interaction's "N 秒后超时".
 *
 * @sideEffects Runs a timer while there is a deadline.
 * @param deadline - When it ends, or null.
 * @returns The whole seconds left, or null.
 */
function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * A card asking for something, as the prototype's `.icard`: an icon tile, a title, a line under
 * it, and what to do.
 *
 * @remarks
 * Shared by extension dialogs (attention colours) and the error card (danger colours).
 *
 * @sideEffects none
 * @param props - The tone, icon, title, line, body and side action.
 * @returns The card.
 */
function Card({
  tone,
  icon,
  title,
  sub,
  children,
  side,
  testId,
}: {
  readonly tone: "attn" | "danger";
  readonly icon: ReactNode;
  readonly title: string;
  readonly sub: ReactNode;
  readonly children?: ReactNode;
  readonly side?: ReactNode;
  readonly testId: string;
}) {
  return (
    <div
      className="my-3 flex items-start gap-3 rounded-[var(--r-card)] bg-[var(--surface-1)] py-3 pr-3.5 pl-3 shadow-[var(--card-shadow)]"
      data-testid={testId}
    >
      <div
        className={`flex size-9 flex-none items-center justify-center rounded-[var(--r-md)] shadow-[inset_0_0_0_0.5px_var(--line-soft)] ${
          tone === "attn" ? "bg-[var(--attn-soft)] text-[var(--attn)]" : "bg-[var(--danger-soft)] text-[var(--danger)]"
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mt-px text-[length:var(--fs-meta)] font-medium text-[var(--text)]">{title}</div>
        <div className="mt-px text-[length:var(--fs-sm)] text-[var(--text-muted)]">{sub}</div>
        {children}
      </div>
      {side === undefined ? null : <div className="self-center">{side}</div>}
    </div>
  );
}

/**
 * An extension's question, answered on the card (SPEC-0001, "对话框").
 *
 * @remarks
 * A selection offers its choices as buttons, a confirmation "是" and "否", an input a field and an
 * editor a larger one, each sent with "提交" (or Enter for the input); every kind can be cancelled.
 * A deadline counts down as "N 秒后超时".
 *
 * @sideEffects Calls `onAnswer` when answered.
 * @param props - The question and what to do with the answer.
 * @returns The card.
 */
function InteractionCard({
  interaction,
  onAnswer,
}: {
  readonly interaction: Interaction;
  readonly onAnswer: (answer: InteractionAnswer) => void;
}) {
  const [value, setValue] = useState(interaction.prefill ?? "");
  const left = useSecondsLeft(interaction.deadline);
  const cancel = (
    <button type="button" className={PILL} onClick={() => onAnswer({ cancelled: true })}>
      取消
    </button>
  );
  const submit = (
    <button type="button" className={`${PILL} text-[var(--tint)]`} onClick={() => onAnswer({ value })}>
      提交
    </button>
  );
  return (
    <Card
      tone="attn"
      icon={<Question size={18} />}
      title={interaction.title}
      testId="interaction"
      sub={
        <>
          来自 extension
          {left === null ? null : <span className="tabular-nums"> · {left} 秒后超时</span>}
        </>
      }
    >
      {interaction.message === null ? null : (
        <p className="mt-1.5 text-[length:var(--fs-meta)] whitespace-pre-wrap text-[var(--text-2)]">
          {interaction.message}
        </p>
      )}
      {interaction.kind === "input" ? (
        <input
          aria-label={interaction.title}
          value={value}
          placeholder={interaction.placeholder ?? ""}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) onAnswer({ value });
          }}
          className="mt-2.5 h-8 w-full rounded-[var(--r)] bg-[var(--main)] px-2.5 text-[length:var(--fs-meta)] outline-none shadow-[inset_0_0_0_0.5px_var(--line-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--tint),var(--focus-ring)]"
        />
      ) : null}
      {interaction.kind === "editor" ? (
        <textarea
          aria-label={interaction.title}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={6}
          className="mt-2.5 w-full resize-y rounded-[var(--r)] bg-[var(--main)] px-2.5 py-2 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] outline-none shadow-[inset_0_0_0_0.5px_var(--line-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--tint),var(--focus-ring)]"
        />
      ) : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {interaction.kind === "select"
          ? (interaction.options ?? []).map((option) => (
              <button key={option} type="button" className={PILL} onClick={() => onAnswer({ value: option })}>
                {option}
              </button>
            ))
          : null}
        {interaction.kind === "confirm" ? (
          <>
            <button
              type="button"
              className={`${PILL} text-[var(--tint)]`}
              onClick={() => onAnswer({ confirmed: true })}
            >
              是
            </button>
            <button type="button" className={PILL} onClick={() => onAnswer({ confirmed: false })}>
              否
            </button>
          </>
        ) : null}
        {interaction.kind === "input" || interaction.kind === "editor" ? submit : null}
        {cancel}
      </div>
    </Card>
  );
}

/**
 * The card for a session pi keeps crashing in, with "重试".
 *
 * @remarks
 * After three restarts in a row failed (SPEC-0001, "运行出错与停止"); the transcript is unharmed.
 *
 * @sideEffects Calls `onRetry` when asked.
 * @param props - How many restarts failed and what "重试" does.
 * @returns The card.
 */
function FailureCard({ attempts, onRetry }: { readonly attempts: number; readonly onRetry: () => void }) {
  return (
    <Card
      tone="danger"
      icon={<WarningCircle size={18} />}
      title={`pi 连续崩溃，自动重启 ${attempts} 次都没有成功`}
      sub="对话记录不受影响"
      testId="failure"
      side={
        <button type="button" className={PILL} onClick={onRetry}>
          重试
        </button>
      }
    />
  );
}

/**
 * Everything waiting for the user above the input box: questions from extensions, then a failure.
 *
 * @remarks
 * Kept out of the scrolling transcript so they stay in view (SPEC-0001, "对话框": "消息流底部的卡片").
 *
 * @sideEffects Calls the actions as the user acts.
 * @param props - The run control and the actions.
 * @returns The cards, or nothing.
 */
export function ControlCards({ control, actions }: { readonly control: Control; readonly actions: RunActions }) {
  if (control.interactions.length === 0 && control.failure === null) return null;
  return (
    <div className="mx-auto w-full max-w-[var(--column)] px-6">
      {control.interactions.map((interaction) => (
        <InteractionCard
          key={interaction.id}
          interaction={interaction}
          onAnswer={(answer) => actions.answer(interaction.id, answer)}
        />
      ))}
      {control.failure === null ? null : <FailureCard attempts={control.failure.attempts} onRetry={actions.retry} />}
    </div>
  );
}
