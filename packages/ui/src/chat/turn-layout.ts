import type { AgentNoticeEvent, Notice, Step, TranscriptItem, Turn } from "@atrium/protocol";
import { AGENT_TOOL_VERBS, agentToolObject, eventLine, sourceLine } from "./agent-words";
import { typedMessage } from "./composer-text";

/** A tool step. */
export type ToolStep = Extract<Step, { kind: "tool" }>;

/** A text step. */
type TextStep = Extract<Step, { kind: "text" }>;

/** A compaction step. */
type CompactionStep = Extract<Step, { kind: "compaction" }>;

/**
 * One row of a turn's process: a step, consecutive read-only tool calls shown as one, or what a
 * child came to, as a wait brought it back or a notice came in (SPEC-0002, "显示 · 过程轨道").
 */
export type ProcessRow =
  | { readonly kind: "step"; readonly step: Step }
  | { readonly kind: "explore"; readonly id: string; readonly steps: readonly ToolStep[] }
  | { readonly kind: "event"; readonly id: string; readonly event: AgentNoticeEvent };

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
    const [first, ...rest] = group;
    group = [];
    if (first === undefined) return;
    process.push(
      rest.length === 0 ? { kind: "step", step: first } : { kind: "explore", id: first.id, steps: [first, ...rest] },
    );
  };
  for (const step of steps) {
    // Stryker disable next-line ConditionalExpression: a step that is not a tool has no `tool`, which the set does not hold.
    if (step.kind === "tool" && EXPLORE_TOOLS.has(step.tool)) {
      group.push(step);
      continue;
    }
    flush();
    // Notices that came in are their events, each its own row.
    if (step.kind !== "agent" || step.source.kind !== "report") process.push({ kind: "step", step });
    // A wait's events, and notices', each merge or touch a lane (SPEC-0002, "显示 · 过程轨道").
    const events =
      step.kind === "agent" && step.source.kind === "report"
        ? step.source.events
        : // Stryker disable next-line ConditionalExpression: only tool steps have details.
          step.kind === "tool" && step.details?.tool === "agent"
          ? step.details.events
          : [];
    events.forEach((event, index) => process.push({ kind: "event", id: `${step.id}:${String(index)}`, event }));
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
  return process.flatMap<Step>((row) => (row.kind === "step" ? [row.step] : row.kind === "explore" ? row.steps : []));
}

/** The events after which a child's task has no more to say: its lane merges back. */
const FINAL_EVENTS: ReadonlySet<string> = new Set(["finished", "failed", "stopped", "ended"]);

/** One row's part of the lanes (SPEC-0002, "显示 · 过程轨道"). */
export interface LaneRow {
  /** The lanes running past the row, from above. */
  readonly through: readonly number[];
  /** The lane the row opens: a child it started. */
  readonly opens: number | null;
  /** The lane that merges back at the row: its child's task ended. */
  readonly closes: number | null;
  /** The lane the row touches without ending it: its child asks. */
  readonly touches: number | null;
  /** The row's lanes whose task goes on after the turn, drawn dashed. */
  readonly goesOn: readonly number[];
  /** For the row that opens a lane, how long its task took, once it ended in the turn. */
  readonly took: number | null;
}

/** A turn's lanes: how many, and each row's part. */
export interface LaneLayout {
  readonly width: number;
  readonly rows: readonly LaneRow[];
}

/**
 * Lays out the lanes of a turn's children (SPEC-0002, "显示 · 过程轨道"; prototype A).
 *
 * @remarks
 * Each child `agent_spawn` started takes the leftmost free lane, from its row down; an event of
 * its task merges the lane back when it ends the task, or touches it when the child asks. A lane
 * freed takes the next child, so what is dashed, a task going on past the turn, is told for each
 * child's stretch of the lane, not for the lane. Events of tasks started in another turn have no
 * lane here. The row that opens a lane knows how long its task took once it ended in the turn.
 *
 * @sideEffects none
 * @param process - The turn's process rows.
 * @returns The lanes.
 */
