import type { Step } from "@atrium/protocol";
import { CaretRight, Check, MagnifyingGlass, X } from "../design/icons";
import { type ReactNode, createContext, useContext, useEffect, useId, useState } from "react";
import { FileIcon } from "../files/file-icon";
import { EventWords, type LanePlace, LaneMarks, SpawnWords, laneIndent } from "./lanes";
import { Markdown } from "./markdown";
import { OpenFileContext } from "./file-opener";
import {
  type ProcessRow,
  type ToolStep,
  compactionDetail,
  describeExplore,
  describeStep,
  exploredFiles,
  parseDisplayDiff,
} from "./turn-layout";
import { useRevealedText } from "./use-revealed-text";

/**
 * What stands on the rail for a row (design-language, "消息流 · 过程"); `fail` is a new workspace's
 * step that failed, and `more` the summary its steps fold into (design-language, "新建工作区页");
 * `compaction` is two ticks across the line (design-language, "压缩步骤"); `said` is text the agent
 * said mid-turn, a larger blue dot (design-language, "过程里 AI 说的话").
 */
export type RailNode = "dot" | "said" | "search" | "live" | "dead" | "steer" | "more" | "fail" | "pass" | "compaction";

/** How far the rail stops short of each node's centre: the node's radius and a 4px gap. */
const NODE_GAP: Readonly<Record<RailNode, number>> = {
  // A row whose node is on a lane: the main line runs past unbroken (SPEC-0002, "显示 · 过程轨道").
  pass: 0,
  // The ticks cross the main line, which runs on through them.
  compaction: 0,
  dot: 7,
  said: 7,
  live: 7,
  dead: 7,
  steer: 7,
  more: 9,
  fail: 7,
  search: 11,
};

/**
 * A node's glyph.
 *
 * @remarks
 * Each state has its own shape, not only its own colour (design-language, "原则" 3): a grey dot
 * done, a blue dot with a turning arc going on, × for a dead end, a hollow blue ring for a steer;
 * for a new workspace's steps, a red × failed and a grey › for their summary, turning down while
 * they are open. A compaction is
 * two short ticks across the line, 13 by 1.5px, 3px apart, like a border: the model sees what is
 * above it only as a summary (design-language, "压缩步骤").
 *
 * @sideEffects none
 * @param props - The node.
 * @returns The glyph.
 */
function NodeGlyph({ node }: { readonly node: RailNode }) {
  if (node === "pass") return null;
  if (node === "compaction") {
    return (
      <>
        <span className="h-[1.5px] w-[13px] rounded-full bg-[var(--text-dim)]" />
        <span className="h-[1.5px] w-[13px] rounded-full bg-[var(--text-dim)]" />
      </>
    );
  }
  if (node === "said") {
    return <span className="size-[7px] rounded-full bg-[var(--tint)] shadow-[0_0_0_2px_var(--main)]" />;
  }
  if (node === "search") return <MagnifyingGlass size={14} className="text-[var(--text-muted)]" />;
  if (node === "dead") return <X size={10} weight="bold" className="text-[var(--text-dim)]" />;
  if (node === "fail") return <X size={10} weight="bold" className="text-[var(--danger)]" />;
  if (node === "more")
    return <CaretRight size={10} weight="bold" className="atrium-fold-chevron text-[var(--text-dim)]" />;
  if (node === "steer") {
    return <span className="size-2 rounded-full bg-[var(--main)] shadow-[inset_0_0_0_1.5px_var(--tint)]" />;
  }
  if (node === "live") {
    return (
      <>
        <span className="size-1.5 rounded-full bg-[var(--tint)]" />
        <svg
          viewBox="0 0 16 16"
          className="absolute top-1/2 left-1/2 -mt-2 -ml-2 size-4 animate-spin text-[var(--tint)] [animation-duration:0.9s]"
          data-testid="rail-live"
        >
          <circle
            cx="8"
            cy="8"
            r="6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="26 40"
          />
        </svg>
      </>
    );
  }
  return <span className="size-1.5 rounded-full bg-[var(--node)]" />;
}

/**
 * A row's part of the rail: the line above and below its node, and the node.
 *
 * @remarks
 * The line breaks a little around each node (design-language, "消息流 · 过程"). A dead end and a
 * steer sit one step to the right, off the main line, which runs on beside them; a dead end
 * curves off it dashed, a steer drops in from above and curves back into it. The first row has
 * no line above, the last none below.
 *
 * @sideEffects none
 * @param props - The node, and whether the row is the rail's first or last.
 * @returns The marks, absolutely placed in the row's left 30px.
 */
