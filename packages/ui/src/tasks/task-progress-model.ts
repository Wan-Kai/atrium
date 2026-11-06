import type { Notice, TranscriptItem } from "@atrium/protocol";

/** A progress line of a task conversation. */
export type ProgressNotice = Extract<Notice, { notice: "task_progress" }>;

/** The mark in the conversation a task was made from. */
export type MarkNotice = Extract<Notice, { notice: "task_mark" }>;

/** What the transcript draws: an item as it is, or a run of progress lines between two turns as one group. */
export type TranscriptRow =
  | { readonly kind: "item"; readonly item: TranscriptItem; readonly index: number }
  | {
      readonly kind: "progress";
      /** The first line's id, which keeps the group's identity as lines are added to it. */
      readonly id: string;
      readonly notices: readonly ProgressNotice[];
      /** The latest group of the conversation, the one still going on. */
      readonly last: boolean;
    };

/**
 * Arranges a conversation's items into what the transcript draws (SPEC-0006, "任务对话的进度和记录折叠").
 *
 * @remarks
 * Progress lines that follow one another, with no turn or other notice between, are one group, as a process is
 * one thing between two turns of an ordinary conversation; the last group is the one going on, which shows open
 * while the earlier ones fold. The mark of a conversation a task was made from is shown once per task: a session
 * file only grows, so "已转为任务" and a later "任务已放弃" both exist, and the latest wins. Everything else is
 * drawn as it was. Linear in the items.
 *
 * @sideEffects none
 * @param items - The conversation's items.
 * @returns The rows, each item keeping the index it had.
 */
export function arrangeRows(items: readonly TranscriptItem[]): TranscriptRow[] {
  const latestMark = new Map<string, string>();
  for (const item of items)
    if (item.kind === "notice" && item.notice === "task_mark") latestMark.set(item.taskId, item.id);
  const rows: TranscriptRow[] = [];
  let open: { id: string; notices: ProgressNotice[] } | null = null;
  items.forEach((item, index) => {
    if (item.kind === "notice" && item.notice === "task_progress") {
      if (open === null) {
        open = { id: item.id, notices: [] };
        rows.push({ kind: "progress", id: item.id, notices: open.notices, last: false });
      }
      open.notices.push(item);
      return;
    }
    open = null;
    if (item.kind === "notice" && item.notice === "task_mark" && latestMark.get(item.taskId) !== item.id) return;
    rows.push({ kind: "item", item, index });
  });
  const lastGroup = rows.findLast((row) => row.kind === "progress");
  return rows.map((row) => (row === lastGroup && row.kind === "progress" ? { ...row, last: true } : row));
}

/**
 * The time a line was written, as the transcript shows it: hours and minutes.
 *
 * @remarks
 * In the user's time zone and in 24 hours, as the conversation's own times are.
 *
 * @sideEffects none
 * @param at - Epoch milliseconds.
 * @returns "10:44".
 */
export function clockWords(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * The words of one progress line, from what the host recorded and the node's name.
 *
 * @remarks
 * `N2 核心实现与自检 开始`, `N1 调研与方案 通过`, `N3 失败`, `N4 验收合并 等你`; a line the board does not know
 * (a newer host's) reads as plain progress. `name` is the node's name in the task shown, `undefined` when the
 * conversation is shown without its task.
 *
 * @sideEffects none
 * @param notice - The line.
 * @param name - The node's name, if known.
 * @returns The words, and how the line stands out.
 */
export function progressWords(
  notice: ProgressNotice,
  name: string | undefined,
): { readonly text: string; readonly tone: "plain" | "fail" | "wait" } {
  const node = notice.node === null ? "" : name === undefined ? notice.node : `${notice.node} ${name}`;
  if (notice.what === null) return { text: node === "" ? "任务有新进展" : `${node} 有新进展`, tone: "plain" };
  switch (notice.what) {
    case "node_started":
      return { text: `${node} 开始`, tone: "plain" };
    case "node_passed":
      return { text: `${node} 通过`, tone: "plain" };
    case "node_failed":
      return { text: `${node} 失败`, tone: "fail" };
    case "node_waiting":
      return { text: `${node} 等你`, tone: "wait" };
    case "workspace_ready":
      return { text: "工作区准备好了", tone: "plain" };
    case "merged":
      return { text: "合并完成，任务完成", tone: "plain" };
    default:
      return { text: node === "" ? "任务有新进展" : `${node} 有新进展`, tone: "plain" };
  }
}

/**
 * The one grey line a folded group becomes: "任务进度 · 3 个节点通过 · 10:02–10:44".
 *
 * @remarks
 * Counts what the lines say (nodes that passed or failed, a merge), then the time the group spans, hours and
 * minutes; a group of one moment shows that time alone. Reviews' records join the line in T8.
 *
 * @sideEffects none
 * @param notices - The group's lines, in order.
 * @returns The line.
 */
export function summaryWords(notices: readonly ProgressNotice[]): string {
  const passed = notices.filter((notice) => notice.what === "node_passed").length;
  const failed = notices.filter((notice) => notice.what === "node_failed").length;
  const merged = notices.some((notice) => notice.what === "merged");
  const first = notices[0];
  const last = notices.at(-1);
  const from = first === undefined ? "" : clockWords(first.timestamp);
  const to = last === undefined ? "" : clockWords(last.timestamp);
  return [
    "任务进度",
    passed > 0 ? `${passed} 个节点通过` : null,
    failed > 0 ? `${failed} 个节点失败` : null,
    merged ? "已合并" : null,
    from === to ? from : `${from}–${to}`,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}
