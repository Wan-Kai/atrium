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
} from "@phosphor-icons/react";
import { type ReactNode, useMemo, useState } from "react";
import { useDisplayMode } from "../state/display-mode";
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
 * The words of a finished turn's process header.
 *
 * @remarks
 * "已完成，用时 2 分 13 秒 · 读了 8 个文件 · 跑了 2 条命令" (SPEC-0001, "过程的呈现"). A process of
 * thinking only says how long it thought instead (SPEC-0001, "一轮里的文字").
 *
 * @sideEffects none
 * @param turn - The turn.
 * @param process - Its process rows.
 * @returns The header text, without the failed-command mark.
 */
function headerText(turn: Turn, process: readonly ProcessRow[]): string {
  const steps = processSteps(process);
  if (steps.every((step) => step.kind === "thinking")) {
    const durations = steps.map((step) => (step.kind === "thinking" ? step.durationMs : null));
    const known = durations.every((duration) => duration !== null);
    const total = durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
    return describeStep({ kind: "thinking", id: "", text: "", durationMs: known ? total : null }, false).verb;
  }
  const duration = turn.durationMs === null ? "" : `，用时 ${formatDuration(turn.durationMs)}`;
  return [
    `${OUTCOME_TEXT[turn.outcome]}${duration}`,
    ...processParts(countProcess(turn.steps), turn.changes.length),
  ].join(" · ");
}

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
 * One turn: the question, the process folded into one line, the reply and its info row.
 *
 * @remarks
 * "突出结果，折叠过程" (SPEC-0001, "对话区"). The process shows while the turn runs, and when
 * finished folds into its header unless opened or in detailed mode; folded, steers stay visible
 * and, in thinking mode, thinking (SPEC-0001, "显示模式"). A turn without process steps has no
 * header; while it runs with nothing to show yet, the run's line stands in its place until the
 * first step or the reply's first text (SPEC-0001, "过程的呈现"). The reply streams below, revealed smoothly; a stopped turn is marked, a failed one shows
 * pi's error.
 *
 * @sideEffects none
 * @param props - The turn and the run's start.
 * @returns The turn.
 */
export function TurnView({ turn, runStartedAt, onRetry }: TurnViewProps) {
  const { mode } = useDisplayMode();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const { process, reply } = useMemo(() => layoutTurn(turn), [turn]);
  const running = turn.outcome === "running";
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
  const open = running || (expanded ?? mode === "detailed");
  const lead = open
    ? []
    : process.filter(
        (row) =>
          row.kind === "step" && (row.step.kind === "steer" || (mode === "thinking" && row.step.kind === "thinking")),
      );
  const failedCommands = countProcess(turn.steps).failedCommands;
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
      />
      {waiting ? (
        <div className="mt-3 flex h-[30px] items-center" data-testid="run-waiting">
          <RunStatus startedAt={runStartedAt ?? turn.startedAt} />
        </div>
      ) : null}
      {process.length === 0 ? null : (
        <button
          type="button"
          aria-expanded={open}
          disabled={running}
          onClick={() => setExpanded(!open)}
          data-testid="process-header"
          className={`mt-3 flex h-[30px] w-full items-center gap-1.5 text-left text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:text-[var(--text-2)] ${
            open ? "mb-1 shadow-[inset_0_-0.5px_0_var(--line)]" : ""
          }`}
        >
          {running ? (
            <RunStatus startedAt={runStartedAt ?? turn.startedAt} />
          ) : (
            <span>
              {headerText(turn, process)}
              {failedCommands === 0 ? null : (
                <span className="text-[var(--danger)]"> · {failedCommands} 条命令失败</span>
              )}
            </span>
          )}
          {running ? null : <CaretDown size={11} className={`transition-transform ${open ? "rotate-180" : ""}`} />}
        </button>
      )}
      {open || lead.length > 0 ? (
        <div className="pt-0.5 pb-2" data-testid="process">
          {(open ? process : lead).map((row) => (
            <ProcessRowView
              key={row.kind === "step" ? row.step.id : row.id}
              turnId={turn.id}
              row={row}
              isLive={isLive}
            />
          ))}
        </div>
      ) : null}
      {turn.outcome === "stopped" ? (
        <div className="my-1 flex items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--attn-text)]">
          <Stop size={11} weight="fill" />
          已停止
        </div>
      ) : null}
      {turn.outcome === "failed" ? (
        <TurnError error={turn.error} {...(onRetry === undefined ? {} : { onRetry })} />
      ) : null}
      {reply === null ? null : (
        <div
          className="mt-2 mb-1 text-[length:var(--fs-reply)] leading-[1.68] text-[var(--text)]"
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