export function RailMarks({
  node,
  first,
  last,
}: {
  readonly node: RailNode;
  readonly first: boolean;
  readonly last: boolean;
}) {
  const fadeId = useId();
  const branch = node === "dead" || node === "steer";
  const gap = NODE_GAP[node];
  let line: ReactNode;
  if (branch) {
    line = (
      <>
        {first && last ? null : (
          <span
            aria-hidden
            className="absolute left-[10px] w-px bg-[var(--rail)]"
            style={{ top: first ? 15 : 0, ...(last ? { height: 15 } : { bottom: 0 }) }}
          />
        )}
        <svg aria-hidden className="atrium-seg-up absolute top-0 left-0 h-[30px] w-[30px] overflow-visible">
          {node === "dead" ? (
            first ? null : (
              <path
                d="M10.5 -2 C10.5 6, 19.5 3, 19.5 10"
                fill="none"
                stroke="var(--branch)"
                strokeDasharray="2 3"
                strokeLinecap="round"
              />
            )
          ) : (
            <>
              <defs>
                <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--tint)" stopOpacity="0" />
                  <stop offset="1" stopColor="var(--tint)" stopOpacity="0.55" />
                </linearGradient>
              </defs>
              <path d="M19.5 -2 L19.5 10" fill="none" stroke={`url(#${fadeId})`} />
              {last ? null : (
                <path
                  d="M19.5 20 C19.5 27, 10.5 25, 10.5 32"
                  fill="none"
                  stroke="var(--branch)"
                  strokeLinecap="round"
                />
              )}
            </>
          )}
        </svg>
      </>
    );
  } else {
    line = (
      <>
        {first ? null : (
          <span
            aria-hidden
            className="atrium-seg-up absolute top-0 left-[10px] w-px bg-[var(--rail)]"
            style={{ height: 15 - gap }}
          />
        )}
        {last ? null : (
          <span aria-hidden className="absolute bottom-0 left-[10px] w-px bg-[var(--rail)]" style={{ top: 15 + gap }} />
        )}
      </>
    );
  }
  return (
    <>
      {line}
      <span
        aria-hidden
        data-testid="rail-node"
        data-node={node}
        className={`atrium-node absolute top-[15px] grid -translate-x-1/2 -translate-y-1/2 place-items-center ${
          node === "compaction" ? "gap-[1.5px]" : ""
        }`}
        style={{ left: branch ? 19.5 : 10.5 }}
      >
        <NodeGlyph node={node} />
      </span>
    </>
  );
}

/**
 * The opener of a file a tool was given, if it can be opened here.
 *
 * @remarks
 * See `OpenFileContext`.
 *
 * @sideEffects none
 * @param path - The path the tool was given.
 * @returns The opener, or `null`.
 */
function useFileOpener(path: string | null): (() => void) | null {
  const open = useContext(OpenFileContext);
  return path === null || open === null ? null : open(path);
}

/** The look of a file chip (design-language, "文件胶囊"). */
const CHIP_CLASS =
  "inline-flex h-[22px] min-w-0 flex-none items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--surface-1)] pr-2.5 pl-2 text-[length:var(--fs-sm)] text-[var(--text-2)] shadow-[var(--chip-shadow)]";

/**
 * A file as a chip: its type, its name, and what was done to it; a button that opens it, where it can be.
 *
 * @remarks
 * The name only; the whole path shows on hover (design-language, "文件胶囊"). The type shows as its
 * material-icon-theme icon, decoration only, as the name says the type. A file in the session's
 * workspace opens in a pinned file tab (SPEC-0001, "查看标签 · 从对话里打开"). It lies beside its
 * row's button rather than in it, so opening the file does not open the row.
 *
 * @sideEffects Opens the file when clicked, where it can.
 * @param props - The path, and an edit's line counts.
 * @returns The chip.
 */
