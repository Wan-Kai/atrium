import type { Step } from "@atrium/protocol";
import {
  ArrowBendDownRight,
  ArrowClockwise,
  Brain,
  ChatText,
  Check,
  CircleNotch,
  FilePlus,
  FileText,
  MagnifyingGlass,
  PencilSimple,
  Terminal,
  Wrench,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { type DisplayMode, useDisplayMode } from "../state/display-mode";
import { Markdown } from "./markdown";
import { type ProcessRow, type ToolStep, describeStep, parseDisplayDiff } from "./turn-layout";
import { useRevealedText } from "./use-revealed-text";

/**
 * A step's icon.
 *
 * @remarks
 * Each kind of step has its own glyph; a step in progress spins (design-language, "图标").
 *
 * @sideEffects none
 * @param props - The step and whether it is in progress.
 * @returns The icon.
 */
function StepIcon({ step, live }: { readonly step: Step; readonly live: boolean }) {
  if (live) return <CircleNotch size={15} className="animate-spin text-[var(--tint)]" />;
  if (step.kind === "thinking") return <Brain size={15} />;
  if (step.kind === "text") return <ChatText size={15} />;
  if (step.kind === "steer") return <ArrowBendDownRight size={15} />;
  if (step.kind === "retry") return <ArrowClockwise size={15} />;
  if (step.tool === "bash") return <Terminal size={15} />;
  if (step.tool === "read") return <FileText size={15} />;
  if (step.tool === "edit") return <PencilSimple size={15} />;
  if (step.tool === "write") return <FilePlus size={15} />;
  if (step.tool === "grep" || step.tool === "find" || step.tool === "ls") return <MagnifyingGlass size={15} />;
  return <Wrench size={15} />;
}

/**
 * Whether a step starts out open in a display mode.
 *
 * @remarks
 * Detailed opens every step; thinking opens thinking (SPEC-0001, "显示模式").
 *
 * @sideEffects none
 * @param mode - The display mode.
 * @param step - The step.
 * @returns Whether it is open.
 */
function openByDefault(mode: DisplayMode, step: Step): boolean {
  return mode === "detailed" || (mode === "thinking" && step.kind === "thinking");
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

/**
 * What a tool step shows when open.
 *
 * @remarks
 * A command's output; an edit's diff; what a write wrote; a read's text; for other tools their
 * arguments and output. Cut output says which end was kept (SPEC-0001, `output`).
 *
 * @sideEffects none
 * @param props - The step.
 * @returns The detail block.
 */
function ToolDetail({ step }: { readonly step: ToolStep }) {
  const cut =
    step.output?.truncated === true ? (
      <p className="mt-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
        {step.tool === "bash" ? "只保留了最后 16 KB" : "只保留了前 16 KB"}
      </p>
    ) : null;
  const details = step.details;
  if (details?.tool === "edit" && details.diff !== null) {
    return (
      <Detail label="改动" tool="edit">
        <DiffBlock diff={details.diff} />
      </Detail>
    );
  }
  if (details?.tool === "write") {
    return (
      <Detail label="写入" tool="write">
        <Output text={details.content} />
      </Detail>
    );
  }
  const output = step.output === null ? null : <Output text={step.output.text} />;
  if (details !== null) {
    return (
      <Detail label={step.status === "failed" ? "出错" : "输出"} tool={step.tool}>
        {output ?? <p className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">还没有输出</p>}
        {cut}
      </Detail>
    );
  }
  return (
    <Detail label="参数" tool={step.tool}>
      <Output text={JSON.stringify(step.args, null, 2)} />
      {output === null ? null : <div className="mt-2">{output}</div>}
      {cut}
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

/**
 * One row of the process: "图标 + 动词 · 对象", and its detail when open.
 *
 * @remarks
 * Clicking a row opens or closes its detail (SPEC-0001, "过程的呈现"); the display mode sets
 * where it starts. While a step is going on, thinking and a running command show their detail
 * as it comes. Failed steps are red, steers in the accent colour.
 *
 * @sideEffects none
 * @param props - The step and whether it is the one going on now.
 * @returns The row.
 */
function StepRow({ step, live }: { readonly step: Step; readonly live: boolean }) {
  const { mode } = useDisplayMode();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? openByDefault(mode, step);
  const line = describeStep(step, live);
  const failed = step.kind === "tool" && step.status === "failed";
  const tone = failed
    ? "text-[var(--danger)]"
    : step.kind === "steer"
      ? "text-[var(--tint)]"
      : step.kind === "retry"
        ? "text-[var(--text-dim)]"
        : "text-[var(--text-2)]";
  let detail: ReactNode = null;
  if (step.kind === "thinking" || step.kind === "text") {
    if (open || live) {
      detail = (
        <Detail>
          <div className="text-[length:var(--fs-meta)] text-[var(--text-muted)]">
            <StreamedText text={step.text} streaming={live} />
          </div>
        </Detail>
      );
    }
  } else if (step.kind === "tool" && (open || live)) {
    detail = <ToolDetail step={step} />;
  }
  return (
    <div data-testid="step" data-kind={step.kind} data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className={`-mx-1.5 flex min-h-[30px] w-[calc(100%+12px)] items-center gap-2 rounded-[var(--r)] px-1.5 text-left text-[length:var(--fs-meta)] hover:bg-[var(--hover)] ${tone}`}
      >
        <span className={failed ? "" : step.kind === "steer" ? "" : "text-[var(--text-muted)]"}>
          <StepIcon step={step} live={live} />
        </span>
        <span className={`flex-none ${live ? "atrium-shimmer" : ""}`}>{line.verb}</span>
        {line.object === "" ? null : (
          <>
            <span className="text-[var(--text-dim)]">·</span>
            <span
              className={`min-w-0 truncate text-[var(--text-muted)] ${
                step.kind === "tool" && step.tool === "bash"
                  ? "font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)]"
                  : ""
              }`}
            >
              {line.object}
            </span>
          </>
        )}
        {line.end === null ? null : (
          <span className="ml-auto flex flex-none items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
            {line.end === "通过" ? <Check size={12} /> : null}
            {line.end}
          </span>
        )}
      </button>
      {detail}
    </div>
  );
}

/**
 * Several read-only tool calls in a row, as one row: "探索 · 读了 3 个文件，搜索了 1 次".
 *
 * @remarks
 * Opening it lists each call, each of which opens like any step (SPEC-0001, "显示模式").
 *
 * @sideEffects none
 * @param props - The calls, and whether the last of them is going on.
 * @returns The row.
 */
function ExploreRow({ steps, live }: { readonly steps: readonly ToolStep[]; readonly live: boolean }) {
  const { mode } = useDisplayMode();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? mode === "detailed";
  const reads = steps.filter((step) => step.tool === "read").length;
  const searches = steps.length - reads;
  const summary = [reads > 0 ? `读了 ${reads} 个文件` : null, searches > 0 ? `搜索了 ${searches} 次` : null]
    .filter((part) => part !== null)
    .join("，");
  return (
    <div data-testid="step" data-kind="explore" data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className="-mx-1.5 flex min-h-[30px] w-[calc(100%+12px)] items-center gap-2 rounded-[var(--r)] px-1.5 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)]"
      >
        <span className="text-[var(--text-muted)]">
          {live ? <CircleNotch size={15} className="animate-spin text-[var(--tint)]" /> : <MagnifyingGlass size={15} />}
        </span>
        <span className="flex-none">探索</span>
        <span className="text-[var(--text-dim)]">·</span>
        <span className="min-w-0 truncate text-[var(--text-muted)]">{summary}</span>
      </button>
      {open ? (
        <div className="ml-6">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} live={live && step.status === "running"} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row of a turn's process.
 *
 * @remarks
 * Dispatches between a single step and an explore group.
 *
 * @sideEffects none
 * @param props - The row and which steps are going on now.
 * @returns The row.
 */
export function ProcessRowView({
  row,
  isLive,
}: {
  readonly row: ProcessRow;
  readonly isLive: (step: Step) => boolean;
}) {
  if (row.kind === "explore") return <ExploreRow steps={row.steps} live={row.steps.some(isLive)} />;
  return <StepRow step={row.step} live={isLive(row.step)} />;
}