export function laneLayout(process: readonly ProcessRow[]): LaneLayout {
  /** Each lane's stretch now: its task and the row that opened it; `null` when free. */
  const lanes: ({ readonly taskId: string; readonly stretch: number } | null)[] = [];
  /** The stretches that end in the turn, with how long their task took. */
  const ended = new Map<number, number | null>();
  let stretches = 0;
  const laid = process.map((row) => {
    const held = lanes.flatMap((taken, lane) => (taken === null ? [] : [[lane, taken.stretch] as const]));
    const through = held.map(([lane]) => lane);
    const base = { through, held, opens: null, closes: null, touches: null, stretch: null };
    // Stryker disable next-line ConditionalExpression: other rows have no step, which reads as no child either way.
    const step = row.kind === "step" ? row.step : null;
    const spawned = step?.kind === "tool" && step.details?.tool === "agent" ? step.details.spawned : null;
    if (spawned !== null) {
      const free = lanes.indexOf(null);
      const lane = free === -1 ? lanes.length : free;
      // Stryker disable next-line UpdateOperator: a stretch's number only tells it from the others, and counting down does too.
      const stretch = stretches++;
      lanes[lane] = { taskId: spawned.taskId, stretch };
      return { ...base, held: [...held, [lane, stretch] as const], opens: lane, stretch };
    }
    if (row.kind !== "event") return base;
    const lane = lanes.findIndex((taken) => taken?.taskId === row.event.taskId);
    const taken = lanes[lane];
    if (taken == null) return base;
    if (!FINAL_EVENTS.has(row.event.event)) return { ...base, touches: lane };
    lanes[lane] = null;
    ended.set(taken.stretch, row.event.elapsedMs);
    return { ...base, closes: lane };
  });
  const rows = laid.map(({ through, held, opens, closes, touches, stretch }): LaneRow => ({
    through,
    opens,
    closes,
    touches,
    goesOn: held.flatMap(([lane, of]) => (ended.has(of) ? [] : [lane])),
    // Stryker disable next-line ConditionalExpression: only stretches are keys of `ended`, so a row without one finds nothing in it either way.
    took: stretch === null ? null : (ended.get(stretch) ?? null),
  }));
  return { width: lanes.length, rows };
}

/** What a turn's process did, for its header line. */
export interface ProcessCounts {
  readonly reads: number;
  readonly searches: number;
  readonly commands: number;
  readonly failedCommands: number;
  readonly compactions: number;
}

/**
 * Counts what a turn's process did.
 *
 * @remarks
 * Feeds "读了 8 个文件 · 跑了 2 条命令"; failed commands are counted apart (SPEC-0001, "显示模式"),
 * and so are compactions (SPEC-0001, "系统事件"). Files changed come from the turn's own `changes`.
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
  let compactions = 0;
  for (const step of steps) {
    if (step.kind === "compaction") compactions += 1;
    // Stryker disable next-line ConditionalExpression: a step that is not a tool has no `tool`, so no count below takes it.
    if (step.kind !== "tool") continue;
    if (step.tool === "read") reads += 1;
    else if (EXPLORE_TOOLS.has(step.tool)) searches += 1;
    else if (step.tool === "bash") {
      commands += 1;
      if (step.status === "failed") failedCommands += 1;
    }
  }
  return { reads, searches, commands, failedCommands, compactions };
}

/**
 * The parts of a process header after the duration.
 *
 * @remarks
 * Only what happened is named, in a fixed order. A failed command is mentioned in grey,
 * "N 条命令没走通": the agent often recovers, so red is too loud (SPEC-0001, "过程的呈现");
 * compactions come last, "压缩了 N 次上下文" (design-language, "压缩步骤", 甲).
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
  if (counts.failedCommands > 0) parts.push(`${counts.failedCommands} 条命令没走通`);
  if (counts.compactions > 0) parts.push(`压缩了 ${counts.compactions} 次上下文`);
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
  // Stryker disable next-line EqualityOperator: at exactly 100 both ways give "100".
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
    const match = /^\s*(\d+) (.*)/s.exec(rest);
    if (match === null) return { kind, number: null, text: rest };
    // Stryker disable next-line StringLiteral: both groups always match when the expression does.
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
  // The text is trimmed, so anything after the sentence's end is more text.
  const more = end !== -1 && trimmedText.slice(end + 1) !== "";
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
  if (step.kind === "steer") return { verb: "你插话", object: step.text, end: null };
  if (step.kind === "agent") return { verb: sourceLine(step.source), object: "", end: null };
  if (step.kind === "retry") {
    const limit = step.maxAttempts === null ? "" : ` / ${step.maxAttempts}`;
    return { verb: `自动重试 · 第 ${step.attempt}${limit} 次`, object: step.error, end: null };
  }
  if (step.kind === "compaction") return describeCompaction(step);
  return describeTool(step);
}

/**
 * Describes a compaction in one line: "压缩了上下文 · 152K → 41K".
 *
 * @remarks
 * Before the next reply says the context after it, only the one before: "· 压缩前 152K". One an
 * overflow set off says what pi does about it, "上下文超出窗口，已压缩", its numbers in the
 * detail (SPEC-0001, "系统事件").
 *
 * @sideEffects none
 * @param step - The compaction.
 * @returns The line.
 */
