import { isAuthFailure } from "@atrium/client";
import type { Notice, Step, Turn } from "@atrium/protocol";
import {
  ArrowBendDownRight,
  ArrowClockwise,
  ArrowsInLineVertical,
  CaretDown,
  CaretRight,
  Database,
  FileText,
  GitBranch,
  GitFork,
  Key,
  PencilSimple,
  Question,
  Stop,
  Warning,
} from "../design/icons";
import { type ReactNode, createContext, use, useEffect, useMemo, useState } from "react";
import { type LaunchInTurn, LaunchSteps } from "./launch-timeline";
import { type MessageImages, MessageImagesContext } from "./message-images";
import { useClock } from "../state/clock";
import { messageTag } from "./composer-text";
import { Fold } from "./fold";
import { Markdown } from "./markdown";
import { CopyButton, UserBubble, timeOfDay } from "./messages";
import { RunStatus } from "./run-status";
import type { LanePlace } from "./lanes";
import { SourceLines } from "./source-line";
import { CompactingRow, DiffBlock, ProcessRowView, StreamedText, useWholeStep } from "./steps";
import {
  type LaneLayout,
  type ProcessRow,
  compactedText,
  countProcess,
  describeStep,
  formatDuration,
  formatTokens,
  hostNoticeText,
  laneLayout,
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
  // A new workspace's first turn has a process for its steps alone, though the agent took none.
  if (steps.length > 0 && steps.every((step) => step.kind === "thinking")) {
    const durations = steps.map((step) => (step.kind === "thinking" ? step.durationMs : null));
    const known = durations.every((duration) => duration !== null);
    const total = durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
    return describeStep({ kind: "thinking", id: "", text: "", durationMs: known ? total : null }, false).verb;
  }
  const duration = turn.durationMs === null ? "" : `，用时 ${formatDuration(turn.durationMs)}`;
  return `${OUTCOME_TEXT[turn.outcome]}${duration}`;
}

/** Where a new workspace's first message stands while its steps go on, or after one failed. */
type LaunchStatus = "preparing" | "failed";

/**
 * A run's process header: "进行中 · 12s" while it runs, then "› 已完成，用时 N · 读了 …".
 *
 * @remarks
 * The cat shows while the run lasts; finished, a chevron takes its place, pointing down while the
 * process is open and right while it is folded (SPEC-0001, "过程的呈现"). Both start at the
 * reply's left edge rather than on the rail, so the header lines up with the reply below
 * (design-language, "消息流 · 过程"); the chevron's box is pulled left by its inner margin. The
 * summary is said only while folded: open, the rail says it (`processParts`). Once the process has
 * folded or unfolded in view, the summary comes in after the fold is well under way. Before a new
 * workspace's first message has gone, the same line says "准备工作区", and "没建好工作区" once a
 * step failed (design-language, "新建工作区页").
 *
 * @sideEffects Calls `onToggle` when clicked.
 * @param props - The turn, its process, whether that is open, when its run started, whether the
 *   process has folded or unfolded since it was shown, what a click does, and where a new
 *   workspace's steps stand.
 * @returns The header.
 */
