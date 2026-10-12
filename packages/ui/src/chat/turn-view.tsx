import type { Notice, Step, Turn } from "@atrium/protocol";
import {
  ArrowClockwise,
  ArrowsInLineVertical,
  CaretDown,
  Database,
  FileText,
  PencilSimple,
  Question,
  Stop,
  Warning,
} from "../design/icons";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useClock } from "../state/clock";
import { useDisplayMode } from "../state/display-mode";
import { Fold } from "./fold";
import { Markdown } from "./markdown";
import { CopyButton, UserBubble, timeOfDay } from "./messages";
import { RunStatus } from "./run-status";
import { DiffBlock, ProcessRowView, StreamedText, useWholeStep } from "./steps";
import {
  type ProcessRow,
  countProcess,
  describeStep,
  formatDuration,
  formatTokens,
  hostNoticeText,
  layoutTurn,
  processParts,
  processSteps,
} from "./turn-layout";

/** How a finished turn came out, in words. */
const OUTCOME_TEXT: Readonly<Record<Turn["outcome"], string>> = {
  running: "进行中",
  done: "已完成",
  stopped: "已停止",
  failed: "出错了",
};

/**
 * The title of a finished turn's process header: "已完成，用时 2 分 13 秒".
 *
 * @remarks
 * How the turn came out and how long it took (SPEC-0001, "过程的呈现"). A process of thinking
 * only says how long it thought instead (SPEC-0001, "一轮里的文字").
 *
 * @sideEffects none
 * @param turn - The turn.
 * @param process - Its process rows.
 * @returns The title.
 */
function headerTitle(turn: Turn, process: readonly ProcessRow[]): string {
  const steps = processSteps(process);
  if (steps.every((step) => step.kind === "thinking")) {
    const durations = steps.map((step) => (step.kind === "thinking" ? step.durationMs : null));
    const known = durations.every((duration) => duration !== null);
    const total = durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
    return describeStep({ kind: "thinking", id: "", text: "", durationMs: known ? total : null }, false).verb;
  }
  const duration = turn.durationMs === null ? "" : `，用时 ${formatDuration(turn.durationMs)}`;
  return `${OUTCOME_TEXT[turn.outcome]}${duration}`;
}

/**
 * A run's process header: "进行中 · 12s" while it runs, then "› 已完成，用时 N · 读了 …".
 *
 * @remarks
 * The cat stands on the rail while the run lasts; finished, a chevron takes its place, pointing
 * down while the process is open and right while it is folded (SPEC-0001, "过程的呈现"). The
 * summary is said only while folded: open, the rail says it. A failed command is mentioned in
 * grey, "N 条命令没走通": the agent often recovers, so red is too loud. Once the process has
 * folded or unfolded in view, the summary comes in after the fold is well under way.
 *
 * @sideEffects Calls `onToggle` when clicked.
 * @param props - The turn, its process, whether that is open, the run's start, whether the
 *   process has folded or unfolded since it was shown, and what a click does.
 * @returns The header.
 */
