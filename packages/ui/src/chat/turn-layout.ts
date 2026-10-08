import type { Notice, Step, TranscriptItem, Turn } from "@atrium/protocol";

/** A tool step. */
export type ToolStep = Extract<Step, { kind: "tool" }>;

/** A text step. */
type TextStep = Extract<Step, { kind: "text" }>;

/** One row of a turn's process: a step, or consecutive read-only tool calls shown as one. */
export type ProcessRow =
  | { readonly kind: "step"; readonly step: Step }
  | { readonly kind: "explore"; readonly id: string; readonly steps: readonly ToolStep[] };

/** How a turn is shown: the process, then the reply below it. */
export interface TurnLayout {
  readonly process: readonly ProcessRow[];
  /** The turn's last step when it is text: what the turn answered. */
  readonly reply: TextStep | null;
}

/** Tools that only look around; several in a row are shown as one "探索" row (SPEC-0001, "显示模式"). */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/**
 * Splits a turn into its process and its reply.
 *
 * @remarks
 * Only a turn's last text is its reply, shown under the process; earlier texts are steps of the
 * process (SPEC-0001, "一轮里的文字"). The reply must be the last step: text followed by a tool
 * call is still part of the work. Two or more read-only tool calls in a row collapse into one
 * row; a single one keeps its own.
 *
 * @sideEffects none
 * @param turn - The turn.
 * @returns The process rows and the reply.
 */
export function layoutTurn(turn: Turn): TurnLayout {
  const last = turn.steps.at(-1);
  const reply = last?.kind === "text" ? last : null;
  const steps = reply === null ? turn.steps : turn.steps.slice(0, -1);
  const process: ProcessRow[] = [];
  let group: ToolStep[] = [];
  /**
   * Ends a run of read-only calls: one becomes its own row, more become a group.
   *
   * @remarks
   * See `layoutTurn`.
   *
   * @sideEffects Updates the rows being built.
   */
  const flush = (): void => {
    const [first] = group;
    if (first !== undefined && group.length === 1) process.push({ kind: "step", step: first });
    else if (first !== undefined) process.push({ kind: "explore", id: first.id, steps: group });
    group = [];
  };
  for (const step of steps) {
    if (step.kind === "tool" && EXPLORE_TOOLS.has(step.tool)) {
      group.push(step);
      continue;
    }
    flush();
    process.push({ kind: "step", step });
  }
  flush();
  return { process, reply };
}

/**
 * The steps of a turn's process, explore groups opened up.
 *
 * @remarks
 * For counting and exporting, where the grouping does not matter.
 *
 * @sideEffects none
 * @param process - The process rows.
 * @returns The steps, in order.
 */
export function processSteps(process: readonly ProcessRow[]): Step[] {
  return process.flatMap<Step>((row) => (row.kind === "step" ? [row.step] : row.steps));
}

/** What a turn's process did, for its header line. */
export interface ProcessCounts {
  readonly reads: number;
  readonly searches: number;
  readonly commands: number;
  readonly failedCommands: number;
}

/**
 * Counts what a turn's process did.
 *
 * @remarks
 * Feeds "读了 8 个文件 · 跑了 2 条命令"; failed commands are counted apart for the red mark
 * (SPEC-0001, "显示模式"). Files changed come from the turn's own `changes`.
 *
 * @sideEffects none
 * @param steps - The turn's steps.
 * @returns The counts.
 */
export function countProcess(steps: readonly Step[]): ProcessCounts {
  let reads = 0;
  let searches = 0;
  let commands = 0;
  let failedCommands = 0;
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    if (step.tool === "read") reads += 1;
    else if (EXPLORE_TOOLS.has(step.tool)) searches += 1;
    else if (step.tool === "bash") {
      commands += 1;
      if (step.status === "failed") failedCommands += 1;
    }
  }
  return { reads, searches, commands, failedCommands };
}

/**
 * The parts of a process header after the duration.
 *
 * @remarks
 * Only what happened is named, in a fixed order.
 *
 * @sideEffects none
 * @param counts - What the process did.
 * @param filesChanged - How many files the turn changed.
 * @returns The parts, such as "读了 2 个文件".
 */