function ProcessHeader({
  turn,
  process,
  open,
  startedAt,
  moved,
  onToggle,
  launch,
}: {
  readonly turn: Turn;
  readonly process: readonly ProcessRow[];
  readonly open: boolean;
  readonly startedAt: number | null;
  readonly moved: boolean;
  readonly onToggle: () => void;
  readonly launch: LaunchStatus | null;
}) {
  const running = turn.outcome === "running" && launch !== "failed";
  const parts = launch === null ? processParts(countProcess(turn.steps), turn.changes.length) : [];
  return (
    <button
      type="button"
      aria-expanded={open}
      disabled={running || launch !== null}
      onClick={onToggle}
      data-testid="process-header"
      className="atrium-press-row group relative mt-3 flex min-h-[30px] w-full min-w-0 items-center text-left text-[length:var(--fs-meta)] text-[var(--text-muted)]"
    >
      {running ? (
        <RunStatus startedAt={startedAt} label={launch === "preparing" ? "准备工作区" : "进行中"} />
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <CaretDown
            size={13}
            className={`atrium-fold-chevron -ml-[4.5px] flex-none group-hover:text-[var(--text-2)] ${open ? "" : "-rotate-90"}`}
          />
          <span className="flex-none font-medium text-[var(--text)]">
            {launch === "failed" ? "没建好工作区" : headerTitle(turn, process)}
          </span>
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
 * A row's place among its turn's lanes.
 *
 * @remarks
 * None in a turn without lanes (SPEC-0002, "显示 · 过程轨道").
 *
 * @sideEffects none
 * @param lanes - The turn's lanes.
 * @param index - The row's position.
 * @returns The place, or `undefined`.
 */
function lanePlace(lanes: LaneLayout, index: number): LanePlace | undefined {
  const row = lanes.rows[index];
  return row === undefined || lanes.width === 0 ? undefined : { row, width: lanes.width };
}

/**
 * A row's key among its turn's rows.
 *
 * @remarks
 * Its step's id, or its own for an explore group and an event.
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
            className="atrium-press-row flex h-[30px] w-full items-center gap-2 rounded-[var(--r)] px-2 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)]"
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

/** How a turn's "从这里分叉" behaves, where a session can be forked. */
export interface ForkFromTurn {
  /** Forks after the turn. */
  readonly fork: (turnId: string) => void;
  /** Opens a child conversation carrying the turns up to this one (SPEC-0002, "第一步 · 入口"). */
  readonly child?: (turnId: string) => void;
  /** Whether the session runs, stops or compacts, so no fork can be made now. */
  readonly blocked: boolean;
  /**
   * Whether the next turn opened with notices or a task, not your message: pi cuts a fork only at
   * a user message, so none can be made from this turn (SPEC-0002, "第一步 · 入口").
   */
  readonly cut?: boolean;
}

/**
 * Why a turn's fork or child cannot be made now, if it cannot.
 *
 * @remarks
 * A turn before one not opened by you never can; any other while the session is busy.
 *
 * @sideEffects none
 * @param fork - How forking behaves.
 * @param what - What the button makes: "分叉" or "开子对话".
 * @returns The reason, or `null` when it can.
 */
function forkRefusal(fork: ForkFromTurn, what: string): string | null {
  if (fork.cut === true) return `下一轮不是你发的消息，不能从这里${what}`;
  return fork.blocked ? `运行中不能${what}` : null;
}

/**
 * The "从这里分叉" button beside a reply's copy.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令 · 分叉"), design-language ("分叉按钮"): drawn as the copy button;
 * while the session runs it is faded, keeps its colours on hover, shows a not-allowed cursor, says
 * "运行中不能分叉" and does nothing.
 *
 * @sideEffects Forks the session when clicked and not blocked.
 * @param props - The turn and how forking behaves.
 * @returns The button.
 */
function ForkButton({ turnId, fork }: { readonly turnId: string; readonly fork: ForkFromTurn }) {
  const refusal = forkRefusal(fork, "分叉");
  return (
    <button
      type="button"
      aria-label="从这里分叉"
      title={refusal ?? "从这里分叉"}
      aria-disabled={refusal !== null}
      className={`atrium-press-sm rounded-[var(--r)] p-1 text-[var(--text-dim)] ${
        refusal === null ? "hover:bg-[var(--hover)] hover:text-[var(--text-muted)]" : "cursor-not-allowed opacity-40"
      }`}
      onClick={() => {
        if (refusal === null) fork.fork(turnId);
      }}
    >
      <GitFork size={14} />
    </button>
  );
}

/**
 * The "从这里开子对话" button right of a reply's fork button.
 *
 * @remarks
 * SPEC-0002 ("第一步 · 入口"; prototype A): drawn as the fork button, a "↳"; refused when forking
 * is, as it carries the turns the same way, saying "运行中不能开子对话", or that the next turn is
 * not your message.
 *
 * @sideEffects Asks for a child conversation when clicked and not refused.
 * @param props - The turn, what opening a child does, and how forking behaves.
 * @returns The button.
 */
function ChildButton({
  turnId,
  open,
  fork,
}: {
  readonly turnId: string;
  readonly open: (turnId: string) => void;
  readonly fork: ForkFromTurn;
}) {
  const refusal = forkRefusal(fork, "开子对话");
  return (
    <button
      type="button"
      aria-label="从这里开子对话"
      title={refusal ?? "从这里开子对话"}
      aria-disabled={refusal !== null}
      className={`atrium-press-sm rounded-[var(--r)] p-1 text-[var(--text-dim)] ${
        refusal === null ? "hover:bg-[var(--hover)] hover:text-[var(--text-muted)]" : "cursor-not-allowed opacity-40"
      }`}
      onClick={() => {
        if (refusal === null) open(turnId);
      }}
    >
      <ArrowBendDownRight size={14} />
    </button>
  );
}

/**
 * The line under a finished turn: copy, fork, files changed, usage and time.
 *
 * @remarks
 * "复制、本轮用量（这一轮的输入 + 输出 token）、时间" (SPEC-0001, "消息下方的信息"); the files chip
 * opens the turn's changes (SPEC-0001, "每轮改动汇总"). Copy takes the reply's Markdown source,
 * the one copy there is; forking sits right of it where the session can be forked. The time is
 * when the turn ended.
 *
 * @sideEffects none
 * @param props - The turn, its reply and how forking behaves, if offered.
 * @returns The info row and, when open, the files.
 */
function TurnFooter({
  turn,
  reply,
  fork,
}: {
  readonly turn: Turn;
  readonly reply: string | null;
  readonly fork: ForkFromTurn | undefined;
}) {
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
        {fork === undefined ? null : <ForkButton turnId={turn.id} fork={fork} />}
        {fork?.child === undefined ? null : <ChildButton turnId={turn.id} open={fork.child} fork={fork} />}
        {turn.changes.length === 0 ? null : (
          <button
            type="button"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen(!filesOpen)}
            className="atrium-press ml-2 flex h-6 items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--hover)] px-2.5 text-[var(--text-muted)] hover:bg-[var(--selected)] hover:text-[var(--text-2)]"
          >
            <PencilSimple size={12} />
            改了 {turn.changes.length} 个文件
            {added + removed === 0 ? null : (
              <>
                <span className="text-[var(--ok-text)]">+{added}</span>
                <span className="text-[var(--danger)]">−{removed}</span>
              </>
            )}
            <CaretDown size={9} className={`atrium-fold-chevron ${filesOpen ? "rotate-180" : ""}`} />
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

/** Opens the settings at "模型与账户", for the error card's "去登录"; none where there are no settings. */
export const OpenLogin = createContext<(() => void) | null>(null);

/** The error card's one main button, on a light wash of the card's colour. */
const CARD_PRIMARY = "atrium-press rounded-[var(--r-pill)] px-2.5 leading-[22px] font-medium hover:brightness-95";

/**
 * pi's error for a failed turn, folded until asked for.
 *
 * @remarks
 * A short line, with the raw error behind "详情" at its right end (SPEC-0001, "运行出错与停止");
 * a turn pi went away in has no text of pi's. The last turn offers "重试", which runs it again as
 * the host does after a restart (SPEC-0001, "运行控制"). An error that looks like a credentials
 * problem, by the rule the host sets the sidebar's key by, shows the key and "登录已失效"; where
 * "重试" is offered, "去登录" is the one main button and "重试" plain text, so the line has one
 * thing to do first (design-language, "失败的一轮").
 *
 * @sideEffects Calls `onRetry` or opens the settings when asked.
 * @param props - pi's error text, if there is any, and what "重试" does, if it is offered.
 * @returns The error card.
 */
function TurnError({ error, onRetry }: { readonly error: string | null; readonly onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  const openLogin = use(OpenLogin);
  const auth = error !== null && isAuthFailure(error);
  const login = auth && onRetry !== undefined && openLogin !== null ? openLogin : null;
  const wash = auth ? "bg-[var(--attn-soft)] text-[var(--attn-text)]" : "bg-[var(--danger-soft)] text-[var(--danger)]";
  return (
    <div
      className={`my-1 text-[length:var(--fs-meta)] ${auth ? "text-[var(--attn)]" : "text-[var(--danger)]"}`}
      data-testid="turn-error"
    >
      <div className="flex min-h-[26px] items-center gap-1.5">
        {auth ? <Key size={14} /> : <Warning size={14} />}
        <span>{auth ? "登录已失效" : "回复出错"}</span>
        {login === null ? null : (
          <button type="button" className={`${CARD_PRIMARY} ${wash}`} onClick={login}>
            去登录
          </button>
        )}
        {onRetry === undefined ? null : (
          <button
            type="button"
            className={
              login === null
                ? `${CARD_PRIMARY} ${wash}`
                : "atrium-press rounded-[var(--r)] px-1.5 leading-[22px] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
            }
            onClick={onRetry}
          >
            重试
          </button>
        )}
        {error === null || error === "" ? null : (
          <button
            type="button"
            aria-expanded={open}
            className="atrium-press ml-auto inline-flex items-center gap-0.5 rounded-[var(--r)] px-1 leading-[22px] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
            onClick={() => setOpen(!open)}
          >
            详情
            <CaretRight size={12} className={`atrium-fold-chevron ${open ? "rotate-90" : ""}`} />
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
  /** "从这里分叉" under the reply, where the session can be forked. */
  readonly fork?: ForkFromTurn;
  /** pi compacts the context now, while this turn runs; only for the running turn (design-language, "运行中压缩"). */
  readonly compacting?: boolean;
  /**
   * The launch that sent this turn's message from the new-workspace page; the turn is a stand-in
   * with the launch's id until the host's arrives (SPEC-0001, "M1.11 的新建工作区").
   */
  readonly launch?: LaunchInTurn | undefined;
}

/**
 * Where a turn's launch stands, as its header and message show it.
 *
 * @remarks
 * Going on until the message has gone; failed once a step failed (SPEC-0001, "M1.11 的新建工作区").
 *
 * @sideEffects none
 * @param launch - The turn's launch, if any.
 * @returns Where it stands, or `null` once the message has gone or without one.
 */
function launchStatus(launch: LaunchInTurn | undefined): LaunchStatus | null {
  if (launch === undefined) return null;
  if (launch.launch.failure !== undefined) return "failed";
  return launch.launch.sentAt === null ? "preparing" : null;
}

/**
 * The images of a launch's message, as the page kept them, until its turn arrives.
 *
 * @remarks
 * Before the host has the message, its thumbnails are the previews the page kept; the host's turn
 * then finds them by its own message id (`MessageImages.sent`).
 *
 * @sideEffects none
 * @param outer - The images of the conversation.
 * @param launch - The launch, while its turn is a stand-in.
 * @returns The images.
 */
function useLaunchImages(outer: MessageImages, launch: LaunchInTurn | undefined): MessageImages {
  const previews = launch?.launch.images;
  return useMemo(() => {
    if (previews === undefined) return outer;
    const shown = previews.map(({ image }) => image.preview);
    return { sent: () => shown, load: (turnId, index, settled) => outer.load(turnId, index, settled) };
  }, [outer, previews]);
}

/**
 * One turn: the question, the process on its rail, the reply and its info row.
 *
 * @remarks
 * "突出结果，折叠过程" (SPEC-0001, "对话区"). The process shows on its rail while the turn runs;
 * a turn that finishes in view stays open a second so "完成" can be seen, then folds into its
 * header, smoothly (SPEC-0001, "过程的呈现": "跑完后的折叠"). A turn already finished when shown
 * is simply folded until opened; folded, steers stay visible (SPEC-0001, "过程的显示"). A turn without process steps has no header;
 * while it runs with nothing to show yet, the run's line stands in its place until the first
 * step or the reply's first text. Steps that arrive while the turn is shown play their entrance;
 * the ones there when it was first shown do not. The reply streams below, revealed smoothly; a
 * failed turn shows pi's error, and ends there when it has no reply and changed no files: its info
 * row would hold nothing worth reading (SPEC-0001, "消息下方的信息"). While pi compacts during the
 * run, the rail ends in "正在压缩上下文…" where the turn has got to, the step before it no longer
 * going on (design-language, "运行中压缩"). A new workspace's first turn shows its steps first on
 * the rail, then their summary, the agent's steps after it, under one header from the start
 * (design-language, "新建工作区页"); its message shows faded until it has gone.
 *
 * @sideEffects Holds a finished turn open for a second on the clock.
 * @param props - The turn, the run's start, "重试" and forking where offered, whether pi
 *   compacts now, and the launch that sent its message.
 * @returns The turn.
 */
export function TurnView({ turn, runStartedAt, onRetry, fork, compacting = false, launch }: TurnViewProps) {
  const clock = useClock();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const { process, reply } = useMemo(() => layoutTurn(turn), [turn]);
  const lanes = useMemo(() => laneLayout(process), [process]);
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
    running && (step.kind === "tool" ? step.status === "running" : !compacting && step.id === lastId);
  const open = running || lingering || (expanded ?? false);
  const [wasOpen, setWasOpen] = useState(open);
  const [moved, setMoved] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setMoved(true);
  }
  const lead = process.filter((row) => row.kind === "step" && row.step.kind === "steer");
  const status = launchStatus(launch);
  // A stand-in has the launch's id; its run's start is the host's once there is a run.
  const standIn = launch !== undefined && turn.id === launch.launch.id;
  const images = useLaunchImages(use(MessageImagesContext), standIn ? launch : undefined);
  const waiting =
    launch === undefined && running && !compacting && process.length === 0 && (reply === null || reply.text === "");
  return (
    <div
      className="flex flex-col"
      data-testid="turn"
      // A stand-in is no item yet: the host's turn coming in is not older items put in front.
      data-item-id={standIn ? undefined : turn.id}
      data-turn-id={turn.id}
      data-outcome={turn.outcome}
    >
      {turn.source === null ? (
        <MessageImagesContext value={images}>
          <UserBubble
            text={turn.user.text}
            images={turn.user.images}
            {...(status === null ? { timestamp: turn.user.timestamp } : {})}
            auto={turn.user.auto}
            command={messageTag(turn.user.command)}
            {...(standIn ? {} : { turnId: turn.id })}
            clientMessageId={turn.user.clientMessageId}
            settled={turn.outcome !== "running"}
            dim={status !== null}
            note={status === "failed" ? "没发出，已放回输入框" : null}
          />
        </MessageImagesContext>
      ) : (
        <SourceLines source={turn.source} />
      )}
      {waiting ? (
        <div className="mt-3" data-testid="run-waiting">
          <RunStatus startedAt={runStartedAt ?? turn.startedAt} />
        </div>
      ) : null}
      {process.length === 0 && !compacting && launch === undefined ? null : (
        <>
          <ProcessHeader
            turn={turn}
            process={process}
            open={open}
            startedAt={standIn ? runStartedAt : (runStartedAt ?? turn.startedAt)}
            moved={moved}
            launch={status}
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
            {launch === undefined ? null : <LaunchSteps shown={launch} continues={process.length > 0 || compacting} />}
            {process.map((row, index) => (
              <ProcessRowView
                key={rowKey(row)}
                turnId={turn.id}
                row={row}
                isLive={isLive}
                place={{
                  first: index === 0 && launch === undefined,
                  last: index === process.length - 1 && !compacting,
                  enter: !shownKeys.has(rowKey(row)),
                }}
                lanes={lanePlace(lanes, index)}
              />
            ))}
            {compacting ? (
              <CompactingRow place={{ first: process.length === 0 && launch === undefined, last: true, enter: true }} />
            ) : null}
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
      {running || (turn.outcome === "failed" && reply === null && turn.changes.length === 0) ? null : (
        <TurnFooter turn={turn} reply={reply?.text ?? null} fork={fork} />
      )}
    </div>
  );
}

/**
 * A notice between turns: "上下文已压缩 · 152K → 41K", opening its summary, or one of the
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
          {notice.notice === "restarted" ? (
            <ArrowClockwise size={13} />
          ) : notice.notice === "note" ? (
            <GitBranch size={13} />
          ) : (
            <Question size={13} />
          )}
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
        className="atrium-press-row flex w-full items-center gap-2.5 text-[length:var(--fs-sm)] text-[var(--text-dim)] before:h-px before:flex-1 before:bg-[var(--line)] after:h-px after:flex-1 after:bg-[var(--line)] hover:text-[var(--text-muted)]"
      >
        <span className="flex items-center gap-1.5">
          <ArrowsInLineVertical size={13} />
          {compactedText(notice)}
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
