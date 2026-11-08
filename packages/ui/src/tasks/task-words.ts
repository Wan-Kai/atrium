import type {
  TaskFailureReason,
  TaskMergeBlockReason,
  TaskModel,
  TaskNode,
  TaskNodeState,
  TaskSummary,
  TaskWaitingFor,
} from "@atrium/protocol";

/**
 * The words of the task area (SPEC-0006, "界面"; coding-standards: the host sends codes and parameters, the UI writes
 * the words).
 *
 * @remarks
 * One place for them, so the list, the graph and the conversation say the same thing in the same way.
 */

/** What a node's state is called, in the graph's legend and under a node (设计稿第 5 屏). */
export const NODE_STATE_WORDS: Readonly<Record<TaskNodeState, string>> = {
  pending: "未开始",
  running: "运转中",
  waiting: "等你",
  passed: "通过",
  held: "已挂起",
  stopped: "你停下的",
  failed: "失败，任务停下",
};

/** Why a node failed (SPEC-0006, "失败"). */
export const FAILURE_WORDS: Readonly<Record<TaskFailureReason, string>> = {
  no_done: "没有交 node_done 就结束了",
  crashed: "进程崩溃了",
  model_error: "模型出错了",
  gave_up: "节点自己放弃了",
  workspace: "工作区没建好",
  commit: "提交没成功",
};

/** Why a merge was held back (SPEC-0006, "错误码"; 设计稿第 7 屏 35). */
export const MERGE_BLOCK_WORDS: Readonly<Record<TaskMergeBlockReason, string>> = {
  merge_worktree_dirty: "任务的 worktree 里还有没提交的改动",
  merge_main_dirty: "主目录有没提交的改动：先提交或收起来",
  merge_main_not_trunk: "主目录不在主干分支上：切回主干",
  merge_conflict: "有文件冲突",
  merge_abort_failed: "合并没能退回，主目录可能不干净，请手动检查",
  merge_git_failed: "git 出错了，没有合并，主目录没动",
};

/** What a waiting node waits for. */
export const WAITING_WORDS: Readonly<Record<TaskWaitingFor, string>> = {
  question: "等你回答",
  graph_change: "等你批准改图",
  human: "等你验收",
  merge_blocked: "合并被挡住",
};

/** The wording of the errors a task command or opening a task can fail with (SPEC-0006, "错误码"). */
const ERROR_WORDS: Readonly<Record<string, string>> = {
  task_not_found: "这个任务已经不在了",
  task_state_invalid: "任务的状态变了，刷新后再试",
  task_back_limit: "这条打回边已经用了两次",
  task_read_only: "这个任务是别的进程在跑的，Atrium 里只能看",
  task_graph_invalid: "这张图不合规则，需要先改图",
  task_already_converted: "这段对话已经转成任务了",
  task_no_project_for_work: "不属于项目的任务不能放改代码或跑命令的节点",
  merge_git_failed: "git 出错了，没有合并，主目录没动",
  review_closed: "这条审核已经处理过了",
  review_invalid: "这个裁决不合这条审核，刷新后再试",
  workspace_dirty: "任务的 worktree 里还有没提交的改动",
  session_not_found: "这个对话已经不存在了",
};

/**
 * The words for an error code a task command can fail with, if the board has some.
 *
 * @remarks
 * Lets a caller fall back to the general wording for the codes that are not about tasks.
 *
 * @sideEffects none
 * @param code - The error code.
 * @returns The sentence, or `null` for a code the board does not know.
 */
export function knownTaskError(code: string): string | null {
  return ERROR_WORDS[code] ?? null;
}

/**
 * What to tell the user about a failure of a task command.
 *
 * @remarks
 * SPEC-0006, "错误码": a code the area does not know reads as a plain failure, so a newer host's codes never show
 * as nothing.
 *
 * @sideEffects none
 * @param code - The error's code.
 * @returns The sentence.
 */
export function describeTaskError(code: string): string {
  return ERROR_WORDS[code] ?? "这个操作没能完成";
}