function describeCompaction(step: CompactionStep): StepLine {
  if (step.reason === "overflow") return { verb: "上下文超出窗口，已压缩", object: "", end: null };
  const before = formatTokens(step.tokensBefore);
  const object = step.tokensAfter === null ? `压缩前 ${before}` : `${before} → ${formatTokens(step.tokensAfter)}`;
  return { verb: "压缩了上下文", object, end: null };
}

/**
 * The line atop a compaction's detail: "压缩前 152K tokens · 压缩后 41K · 保留了最近的原文".
 *
 * @remarks
 * design-language, "压缩步骤"; the context after is left out until the next reply says it.
 *
 * @sideEffects none
 * @param step - The compaction.
 * @returns The line.
 */
export function compactionDetail(step: CompactionStep): string {
  const after = step.tokensAfter === null ? "" : ` · 压缩后 ${formatTokens(step.tokensAfter)}`;
  return `压缩前 ${formatTokens(step.tokensBefore)} tokens${after} · 保留了最近的原文`;
}

/**
 * A compaction between turns, in words: "上下文已压缩 · 152K → 41K".
 *
 * @remarks
 * "上下文已压缩 · 压缩前 152K tokens" while the context after is not known (SPEC-0001, "提示条").
 *
 * @sideEffects none
 * @param notice - The notice.
 * @returns The line.
 */
export function compactedText(notice: Extract<Notice, { notice: "compacted" }>): string {
  const before = formatTokens(notice.tokensBefore);
  return notice.tokensAfter === null
    ? `上下文已压缩 · 压缩前 ${before} tokens`
    : `上下文已压缩 · ${before} → ${formatTokens(notice.tokensAfter)}`;
}

/** How a tool step ended, in words. */
const TOOL_ENDS: Readonly<Record<Exclude<ToolStep["status"], "done" | "running">, string>> = {
  failed: "失败",
  unfinished: "未完成",
};

/** The verbs of the tools Atrium knows: while the call runs, and once it ended (SPEC-0001, "显示模式"). */
const TOOL_VERBS: Readonly<Record<"bash" | "read" | "edit" | "write", readonly [string, string]>> = {
  bash: ["正在运行", "运行了"],
  read: ["正在读", "读了"],
  edit: ["正在编辑", "编辑了"],
  write: ["正在写入", "写入了"],
};

/**
 * Describes a tool step in one line.
 *
 * @remarks
 * See `describeStep`. The verb says "正在…" while the call runs and turns past once it ended
 * (SPEC-0001, "过程的呈现"); a running call needs no end, its verb says so. A command that
 * succeeded "通过"; an edit shows its line counts.
 *
 * @sideEffects none
 * @param step - The tool step.
 * @returns The line.
 */
function describeTool(step: ToolStep): StepLine {
  const details = step.details;
  const done = step.status === "done";
  const end = step.status === "done" || step.status === "running" ? null : TOOL_ENDS[step.status];
  const agentVerbs = AGENT_TOOL_VERBS[step.tool];
  if (agentVerbs !== undefined) {
    return { verb: agentVerbs[step.status === "running" ? 0 : 1], object: agentToolObject(step.tool, step.args), end };
  }
  const verb =
    details === null || details.tool === "agent"
      ? step.tool
      : TOOL_VERBS[details.tool][step.status === "running" ? 0 : 1];
  if (details?.tool === "bash") return { verb, object: details.command, end: done ? "通过" : end };
  if (details?.tool === "read") {
    const range = details.offset === null ? "" : ` 第 ${details.offset} 行起`;
    return { verb, object: `${details.path}${range}`, end };
  }
  if (details?.tool === "edit") {
    const counts = details.diff === null ? null : `+${details.added} −${details.removed}`;
    return { verb, object: details.path, end: done ? counts : end };
  }
  if (details?.tool === "write") return { verb, object: details.path, end };
  return { verb, object: compactJson(step.args), end };
}