function FileChip({
  path,
  added = null,
  removed = null,
}: {
  readonly path: string;
  readonly added?: number | null;
  readonly removed?: number | null;
}) {
  const open = useFileOpener(path);
  const name = path.split("/").at(-1) ?? path;
  const inside = (
    <>
      <FileIcon path={path} size={13} />
      <span className="truncate">{name}</span>
      {added === null || removed === null ? null : (
        <span className="text-[length:var(--fs-xs)] tabular-nums">
          <span className="text-[var(--ok-text)]">+{added}</span>{" "}
          <span className="text-[var(--danger)]">−{removed}</span>
        </span>
      )}
    </>
  );
  if (open === null) {
    return (
      <span title={path} data-testid="file-chip" className={CHIP_CLASS}>
        {inside}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`打开 ${path}`}
      data-testid="file-chip"
      data-opens
      onClick={open}
      className={`atrium-press pointer-events-auto ${CHIP_CLASS} cursor-pointer hover:shadow-[inset_0_0_0_0.5px_var(--line-strong)]`}
    >
      {inside}
    </button>
  );
}

/**
 * Whether a step has anything to show when opened.
 *
 * @remarks
 * Many models say they thought without saying what; such thinking, empty or all blank, has no
 * detail and its row does not open, so nothing opens onto an empty block (SPEC-0001, "过程的呈
 * 现"). Text steps go by the same rule; tool steps always have their arguments.
 *
 * @sideEffects none
 * @param step - The step.
 * @returns Whether it has a detail.
 */
function hasDetail(step: Step): boolean {
  return (step.kind !== "thinking" && step.kind !== "text") || step.text.trim() !== "";
}

/**
 * The dark block under a step that shows its content.
 *
 * @remarks
 * "左上标'输出 / 改动'，右上标工具名" (SPEC-0001, "过程的呈现").
 *
 * @sideEffects none
 * @param props - The labels and the content.
 * @returns The block.
 */