export function processParts(counts: ProcessCounts, filesChanged: number): string[] {
  const parts: string[] = [];
  if (counts.reads > 0) parts.push(`读了 ${counts.reads} 个文件`);
  if (counts.searches > 0) parts.push(`搜索了 ${counts.searches} 次`);
  if (counts.commands > 0) parts.push(`跑了 ${counts.commands} 条命令`);
  if (filesChanged > 0) parts.push(`改了 ${filesChanged} 个文件`);
  return parts;
}

/**
 * Formats how long something took, in words.
 *
 * @remarks
 * "用时 2 分 13 秒" (SPEC-0001, "过程的呈现"); under a second reads as such rather than "0 秒".
 *
 * @sideEffects none
 * @param ms - Milliseconds.
 * @returns The duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "不到 1 秒";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * Formats a token count compactly.
 *
 * @remarks
 * "用量 18K tok", "1.3M" (SPEC-0001, "消息下方的信息").
 *
 * @sideEffects none
 * @param tokens - The count.
 * @returns The count, shortened.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${trimmed(tokens / 1000)}K`;
  return `${trimmed(tokens / 1_000_000)}M`;
}

/**
 * Rounds to one decimal, dropping a trailing ".0" and keeping big numbers whole.
 *
 * @remarks
 * See `formatTokens`.
 *
 * @sideEffects none
 * @param value - The number.
 * @returns Its text.
 */
function trimmed(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

/** One line of pi's display diff. */
export interface DiffLine {
  readonly kind: "add" | "del" | "context" | "gap";
  /** The line number in the file pi showed, if the line has one. */
  readonly number: number | null;
  readonly text: string;
}

/**
 * Reads pi's display diff for showing with line numbers and bars.
 *
 * @remarks
 * pi writes `+NN text`, `-NN text` and ` NN text`, the number padded to a common width, and
 * ` ...` for skipped lines (pi 1.0.2, `edit-diff.js`). A line in no known form is shown as context
 * without a number rather than dropped.
 *
 * @sideEffects none
 * @param diff - The display diff.
 * @returns Its lines.
 */
export function parseDisplayDiff(diff: string): DiffLine[] {
  return diff.split("\n").map((line) => {
    const rest = line.slice(1);
    if (/^\s*\.\.\.$/.test(rest)) return { kind: "gap", number: null, text: "…" };
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context";
    const match = /^\s*(\d+) (.*)$/s.exec(rest);
    if (match === null) return { kind, number: null, text: rest };
    return { kind, number: Number(match[1]), text: match[2] ?? "" };
  });
}

/**
 * The first sentence of a text, short enough for one row.
 *
 * @remarks
 * A folded thinking or text step shows how it began (SPEC-0001, "过程的呈现").
 *
 * @sideEffects none
 * @param text - The text.
 * @param max - The most characters to keep.
 * @returns The opening, with "…" when cut.
 */
export function opening(text: string, max = 48): string {
  const trimmedText = text.trim();
  const end = trimmedText.search(/[。．.!！?？\n]/);
  const sentence = end === -1 ? trimmedText : trimmedText.slice(0, end);
  if (sentence.length > max) return `${sentence.slice(0, max)}…`;
  const more = end !== -1 && trimmedText.slice(end + 1).trim() !== "";
  return more ? `${sentence}…` : sentence;
}

/** A step as one line of words: what was done, to what, and how it ended. */
export interface StepLine {
  readonly verb: string;
  readonly object: string;
  readonly end: string | null;
}

/**
 * Describes a step in one line.
 *
 * @remarks
 * "图标 + 动词 · 对象" (SPEC-0001, "过程的呈现"); the same words go into the Markdown export.
 * A thinking step timed live says how long it took; one from history cannot (SPEC-0001, "当场
 * 计时的数据"). Other tools show their name and arguments.
 *
 * @sideEffects none
 * @param step - The step.
 * @param live - Whether the step is still going on.
 * @returns The line.
 */
export function describeStep(step: Step, live: boolean): StepLine {
  if (step.kind === "thinking") {
    const timed =
      step.durationMs === null ? "思考过程" : `思考了 ${Math.max(1, Math.round(step.durationMs / 1000))} 秒`;
    return { verb: live ? "思考中" : timed, object: opening(step.text), end: null };
  }
  if (step.kind === "text") return { verb: "说明", object: opening(step.text), end: null };
  if (step.kind === "steer") return { verb: "插话已送达", object: step.text, end: null };
  if (step.kind === "retry") return { verb: `自动重试 · 第 ${step.attempt} 次`, object: step.error, end: null };
  return describeTool(step);
}

/** How a tool step ended, in words. */
const TOOL_ENDS: Readonly<Record<ToolStep["status"], string>> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  unfinished: "未完成",
};