function ProcessHeader({
  turn,
  process,
  open,
  runStartedAt,
  moved,
  onToggle,
}: {
  readonly turn: Turn;
  readonly process: readonly ProcessRow[];
  readonly open: boolean;
  readonly runStartedAt: number | null;
  readonly moved: boolean;
  readonly onToggle: () => void;
}) {
  const running = turn.outcome === "running";
  const counts = countProcess(turn.steps);
  const parts = processParts(counts, turn.changes.length);
  if (counts.failedCommands > 0) parts.push(`${counts.failedCommands} 条命令没走通`);
  return (
    <button
      type="button"
      aria-expanded={open}
      disabled={running}
      onClick={onToggle}
      data-testid="process-header"
      className="group relative mt-3 flex min-h-[30px] w-full min-w-0 items-center text-left text-[length:var(--fs-meta)] text-[var(--text-muted)]"
    >
      {running ? (
        <RunStatus startedAt={runStartedAt ?? turn.startedAt} />
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 pl-[30px]">
          <CaretDown
            size={13}
            className={`atrium-fold-chevron absolute top-[15px] left-[10.5px] -translate-x-1/2 -translate-y-1/2 group-hover:text-[var(--text-2)] ${
              open ? "" : "-rotate-90"
            }`}
          />
          <span className="flex-none font-medium text-[var(--text)]">{headerTitle(turn, process)}</span>
          {open || parts.length === 0 ? null : " "}
          {open || parts.length === 0 ? null : (
            <span
              className={`min-w-0 truncate text-[var(--text-dim)] tabular-nums ${moved ? "atrium-fold-summary" : ""}`}
              data-testid="process-summary"
            >
              · {parts.join(" · ")}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/**
 * A process row's key.
 *
 * @remarks
 * A step's id, or the first call's for an explore row.
 *
 * @sideEffects none
 * @param row - The row.
 * @returns The key.
 */
function rowKey(row: ProcessRow): string {
  return row.kind === "step" ? row.step.id : row.id;
}

/** How long a turn that has just finished stays open before its process folds. */
const LINGER_MS = 1000;

/**
 * The files a turn changed, under its info row; a file opens its changes.
 *
 * @remarks
 * "点开列出文件，点文件展开对应的 diff" (SPEC-0001, "每轮改动汇总"): an edit's diffs, or what a
 * write wrote.
 *
 * @sideEffects none
 * @param props - The turn.
 * @returns The list.
 */
function FilesList({ turn }: { readonly turn: Turn }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mt-2 rounded-[var(--r-md)] p-1 shadow-[inset_0_0_0_0.5px_var(--line)]" data-testid="files">
      {turn.changes.map((change) => (
        <div key={change.path}>
          <button
            type="button"
            aria-expanded={open === change.path}
            onClick={() => setOpen(open === change.path ? null : change.path)}
            className="flex h-[30px] w-full items-center gap-2 rounded-[var(--r)] px-2 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)]"
          >
            <FileText size={14} className="flex-none text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)]">
              {change.path}
            </span>
            {change.added === null ? (
              <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">写入</span>
            ) : (
              <span className="font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)]">
                <span className="text-[var(--ok-text)]">+{change.added}</span>{" "}
                <span className="text-[var(--danger)]">−{change.removed}</span>
              </span>
            )}
          </button>
          {open === change.path ? <FileChanges turnId={turn.id} steps={turn.steps} path={change.path} /> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * What a turn's tools did to one file.
 *
 * @remarks
 * See `FilesList`; successful tool calls only, in order. A change that arrived as a preview is
 * fetched whole.
 *
 * @sideEffects none
 * @param props - The turn's id and steps, and the file.
 * @returns The changes.
 */
function FileChanges({
  turnId,
  steps,
  path,
}: {
  readonly turnId: string;
  readonly steps: readonly Step[];
  readonly path: string;
}) {
  return (
    <>
      {steps.map((step) => {
        if (step.kind !== "tool" || step.status !== "done" || step.details === null) return null;
        const details = step.details;
        if (details.tool === "edit" && details.path === path && details.diff !== null) {
          return (
            <FileChange key={step.id} turnId={turnId} step={step}>
              <DiffBlock diff={details.diff} />
            </FileChange>
          );
        }
        if (details.tool === "write" && details.path === path) {
          return (
            <FileChange key={step.id} turnId={turnId} step={step}>
              <pre className="max-h-80 overflow-auto font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] whitespace-pre-wrap text-[var(--text-3)]">
                {details.content}
              </pre>
            </FileChange>
          );
        }
        return null;
      })}
    </>
  );
}

/**
 * One tool call's change to a file, in a dark block.
 *
 * @remarks
 * Split out so each change fetches its own step when it arrived as a preview.
 *
 * @sideEffects Fetches the step whole if it is partial.
 * @param props - The turn's id, the step and what to show.
 * @returns The block.
 */
function FileChange({
  turnId,
  step,
  children,
}: {
  readonly turnId: string;
  readonly step: Step;
  readonly children: ReactNode;
}) {
  useWholeStep(turnId, step, true);
  return (
    <div className="mx-1 mt-0.5 mb-1.5 overflow-hidden rounded-[var(--r)] bg-[var(--code)] px-3 py-2.5">
      {children}
      {step.kind === "tool" && step.partial ? (
        <p className="mt-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">正在加载完整内容…</p>
      ) : null}
    </div>
  );
}

/**
 * The line under a finished turn: copy, files changed, usage and time.
 *
 * @remarks
 * "复制、本轮用量（这一轮的输入 + 输出 token）、时间" (SPEC-0001, "消息下方的信息"); the files chip
 * opens the turn's changes (SPEC-0001, "每轮改动汇总"). Copy takes the reply's Markdown source,
 * the one copy there is. The time is when the turn ended.
 *
 * @sideEffects none
 * @param props - The turn and its reply.
 * @returns The info row and, when open, the files.
 */
function TurnFooter({ turn, reply }: { readonly turn: Turn; readonly reply: string | null }) {
  const [filesOpen, setFilesOpen] = useState(false);
  const added = turn.changes.reduce((sum, change) => sum + (change.added ?? 0), 0);
  const removed = turn.changes.reduce((sum, change) => sum + (change.removed ?? 0), 0);
  return (
    <>
      <div
        className="-ml-1 flex items-center gap-0.5 text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums"
        data-testid="turn-footer"
      >
        {reply === null ? null : <CopyButton label="复制回复" text={() => reply} />}
        {turn.changes.length === 0 ? null : (
          <button
            type="button"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen(!filesOpen)}
            className="ml-2 flex h-6 items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--hover)] px-2.5 text-[var(--text-muted)] hover:bg-[var(--selected)] hover:text-[var(--text-2)]"
          >
            <PencilSimple size={12} />
            改了 {turn.changes.length} 个文件
            {added + removed === 0 ? null : (
              <>
                <span className="text-[var(--ok-text)]">+{added}</span>
                <span className="text-[var(--danger)]">−{removed}</span>
              </>
            )}
            <CaretDown size={9} className={filesOpen ? "rotate-180" : ""} />
          </button>
        )}
        {turn.usage === null ? null : (
          <span className="ml-2.5 flex items-center gap-1" title="这一轮的输入 + 输出 token">
            <Database size={13} />
            用量 {formatTokens(turn.usage.input + turn.usage.output)} tok
          </span>
        )}
        <span className="ml-3">{timeOfDay(turn.startedAt + (turn.durationMs ?? 0))}</span>
      </div>
      {filesOpen ? <FilesList turn={turn} /> : null}
    </>
  );
}

/**
 * pi's error for a failed turn, folded until asked for.
 *
 * @remarks
 * A short line, with the raw error behind "展开看原始报错" (SPEC-0001, "运行出错与停止"); a turn
 * pi went away in has no text of pi's. The last turn offers "重试", which runs it again as the
 * host does after a restart (SPEC-0001, "运行控制").
 *
 * @sideEffects Calls `onRetry` when asked.
 * @param props - pi's error text, if there is any, and what "重试" does, if it is offered.
 * @returns The error card.
 */
function TurnError({ error, onRetry }: { readonly error: string | null; readonly onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-[length:var(--fs-meta)] text-[var(--danger)]" data-testid="turn-error">
      <div className="flex items-center gap-1.5">
        <Warning size={14} />
        <span>回复出错</span>
        {onRetry === undefined ? null : (
          <button
            type="button"
            className="rounded-[var(--r-pill)] px-2.5 text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"
            onClick={onRetry}
          >
            重试
          </button>
        )}
        {error === null || error === "" ? null : (
          <button
            type="button"
            className="text-[var(--text-dim)] hover:text-[var(--text-muted)]"
            onClick={() => setOpen(!open)}
          >
            {open ? "收起" : "展开看原始报错"}
          </button>
        )}
      </div>
      {open ? (
        <pre className="mt-1.5 rounded-[var(--r)] bg-[var(--code)] px-3 py-2.5 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] whitespace-pre-wrap text-[var(--text-3)]">
          {error}
        </pre>
      ) : null}
    </div>
  );
}

/** Props of {@link TurnView}. */
export interface TurnViewProps {
  readonly turn: Turn;
  /** When the run in progress started by the host's clock, for the running turn's timer. */
  readonly runStartedAt: number | null;
  /** "重试" for a failed turn, when offered. */
  readonly onRetry?: () => void;
}

/**
 * One turn: the question, the process on its rail, the reply and its info row.
 *
 * @remarks
 * "突出结果，折叠过程" (SPEC-0001, "对话区"). The process shows on its rail while the turn runs;
 * a turn that finishes in view stays open a second so "完成" can be seen, then folds into its
 * header, smoothly (SPEC-0001, "过程的呈现": "跑完后的折叠"). A turn already finished when shown
 * is simply folded, unless opened or in detailed mode; folded, steers stay visible and, in
 * thinking mode, thinking (SPEC-0001, "显示模式"). A turn without process steps has no header;
 * while it runs with nothing to show yet, the run's line stands in its place until the first
 * step or the reply's first text. Steps that arrive while the turn is shown play their entrance;
 * the ones there when it was first shown do not. The reply streams below, revealed smoothly; a
 * failed turn shows pi's error.
 *
 * @sideEffects Holds a finished turn open for a second on the clock.
 * @param props - The turn and the run's start.
 * @returns The turn.
 */
export function TurnView({ turn, runStartedAt, onRetry }: TurnViewProps) {
  const { mode } = useDisplayMode();
  const clock = useClock();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const { process, reply } = useMemo(() => layoutTurn(turn), [turn]);
  const running = turn.outcome === "running";
  const [shownKeys] = useState(() => new Set(process.map(rowKey)));
  const [wasRunning, setWasRunning] = useState(running);
  const [lingering, setLingering] = useState(false);
  if (running !== wasRunning) {
    setWasRunning(running);
    setLingering(!running);
  }
  useEffect(() => (lingering ? clock.after(LINGER_MS, () => setLingering(false)) : undefined), [lingering, clock]);
  const lastId = turn.steps.at(-1)?.id;
  /**
   * Whether a step is going on now.
   *
   * @remarks
   * A running tool, or the turn's last step while the turn runs.
   *
   * @sideEffects none
   * @param step - The step.
   * @returns Whether it is live.
   */
  const isLive = (step: Step): boolean =>
    running && (step.kind === "tool" ? step.status === "running" : step.id === lastId);
  const open = running || lingering || (expanded ?? mode === "detailed");
  const [wasOpen, setWasOpen] = useState(open);
  const [moved, setMoved] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setMoved(true);
  }
  const lead = process.filter(
    (row) =>
      row.kind === "step" && (row.step.kind === "steer" || (mode === "thinking" && row.step.kind === "thinking")),
  );
  const waiting = running && process.length === 0 && (reply === null || reply.text === "");
  return (
    <div
      className="flex flex-col"
      data-testid="turn"
      data-item-id={turn.id}
      data-turn-id={turn.id}
      data-outcome={turn.outcome}
    >
      <UserBubble
        text={turn.user.text}
        images={turn.user.images}
        timestamp={turn.user.timestamp}
        auto={turn.user.auto}
        turnId={turn.id}
        clientMessageId={turn.user.clientMessageId}
        settled={turn.outcome !== "running"}
      />
      {waiting ? (
        <div className="mt-3" data-testid="run-waiting">
          <RunStatus startedAt={runStartedAt ?? turn.startedAt} />
        </div>
      ) : null}
      {process.length === 0 ? null : (
        <>
          <ProcessHeader
            turn={turn}
            process={process}
            open={open}
            runStartedAt={runStartedAt}
            moved={moved}
            onToggle={() => {
              setLingering(false);
              setExpanded(!open);
            }}
          />
          <Fold
            open={open}
            folded={
              lead.length === 0 ? null : (
                <div data-testid="process">
                  {lead.map((row, index) => (
                    <ProcessRowView
                      key={rowKey(row)}
                      turnId={turn.id}
                      row={row}
                      isLive={isLive}
                      place={{ first: index === 0, last: index === lead.length - 1, enter: false }}
                    />
                  ))}
                  <div className="h-2" />
                </div>
              )
            }
          >
            {process.map((row, index) => (
              <ProcessRowView
                key={rowKey(row)}
                turnId={turn.id}
                row={row}
                isLive={isLive}
                place={{
                  first: index === 0,
                  last: index === process.length - 1,
                  enter: !shownKeys.has(rowKey(row)),
                }}
              />
            ))}
            <div className="h-2" />
          </Fold>
        </>
      )}
      {turn.outcome === "stopped" && process.length === 0 ? (
        <div className="my-1 flex items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--attn-text)]">
          <Stop size={12} />
          已停止
        </div>
      ) : null}
      {turn.outcome === "failed" ? (
        <TurnError error={turn.error} {...(onRetry === undefined ? {} : { onRetry })} />
      ) : null}
      {reply === null ? null : (
        <div
          className="mt-2 mb-1 text-[length:var(--fs-reply)] leading-[var(--lh-reply)] text-[var(--text)]"
          data-testid="reply"
          data-streaming={running}
        >
          <StreamedText text={reply.text} streaming={running} />
        </div>
      )}
      {running ? null : <TurnFooter turn={turn} reply={reply?.text ?? null} />}
    </div>
  );
}

/**
 * A notice between turns: "上下文已压缩 · 压缩前 152K tokens", opening its summary, or one of the
 * host's: "进程已自动重启（第 N / 3 次）", or an extension's question and its result.
 *
 * @remarks
 * A centred grey line between thin rules (design-language, "消息流"); the summary is what pi
 * kept of the compacted part. A restart has nothing to open (SPEC-0001, "运行控制").
 *
 * @sideEffects none
 * @param props - The notice.
 * @returns The notice.
 */
export function NoticeView({ notice }: { readonly notice: Notice }) {
  const [open, setOpen] = useState(false);
  if (notice.notice !== "compacted") {
    return (
      <div
        data-testid="notice"
        data-item-id={notice.id}
        className="flex w-full items-center gap-2.5 text-[length:var(--fs-sm)] text-[var(--text-dim)] before:h-px before:flex-1 before:bg-[var(--line)] after:h-px after:flex-1 after:bg-[var(--line)]"
      >
        <span className="flex items-center gap-1.5">
          {notice.notice === "restarted" ? <ArrowClockwise size={13} /> : <Question size={13} />}
          {hostNoticeText(notice)}
        </span>
      </div>
    );
  }
  return (
    <div data-testid="notice" data-item-id={notice.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 text-[length:var(--fs-sm)] text-[var(--text-dim)] before:h-px before:flex-1 before:bg-[var(--line)] after:h-px after:flex-1 after:bg-[var(--line)] hover:text-[var(--text-muted)]"
      >
        <span className="flex items-center gap-1.5">
          <ArrowsInLineVertical size={13} />
          上下文已压缩 · 压缩前 {formatTokens(notice.tokensBefore)} tokens
        </span>
      </button>
      {open ? (
        <div className="mt-2 rounded-[var(--r)] bg-[var(--code)] px-3 py-2.5 text-[length:var(--fs-meta)] text-[var(--text-muted)]">
          <Markdown text={notice.summary} streaming={false} />
        </div>
      ) : null}
    </div>
  );
}