function Detail({
  label,
  tool,
  children,
}: {
  readonly label?: string;
  readonly tool?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="mt-0.5 mb-2 overflow-hidden rounded-[var(--r)] bg-[var(--code)] px-3 py-2.5"
      data-testid="step-detail"
    >
      {label === undefined ? null : (
        <div className="mb-1.5 flex justify-between text-[length:var(--fs-xs)] text-[var(--text-dim)]">
          <span>{label}</span>
          <span className="font-[family-name:var(--font-mono)]">{tool}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Preformatted output, scrolling when long.
 *
 * @remarks
 * Outputs can be up to 16 KB; the block stays a readable height.
 *
 * @sideEffects none
 * @param props - The text.
 * @returns The block.
 */
function Output({ text }: { readonly text: string }) {
  return (
    <pre className="max-h-80 overflow-auto font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] leading-relaxed break-words whitespace-pre-wrap text-[var(--text-3)]">
      {text}
    </pre>
  );
}

/**
 * An edit's change with line numbers and add/remove bars.
 *
 * @remarks
 * From pi's display diff (SPEC-0001, "显示模式": "带行号和增删竖条"; design-language, "语义色").
 *
 * @sideEffects none
 * @param props - pi's display diff.
 * @returns The diff.
 */
export function DiffBlock({ diff }: { readonly diff: string }) {
  return (
    <div
      className="-mx-3 -mb-2.5 overflow-x-auto font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] leading-[1.7]"
      data-testid="diff"
    >
      {parseDisplayDiff(diff).map((line, index) => (
        <div
          // Lines never move within a diff.
          // oxlint-disable-next-line react/no-array-index-key -- see above.
          key={index}
          data-kind={line.kind}
          className={`flex whitespace-pre ${
            line.kind === "add"
              ? "bg-[var(--diff-add-bg)] shadow-[inset_2px_0_0_var(--ok)]"
              : line.kind === "del"
                ? "bg-[var(--diff-del-bg)] shadow-[inset_2px_0_0_var(--danger)]"
                : ""
          }`}
        >
          <span className="w-[34px] flex-none pr-2.5 text-right text-[var(--text-dim)] select-none">
            {line.kind === "del" ? "" : (line.number ?? "")}
          </span>
          <span className={`flex-1 pl-2 ${line.kind === "add" ? "text-[var(--text)]" : "text-[var(--text-3)]"}`}>
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Fetches a step that arrived as a preview, by its turn and its id; the app provides the client's. */
export const LoadStepContext = createContext<(turnId: string, stepId: string) => void>(() => undefined);

/**
 * Fetches a step whole once it is wanted, if it arrived as a preview.
 *
 * @remarks
 * Long text travels as a preview (SPEC-0001, "大内容"); the whole step replaces it in the view,
 * after which it is no longer `partial` and nothing more is fetched.
 *
 * @sideEffects Asks for the step through `LoadStepContext` when `wanted` and it is partial.
 * @param turnId - The step's turn.
 * @param step - The step.
 * @param wanted - Whether its content is being shown.
 */
export function useWholeStep(turnId: string, step: Step, wanted: boolean): void {
  const load = useContext(LoadStepContext);
  const partial = step.kind === "tool" && step.partial;
  useEffect(() => {
    if (wanted && partial) load(turnId, step.id);
  }, [load, turnId, step.id, wanted, partial]);
}

/**
 * What a tool step shows when open.
 *
 * @remarks
 * A command's output; an edit's diff; what a write wrote; a read's text; for other tools their
 * arguments and output. A step that arrived as a preview says it is loading the rest.
 *
 * @sideEffects none
 * @param props - The step.
 * @returns The detail block.
 */
function ToolDetail({ step }: { readonly step: ToolStep }) {
  const loading = step.partial ? (
    <p className="mt-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]" data-testid="step-loading">
      正在加载完整内容…
    </p>
  ) : null;
  const details = step.details;
  if (details?.tool === "edit" && details.diff !== null) {
    return (
      <Detail label="改动" tool="edit">
        <DiffBlock diff={details.diff} />
        {loading}
      </Detail>
    );
  }
  if (details?.tool === "write") {
    return (
      <Detail label="写入" tool="write">
        <Output text={details.content} />
        {loading}
      </Detail>
    );
  }
  const output = step.output === null ? null : <Output text={step.output} />;
  if (details !== null) {
    return (
      <Detail label={step.status === "failed" ? "出错" : "输出"} tool={step.tool}>
        {output ?? <p className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">还没有输出</p>}
        {loading}
      </Detail>
    );
  }
  return (
    <Detail label="参数" tool={step.tool}>
      <Output text={JSON.stringify(step.args, null, 2)} />
      {output === null ? null : <div className="mt-2">{output}</div>}
      {loading}
    </Detail>
  );
}

/**
 * Thinking or text, revealed smoothly while it streams.
 *
 * @remarks
 * Split out so each block runs its own reveal (SPEC-0001, "平滑流式输出").
 *
 * @sideEffects none
 * @param props - The text and whether it is still streaming.
 * @returns The rendered text.
 */
export function StreamedText({ text, streaming }: { readonly text: string; readonly streaming: boolean }) {
  return <Markdown text={useRevealedText(text, streaming)} streaming={streaming} />;
}

/** Where a row sits on the rail, and whether it has just appeared. */
interface RailPlace {
  /** No line above: the first row. */
  readonly first: boolean;
  /** No line below: the last row while nothing follows. */
  readonly last: boolean;
  /** Plays the row's entrance: it arrived while the turn runs. */
  readonly enter: boolean;
}

/** A row standing alone, without the rail's line: folded steers, the calls inside an explore row. */
const ALONE: RailPlace = { first: true, last: true, enter: false };

/**
 * A row's padding past the rail, and its lanes' marks.
 *
 * @remarks
 * The words start past the turn's lanes, if it has any (SPEC-0002, "显示 · 过程轨道").
 *
 * @sideEffects none
 * @param lanes - The row's place among the lanes, if the turn has lanes.
 * @param asks - Whether the row's event is a question, drawn in the question's colour.
 * @returns The style and the marks.
 */
function laned(
  lanes: LanePlace | undefined,
  asks = false,
): { style: { paddingLeft: number } | undefined; marks: ReactNode } {
  if (lanes === undefined || lanes.width === 0) return { style: undefined, marks: null };
  return { style: { paddingLeft: laneIndent(lanes.width) }, marks: <LaneMarks place={lanes} asks={asks} /> };
}

/**
 * The words of a step's row: the verb, then what it worked on.
 *
 * @remarks
 * "动词 + 对象" (SPEC-0001, "过程的呈现"). Files are chips, an edit's chip carrying its line
 * counts; a command is monospaced; text said in the middle of a turn is shown as said, without a
 * verb. A step going on shimmers.
 *
 * @sideEffects none
 * @param props - The step and whether it is going on.
 * @returns The words.
 */
function StepWords({ step, live }: { readonly step: Step; readonly live: boolean }) {
  const line = describeStep(step, live);
  const shimmer = live ? "atrium-shimmer" : "";
  if (step.kind === "text") {
    return (
      <span className={`min-w-0 truncate font-medium text-[var(--text)] ${shimmer}`} data-testid="said-words">
        {line.object}
      </span>
    );
  }
  const failed = step.kind === "tool" && step.status === "failed";
  const tone =
    failed || step.kind === "retry"
      ? "text-[var(--text-dim)]"
      : step.kind === "steer"
        ? "text-[var(--tint)]"
        : step.kind === "thinking"
          ? "text-[var(--text-muted)]"
          : "text-[var(--text-2)]";
  const verb = <span className={`flex-none ${tone} ${shimmer}`}>{line.verb}</span>;
  const details = step.kind === "tool" ? step.details : null;
  if (step.kind === "tool" && (details?.tool === "edit" || details?.tool === "write" || details?.tool === "read")) {
    const counted = details.tool === "edit" && details.diff !== null && step.status === "done";
    return (
      <>
        {verb} <FileChip path={details.path} {...(counted ? { added: details.added, removed: details.removed } : {})} />
        {details.tool === "read" && details.offset !== null ? " " : null}
        {details.tool === "read" && details.offset !== null ? (
          <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">第 {details.offset} 行起</span>
        ) : null}
      </>
    );
  }
  const object =
    line.object === "" ? null : details?.tool === "bash" ? (
      <span
        className={`min-w-0 truncate font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] ${
          failed ? "text-[var(--text-dim)]" : "text-[var(--text-muted)]"
        }`}
      >
        {line.object}
      </span>
    ) : (
      <>
        <span className="text-[var(--text-dim)]">·</span>{" "}
        <span className="min-w-0 truncate text-[var(--text-muted)]">{line.object}</span>
      </>
    );
  return (
    <>
      {verb}
      {object === null ? null : " "}
      {object}
    </>
  );
}

/**
 * The words of a compaction's row: "压缩了上下文 · 152K → 41K ›".
 *
 * @remarks
 * Grey, the numbers in even widths, and a chevron that turns down while the detail is open
 * (design-language, "压缩步骤").
 *
 * @sideEffects none
 * @param props - The compaction and whether its detail is open.
 * @returns The words.
 */
function CompactionWords({
  step,
  open,
}: {
  readonly step: Extract<Step, { kind: "compaction" }>;
  readonly open: boolean;
}) {
  const line = describeStep(step, false);
  return (
    <>
      <span className="flex-none text-[var(--text-muted)]" data-testid="compaction-words">
        {line.verb}
      </span>
      {line.object === "" ? null : (
        <>
          {" "}
          <span className="text-[var(--text-dim)]">·</span>{" "}
          <span className="min-w-0 truncate text-[var(--text-muted)] tabular-nums" data-testid="compaction-tokens">
            {line.object}
          </span>
        </>
      )}
      <CaretRight
        size={12}
        className={`atrium-fold-chevron flex-none text-[var(--text-dim)] ${open ? "rotate-90" : ""}`}
      />
    </>
  );
}

/**
 * The line on the rail while pi compacts during the turn: "正在压缩上下文…", shimmering.
 *
 * @remarks
 * Where the turn has got to, standing in for the compaction step until it comes (design-language,
 * "运行中压缩"); only the page draws it, from the session's state, it is no step.
 *
 * @sideEffects none
 * @param props - Its place on the rail, and whether it plays its entrance.
 * @returns The row.
 */
export function CompactingRow({ place }: { readonly place: RailPlace }) {
  return (
    <div
      className={`relative min-w-0 pl-[30px] ${place.enter ? "atrium-step-enter" : ""}`}
      data-testid="step"
      data-kind="compacting"
      data-fold-row
    >
      <RailMarks node="compaction" first={place.first} last={place.last} />
      <div className={`${LINE_CLASS} text-[var(--text-muted)]`} role="status">
        <span className="atrium-shimmer">正在压缩上下文…</span>
      </div>
    </div>
  );
}

/**
 * How a tool step ended, at the row's right: "✓ 通过", "失败".
 *
 * @remarks
 * An edit's counts are in its chip already.
 *
 * @sideEffects none
 * @param props - The step.
 * @returns The end, or nothing.
 */
function StepEnd({ step }: { readonly step: Step }) {
  if (step.kind !== "tool") return null;
  const end = describeStep(step, false).end;
  if (end === null || (step.details?.tool === "edit" && step.status === "done")) return null;
  return (
    <span className="ml-auto flex flex-none items-center gap-1 pl-3 text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
      {end === "通过" ? <Check size={12} /> : step.status === "failed" ? <X size={11} /> : null}
      {end}
    </span>
  );
}

/**
 * The rail's node for a step.
 *
 * @remarks
 * See `RailMarks`: going on, a failed call (a dead end), a steer, a compaction, text the agent said
 * (design-language, "过程里 AI 说的话"), or done.
 *
 * @sideEffects none
 * @param step - The step.
 * @param live - Whether it is going on.
 * @returns The node.
 */
function stepNode(step: Step, live: boolean): RailNode {
  if (step.kind === "tool" && step.status === "failed") return "dead";
  if (step.kind === "steer" || step.kind === "agent") return "steer";
  if (step.kind === "compaction") return "compaction";
  if (live) return "live";
  return step.kind === "text" ? "said" : "dot";
}

/** The row's line of words, the width of the content column; a button, with a hover, when it opens a detail. */
const LINE_CLASS =
  "atrium-step-line -mx-1.5 flex min-h-[30px] w-[calc(100%+12px)] min-w-0 items-center gap-1.5 rounded-[var(--r)] px-1.5 text-left text-[length:var(--fs-meta)]";

/**
 * One step on the rail, and its detail when open.
 *
 * @remarks
 * Clicking a row opens or closes its detail (SPEC-0001, "过程的呈现"); it starts shut. A step
 * going on keeps its detail shut too until clicked, then shows it as it
 * comes: opening on its own and shutting when done made the view jump at every step. A step with
 * nothing to show (`hasDetail`) is words alone, not a button. A failed
 * call branches off as a dead end, a steer joins from the side.
 *
 * @sideEffects Fetches the step whole when it shows and arrived as a preview.
 * @param props - The step's turn, the step, whether it is the one going on now, and its place.
 * @returns The row.
 */
function StepRow({
  turnId,
  step,
  live,
  place,
  lanes,
}: {
  readonly turnId: string;
  readonly step: Step;
  readonly live: boolean;
  readonly place: RailPlace;
  readonly lanes?: LanePlace | undefined;
}) {
  const [opened, setOpened] = useState(false);
  const opens = hasDetail(step);
  const open = opens && opened;
  useWholeStep(turnId, step, open);
  let detail: ReactNode = null;
  if (open && (step.kind === "thinking" || step.kind === "text")) {
    detail = (
      <Detail>
        <div className="text-[length:var(--fs-meta)] text-[var(--text-muted)]">
          <StreamedText text={step.text} streaming={live} />
        </div>
      </Detail>
    );
  } else if (open && step.kind === "tool") {
    detail = <ToolDetail step={step} />;
  } else if (open && step.kind === "compaction") {
    detail = (
      <Detail>
        <p className="mb-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">{compactionDetail(step)}</p>
        <div className="text-[length:var(--fs-meta)] text-[var(--text-muted)]">
          <Markdown text={step.summary} streaming={false} />
        </div>
      </Detail>
    );
  }
  const words =
    step.kind === "compaction" ? (
      <CompactionWords step={step} open={open} />
    ) : (
      <>
        <StepWords step={step} live={live} /> <StepEnd step={step} />
      </>
    );
  const details = step.kind === "tool" ? step.details : null;
  const opensFile =
    useFileOpener(
      details?.tool === "read" || details?.tool === "edit" || details?.tool === "write" ? details.path : null,
    ) !== null;
  const wordsId = useId();
  const { style, marks } = laned(lanes);
  const spawned = step.kind === "tool" && step.details?.tool === "agent" && step.details.spawned !== null;
  return (
    <div
      className={`relative min-w-0 pl-[30px] ${place.enter ? "atrium-step-enter" : ""}`}
      style={style}
      data-testid="step"
      data-kind={step.kind}
      data-open={open}
      data-fold-row
    >
      <RailMarks node={stepNode(step, live)} first={place.first} last={place.last} />
      {marks}
      {spawned ? (
        <SpawnWords step={step} took={lanes?.row.took ?? null} />
      ) : opens && opensFile ? (
        // The row's button lies under its words, so the file's chip in them is a button of its own.
        <div className={`atrium-press-row relative ${LINE_CLASS} has-[>button:hover]:bg-[var(--hover)]`}>
          <button
            type="button"
            aria-expanded={open}
            aria-labelledby={wordsId}
            onClick={() => setOpened(!open)}
            className="absolute inset-0 rounded-[var(--r)]"
          />
          <span id={wordsId} className="pointer-events-none relative flex min-w-0 items-center gap-1.5">
            {words}
          </span>
        </div>
      ) : opens ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpened(!open)}
          className={`atrium-press-row ${LINE_CLASS} hover:bg-[var(--hover)]`}
        >
          {words}
        </button>
      ) : (
        <div className={LINE_CLASS}>{words}</div>
      )}
      {detail}
    </div>
  );
}

/** How many read files an explore row shows as chips before "+N 个". */
const CHIPS_SHOWN = 5;

/**
 * Several read-only tool calls in a row, as one: "探索了代码库 · 读了 3 个文件，搜索了 1 次".
 *
 * @remarks
 * The files read sit under it as chips, at most five then "+N 个" (SPEC-0001, "显示模式").
 * Opening it lists each call, each of which opens like any step.
 *
 * @sideEffects none
 * @param props - The calls' turn, the calls, whether any of them is going on, and its place.
 * @returns The row.
 */
function ExploreRow({
  turnId,
  steps,
  live,
  place,
  lanes,
}: {
  readonly turnId: string;
  readonly steps: readonly ToolStep[];
  readonly live: boolean;
  readonly place: RailPlace;
  readonly lanes?: LanePlace | undefined;
}) {
  const [open, setOpen] = useState(false);
  const line = describeExplore(steps, live);
  const files = exploredFiles(steps);
  const { style, marks } = laned(lanes);
  return (
    <div
      className={`relative min-w-0 pl-[30px] ${place.enter ? "atrium-step-enter" : ""}`}
      style={style}
      data-testid="step"
      data-kind="explore"
      data-open={open}
      data-fold-row
    >
      <RailMarks node={live ? "live" : "search"} first={place.first} last={place.last} />
      {marks}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`atrium-press-row ${LINE_CLASS} hover:bg-[var(--hover)]`}
      >
        <span className={`flex-none text-[var(--text-2)] ${live ? "atrium-shimmer" : ""}`}>{line.verb}</span>{" "}
        <span className="text-[var(--text-dim)]">·</span>{" "}
        <span className="min-w-0 truncate text-[var(--text-muted)]">{line.object}</span>
      </button>
      {files.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5 pt-0.5 pb-2" data-testid="explored-files">
          {files.slice(0, CHIPS_SHOWN).map((path) => (
            <FileChip key={path} path={path} />
          ))}
          {files.length > CHIPS_SHOWN ? (
            <span className="self-center pl-0.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
              +{files.length - CHIPS_SHOWN} 个
            </span>
          ) : null}
        </div>
      )}
      {open ? (
        <div className="pb-1">
          {steps.map((step) => (
            <StepRow key={step.id} turnId={turnId} step={step} live={live && step.status === "running"} place={ALONE} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row of a turn's process on the rail.
 *
 * @remarks
 * Dispatches between a single step and an explore group.
 *
 * @sideEffects none
 * @param props - The row's turn, the row, which steps are going on now, and its place.
 * @returns The row.
 */
export function ProcessRowView({
  turnId,
  row,
  isLive,
  place = ALONE,
  lanes,
}: {
  readonly turnId: string;
  readonly row: ProcessRow;
  readonly isLive: (step: Step) => boolean;
  readonly place?: RailPlace;
  /** The row's place among the turn's lanes (SPEC-0002, "显示 · 过程轨道"). */
  readonly lanes?: LanePlace | undefined;
}) {
  if (row.kind === "explore") {
    return <ExploreRow turnId={turnId} steps={row.steps} live={row.steps.some(isLive)} place={place} lanes={lanes} />;
  }
  if (row.kind === "event") {
    const onLane = lanes !== undefined && (lanes.row.closes !== null || lanes.row.touches !== null);
    const asks = row.event.event === "question" || row.event.event === "needs_you";
    const { style, marks } = laned(lanes, asks);
    return (
      <div
        className={`relative min-w-0 pl-[30px] ${place.enter ? "atrium-step-enter" : ""}`}
        style={style}
        data-testid="step"
        data-kind="event"
        data-event={row.event.event}
        data-fold-row
      >
        <RailMarks node={onLane ? "pass" : "steer"} first={place.first} last={place.last} />
        {marks}
        <EventWords event={row.event} laned={onLane} />
      </div>
    );
  }
  return <StepRow turnId={turnId} step={row.step} live={isLive(row.step)} place={place} lanes={lanes} />;
}