/**
 * Describes consecutive read-only calls as one line: "探索了代码库 · 读了 7 个文件，搜索了 2 次".
 *
 * @remarks
 * "正在探索代码库" while any of them runs (SPEC-0001, "显示模式").
 *
 * @sideEffects none
 * @param steps - The calls.
 * @param live - Whether any of them is going on.
 * @returns The line, without an end.
 */
export function describeExplore(steps: readonly ToolStep[], live: boolean): StepLine {
  const reads = steps.filter((step) => step.tool === "read").length;
  const searches = steps.length - reads;
  const object = [reads > 0 ? `读了 ${reads} 个文件` : null, searches > 0 ? `搜索了 ${searches} 次` : null]
    .filter((part) => part !== null)
    .join("，");
  return { verb: live ? "正在探索代码库" : "探索了代码库", object, end: null };
}

/**
 * The files some read-only calls read, each once, in the order first read.
 *
 * @remarks
 * For the file chips under an explore row (SPEC-0001, "显示模式").
 *
 * @sideEffects none
 * @param steps - The calls.
 * @returns The paths.
 */
export function exploredFiles(steps: readonly ToolStep[]): string[] {
  const paths = steps.flatMap((step) => (step.details?.tool === "read" ? [step.details.path] : []));
  return [...new Set(paths)];
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
 * Each turn: the question as a quote, its process as one line per step, a compaction a quoted line
 * (design-language, "压缩步骤"), then the reply as it was written; notices as a quoted line. Steps
 * use the same words as on screen.
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
  // A turn notices or a task opened says where it came from; a task's text follows it (SPEC-0002).
  const opened =
    turn.source === null
      ? typedMessage(turn.user)
      : [sourceLine(turn.source), ...(turn.source.kind === "task" ? [turn.source.text] : [])].join("\n");
  const question = opened
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  // What children came to shows where it came in, a line each (SPEC-0002, "显示 · 过程轨道").
  const lines = process.flatMap((row) =>
    row.kind === "event"
      ? [`- ${eventLine(row.event)}`]
      : (row.kind === "step" ? [row.step] : row.steps).map((step) => {
          const line = describeStep(step, false);
          const object = line.object === "" ? "" : ` · ${line.object}`;
          if (step.kind === "compaction") return `> ${line.verb}${object}`;
          return `- ${line.verb}${object}${line.end === null ? "" : `（${line.end}）`}`;
        }),
  );
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
  if (notice.notice === "compacted") return `> ${compactedText(notice)}`;
  return `> ${hostNoticeText(notice)}`;
}

/** How an extension's question ended, in words, when there was no answer to show. */
const UNANSWERED: Readonly<Record<"cancelled" | "timed_out" | "stale", string>> = {
  cancelled: "已取消",
  timed_out: "已超时",
  stale: "已作废（pi 已退出）",
};

/**
 * A notice of the host's own, in words: a restart, an extension's question and its result, or a note.
 *
 * @remarks
 * "进程已自动重启（第 N / 3 次）" and "问题 → 回答" (SPEC-0001, "运行控制"); a child conversation
 * forked into a new worktree says where it works now (SPEC-0002, "对话记录里的自定义消息").
 *
 * @sideEffects none
 * @param notice - The notice.
 * @returns The line.
 */
export function hostNoticeText(notice: Exclude<Notice, { notice: "compacted" }>): string {
  if (notice.notice === "restarted") return `进程已自动重启（第 ${notice.attempt} / 3 次）`;
  if (notice.notice === "note") return `在新的 worktree 里继续：${notice.to}（之前的路径属于 ${notice.from}）`;
  const result =
    notice.outcome === "answered"
      ? (notice.value ?? (notice.confirmed === true ? "是" : "否"))
      : UNANSWERED[notice.outcome];
  return `${notice.title} → ${result}`;
}