/**
 * How a task's status reads in its row and its bar: what it waits for, or how it goes.
 *
 * @remarks
 * Attention first (the user is wanted), then the state of the task: designing waits for the first graph's
 * confirmation; a paused task is paused whatever its nodes do; a task stopped without a failure is one whose node the
 * user stopped (SPEC-0006, "任务").
 *
 * @sideEffects none
 * @param task - The row.
 * @returns The words, and which colour they take.
 */
export function statusWords(task: TaskSummary): {
  readonly text: string;
  readonly tone: "attn" | "danger" | "run" | "dim";
} {
  const node = task.current?.id ?? "";
  if (task.status === "cancelled") return { text: "已取消", tone: "dim" };
  if (task.status === "done") return { text: "已完成", tone: "dim" };
  if (task.status === "designing") return { text: "等你确认初始图", tone: "attn" };
  if (task.paused) return { text: "已暂停", tone: "attn" };
  switch (task.attention) {
    case "failed":
      return { text: `${node} 失败 · 已停下`, tone: "danger" };
    case "merge_blocked":
      return { text: "合并被挡住", tone: "attn" };
    case "human":
      return { text: WAITING_WORDS.human, tone: "attn" };
    case "question":
      return { text: WAITING_WORDS.question, tone: "attn" };
    case "graph_change":
      return { text: WAITING_WORDS.graph_change, tone: "attn" };
    case null:
      break;
  }
  if (task.status === "stopped") return { text: `${node === "" ? "" : `${node} `}已停下`, tone: "attn" };
  return { text: "运转中", tone: "run" };
}

/**
 * What a task in the inbox says it waits for: "N2 在问", "N4 验收合并 · 等你验收".
 *
 * @remarks
 * SPEC-0006 ("界面 · 等你处理"): the inbox line is the task's name and this.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The words.
 */
export function inboxWords(task: TaskSummary): string {
  if (task.attention === "question" && task.current !== null) return `${task.current.id} 在问`;
  return statusWords(task).text;
}

/**
 * The "current node" column of a row.
 *
 * @remarks
 * `N2 实现`; a designing task has no node yet ("设计中"), a finished one reads "完成".
 *
 * @sideEffects none
 * @param task - The row.
 * @returns The words.
 */
export function currentWords(task: TaskSummary): string {
  if (task.status === "designing") return "设计中";
  if (task.status === "done") return "完成";
  if (task.status === "cancelled") return "";
  return task.current === null ? "" : `${task.current.id} ${task.current.name}`;
}

/**
 * A model as a node or the task bar shows it: the model's name, and the thinking level when one is set.
 *
 * @remarks
 * `opus-5.5 · 高`: the provider is left out, as the composer's model box does; the level is the composer's word.
 *
 * @sideEffects none
 * @param model - The model.
 * @returns The words.
 */
export function modelWords(model: TaskModel): string {
  const level = model.thinking === undefined ? null : THINKING_WORDS[model.thinking];
  return level === null || model.thinking === "off" ? model.modelId : `${model.modelId} · ${level}`;
}

/** The thinking levels in the composer's words. */
const THINKING_WORDS: Readonly<Record<NonNullable<TaskModel["thinking"]>, string>> = {
  off: "关",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
};

/**
 * How long ago something happened, in the list's words.
 *
 * @remarks
 * "刚刚", "4 分钟前", "6 小时前", "昨天", "N 天前" (设计稿第 2 屏).
 *
 * @sideEffects none
 * @param at - When, in epoch milliseconds.
 * @param now - The time now.
 * @returns The words.
 */
export function agoWords(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "昨天" : `${days} 天前`;
}

/**
 * A node's second line: its role and where it works (设计稿第 4 屏: "work · 任务 worktree").
 *
 * @remarks
 * The role as the graph guides name it; the place as the user knows it. A human node has neither: "由你来做".
 *
 * @sideEffects none
 * @param node - The node.
 * @returns The words.
 */
export function roleWords(node: TaskNode): string {
  if (node.kind === "human") return "由你来做";
  const place = node.place === "readonly" ? "只读" : "任务 worktree";
  return `${node.role ?? "work"} · ${place}`;
}