/**
 * Describes a tool step in one line.
 *
 * @remarks
 * See `describeStep`. A command that succeeded "通过"; an edit shows its line counts.
 *
 * @sideEffects none
 * @param step - The tool step.
 * @returns The line.
 */
function describeTool(step: ToolStep): StepLine {
  const details = step.details;
  const end = TOOL_ENDS[step.status];
  if (details?.tool === "bash")
    return { verb: "运行", object: details.command, end: step.status === "done" ? "通过" : end };
  if (details?.tool === "read") {
    const range = details.offset === null ? "" : ` 第 ${details.offset} 行起`;
    return { verb: "读取", object: `${details.path}${range}`, end: step.status === "done" ? null : end };
  }
  if (details?.tool === "edit") {
    const counts = details.diff === null ? null : `+${details.added} −${details.removed}`;
    return { verb: "编辑", object: details.path, end: step.status === "done" ? counts : end };
  }
  if (details?.tool === "write")
    return { verb: "写入", object: details.path, end: step.status === "done" ? null : end };
  return { verb: step.tool, object: compactJson(step.args), end: step.status === "done" ? null : end };
}

/**
 * A tool's arguments on one line.
 *
 * @remarks
 * Tools Atrium does not know show their raw arguments.
 *
 * @sideEffects none
 * @param args - The arguments.
 * @returns At most 80 characters of JSON.
 */
function compactJson(args: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(args);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Renders a transcript as Markdown, for "导出为 Markdown".
 *
 * @remarks
 * Each turn: the question as a quote, its process as one line per step, then the reply as it
 * was written; notices as a quoted line. Steps use the same words as on screen.
 *
 * @sideEffects none
 * @param items - The whole transcript.
 * @returns The Markdown.
 */
export function transcriptMarkdown(items: readonly TranscriptItem[]): string {
  return `${items.map((item) => (item.kind === "turn" ? turnMarkdown(item) : noticeMarkdown(item))).join("\n\n---\n\n")}\n`;
}

/**
 * Renders one turn as Markdown.
 *
 * @remarks
 * See `transcriptMarkdown`.
 *
 * @sideEffects none
 * @param turn - The turn.
 * @returns The Markdown.
 */
function turnMarkdown(turn: Turn): string {
  const { process, reply } = layoutTurn(turn);
  const question = turn.user.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const lines = processSteps(process).map((step) => {
    const line = describeStep(step, false);
    return `- ${line.verb} · ${line.object}${line.end === null ? "" : `（${line.end}）`}`;
  });
  const parts = [question];
  if (lines.length > 0) parts.push(lines.join("\n"));
  if (reply !== null) parts.push(reply.text);
  if (turn.error !== null) parts.push(`> 出错：${turn.error}`);
  return parts.join("\n\n");
}

/**
 * Renders a notice as Markdown.
 *
 * @remarks
 * See `transcriptMarkdown`.
 *
 * @sideEffects none
 * @param notice - The notice.
 * @returns The Markdown.
 */
function noticeMarkdown(notice: Notice): string {
  return `> 上下文已压缩 · 压缩前 ${formatTokens(notice.tokensBefore)} tokens`;
}
