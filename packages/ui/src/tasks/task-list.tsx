import type { AtriumClient } from "@atrium/client";
import { IDLE_CONTROL } from "@atrium/client";
import type { Control, Project, TaskSummary, Workspace } from "@atrium/protocol";
import { useEffect, useMemo, useReducer, useState } from "react";
import { type StoreApi, createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { ReviewEnvContext } from "../chat/review-env";
import { ControlCards, type RunActions } from "../chat/run-control";
import { CaretDown, CaretRight, CheckCircle, Folder, Lightning } from "../design/icons";
import { RunningDots } from "../design/running-dots";
import { workspaceName } from "../sidebar/names";
import { useClock } from "../state/clock";
import type { TaskArea } from "../state/task-area";
import { claimWatch } from "../state/watch-owner";
import { NodeStateIcon, TaskKindIcon } from "./task-icons";
import { NO_PROJECT, type TaskGroup, type TaskGroupKey, arrangeTasks } from "./task-list-model";
import { describeTaskCommandError, taskReviewEnv } from "./review-words";
import { agoWords, currentWords, statusWords } from "./task-words";

/** How the groups are headed (设计稿第 2 屏). */
const GROUP_HEADINGS: Readonly<Record<TaskGroupKey, string>> = {
  attention: "待我介入",
  running: "运行中",
  done: "已完成",
};

/** The colour each status's words take. */
const TONES = {
  attn: "text-[var(--attn-text)]",
  danger: "text-[var(--danger)]",
  run: "text-[var(--tint)]",
  dim: "text-[var(--text-dim)]",
} as const;

/**
 * The line under a task's name: its project and where it works, or "对话" for one outside any project.
 *
 * @remarks
 * 设计稿第 2 屏: "atrium · 首页首屏加载提速" is the project and the worktree's name; a task made by a schedule
 * says so; a task with a project and no worktree yet names the project alone.
 *
 * @sideEffects none
 * @param task - The row.
 * @param projects - The projects.
 * @param workspaces - The workspaces.
 * @returns The words.
 */
function placeWords(task: TaskSummary, projects: readonly Project[], workspaces: readonly Workspace[]): string {
  if (task.projectId === null) return "对话 · 不属于项目";
  const project = projects.find((one) => one.id === task.projectId)?.name ?? "项目";
  const workspace = workspaces.find((one) => one.id === task.workspaceId);
  return [project, task.scheduled ? "定时" : null, workspace === undefined ? null : workspaceName(workspace)]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * What a row opened shows: the question, the reviews, or only "打开任务" (设计稿第 2 屏).
 *
 * @remarks
 * SPEC-0006 ("界面 · 任务列表"): one row is open at a time, and it opens the task on the host (`open_task`), whose
 * pushes give what waits for you. A node's question is asked in the node's conversation, so it is watched by that
 * session and answered through `answer_question`, as in the node's tab; a review (graph change, human, archive) is
 * the same card the task conversation shows, answered through `answer_review` on the task conversation's id, which
 * the host checks as the business commands do. Only the graph change and the archive question are answered here:
 * a human node's acceptance (pass, send back, merge) is answered in the task's own tab, so the row only offers
 * "打开任务" for it, as it does for confirming the first graph (SPEC-0006, "T8 审查后用户定"). Several cards stack as
 * capsules, one open at a time, through `ControlCards` as in the task conversation. A failed node can be run again
 * here. A followed task's nodes belong to another process: its sessions are neither watched nor linked.
 *
 * @sideEffects Sends `open_task` and, for a node asking, `watch` (let go of when the row folds); the cards send their
 * answers and "重跑这个节点" sends `rerun_node`.
 * @param props - The client, the row's task, and how to open the task, a node's conversation, and the changes.
 * @returns The panel.
 */
function RowPanel({
  client,
  task,
  onOpen,
  onOpenNode,
  onOpenChanges,
}: {
  readonly client: AtriumClient;
  readonly task: TaskSummary;
  readonly onOpen: () => void;
  readonly onOpenNode: (taskId: string, node: string) => void;
  readonly onOpenChanges: (workspaceId: string) => void;
}) {
  const state = useStore(client.task(task.id));
  const view = state.task?.id === task.id ? state.task : null;
  const [failure, setFailure] = useState<string | null>(null);
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  const asking =
    view === null || view.followed
      ? null
      : (view.nodes.find((node) => node.state === "waiting" && node.waitingFor === "question") ?? null);
  const askingSession = asking?.sessionId ?? null;
  const failed = view?.nodes.find((node) => node.state === "failed") ?? null;
  useEffect(() => {
    // Fire and forget: the host's push lands in the task's state; a lost connection asks again when back.
    client.openTask(task.id).catch(() => undefined);
  }, [client, task.id]);
  useEffect(() => {
    if (askingSession === null) return undefined;
    // Fire and forget: the node's snapshot lands in its session's view, which `watch` makes; draw again to read it.
    const claim = claimWatch(client, [askingSession]);
    claim.watched.then(redraw).catch(() => undefined);
    // The row folding lets go of it, unless the page has watched something else since.
    return claim.release;
  }, [client, askingSession]);
  const env = useMemo(
    () =>
      taskReviewEnv({
        nodeName: (node) =>
          view?.nodes.find((one) => one.id === node)?.name ?? view?.pending?.nodes.find((one) => one.id === node)?.name,
        openChanges: onOpenChanges,
        showOnGraph: onOpen,
      }),
    [view, onOpenChanges, onOpen],
  );
  const asked = useStore(
    askingSession === null ? NO_SESSION : (client.session(askingSession) ?? NO_SESSION),
    (session) => session.control.question,
  );
  // What the row answers: the graph change and the archive question, not a human node's acceptance, and the node's
  // question; stacked like the task conversation's cards.
  const control: Control = {
    ...IDLE_CONTROL,
    question: askingSession === null ? null : asked,
    reviews:
      view?.reviews.filter((review) => review.source.kind !== "gate" || review.source.gate !== "task_human") ?? [],
  };
  const actions: RunActions = {
    resume: () => undefined,
    clear: () => undefined,
    update: () => undefined,
    remove: () => undefined,
    steerQueued: () => undefined,
    removeDelivery: () => undefined,
    resumeDeliveries: () => undefined,
    answer: () => undefined,
    answerQuestion: (questionId, reply) =>
      askingSession === null
        ? Promise.resolve(false)
        : client.answerQuestion(askingSession, questionId, reply).then(
            () => true,
            () => false,
          ),
    answerReview: (reviewId, verdict) =>
      view === null
        ? Promise.resolve(null)
        : client.answerReview(view.taskSessionId, reviewId, verdict).then(
            () => null,
            (error: unknown) => describeTaskCommandError(error),
          ),
    retry: () => undefined,
  };
  const open = (
    <button
      type="button"
      onClick={onOpen}
      className="atrium-press inline-flex h-7 items-center rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] text-[var(--tint)] hover:bg-[var(--hover)]"
    >
      打开任务
    </button>
  );
  if (view === null)
    return (
      <div data-testid="task-row-panel" className="flex items-center gap-2 px-9 pb-2">
        <p role="status" className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          {state.status === "failed" || state.status === "missing" ? "没能读到这个任务" : "正在读取…"}
        </p>
        {open}
      </div>
    );
  return (
    <div data-testid="task-row-panel" className="px-9 pb-2">
      <ReviewEnvContext value={env}>
        <ControlCards sessionId={view.taskSessionId} control={control} actions={actions} />
      </ReviewEnvContext>
      {asking === null || askingSession === null || asked === null ? null : (
        <button
          type="button"
          onClick={() => onOpenNode(view.id, asking.id)}
          className="mb-1 text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline"
        >
          到 {asking.id} 的对话里讨论 ›
        </button>
      )}
      {failure === null ? null : (
        <p role="alert" className="mb-1 text-[length:var(--fs-sm)] text-[var(--danger)]">
          {failure}
        </p>
      )}
      <div className="mt-1 flex items-center gap-2">
        {failed === null || view.followed ? null : (
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              // Fire and forget: the task's push shows the node running; a failure is worded below.
              client
                .rerunNode(view.id, failed.id)
                .catch((error: unknown) => setFailure(describeTaskCommandError(error)));
            }}
            className="atrium-press inline-flex h-7 items-center rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"
          >
            重跑这个节点
          </button>
        )}
        {open}
      </div>
    </div>
  );
}

/** What a row's question reads while no node is asking: a session that has nothing. */
const NO_SESSION = createStore<{ readonly control: { readonly question: null } }>(() => ({
  control: { question: null },
}));

/**
 * One row of the list, and what opens under it.
 *
 * @remarks
 * Name and place on the left, then the node the task is at, when it last did something, and what it waits for or how
 * it goes. Pressing the row opens it (one at a time, SPEC-0006 "界面 · 任务列表") and a second press folds it; the
 * way into the task is "打开任务" inside. A finished task is dimmer.
 *
 * @sideEffects none; the callbacks are the caller's.
 * @param props - The task, the place line, the time now, whether it is open, and what to do.
 * @returns The row.
 */
function TaskRow({
  client,
  task,
  place,
  now,
  expanded,
  onToggle,
  onOpen,
  onOpenNode,
  onOpenChanges,
}: {
  readonly client: AtriumClient;
  readonly task: TaskSummary;
  readonly place: string;
  readonly now: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
  readonly onOpenNode: (taskId: string, node: string) => void;
  readonly onOpenChanges: (workspaceId: string) => void;
}) {
  const status = statusWords(task);
  const done = task.status === "done" || task.status === "cancelled";
  return (
    <div data-testid="task-entry" data-expanded={expanded}>
      <button
        type="button"
        data-testid="task-row"
        data-task={task.id}
        data-status={task.status}
        data-attention={task.attention ?? ""}
        aria-expanded={expanded}
        onClick={onToggle}
        className={`group grid w-full grid-cols-[20px_minmax(0,1fr)_minmax(0,150px)_84px_minmax(0,170px)_24px] items-center gap-x-3 rounded-[var(--r-md)] px-2.5 py-2 text-left hover:bg-[var(--hover)] ${expanded ? "bg-[var(--hover)]" : ""} ${done ? "text-[var(--text-dim)]" : ""}`}
      >
        <TaskKindIcon scheduled={task.scheduled} />
        <span className="min-w-0">
          <span className={`block truncate text-[length:var(--fs-meta)] ${done ? "" : "text-[var(--text)]"}`}>
            {task.name}
          </span>
          <span className="block truncate text-[length:var(--fs-sm)] text-[var(--text-dim)]">{place}</span>
        </span>
        <span className="truncate text-[length:var(--fs-meta)] text-[var(--text-muted)]">{currentWords(task)}</span>
        <span className="text-right text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
          {agoWords(task.activeAt, now)}
        </span>
        <span className={`flex min-w-0 items-center gap-1.5 text-[length:var(--fs-meta)] ${TONES[status.tone]}`}>
          {status.tone === "run" ? (
            <span className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--tint)]">
              <RunningDots size={14} />
            </span>
          ) : null}
          {status.tone === "attn" ? <NodeStateIcon state="waiting" size={14} /> : null}
          {status.tone === "danger" ? <NodeStateIcon state="failed" size={14} /> : null}
          <span className="truncate" data-testid="task-status">
            {status.text}
          </span>
        </span>
        <span className="flex items-center justify-end">
          <CaretRight size={13} className={`text-[var(--text-dim)] ${expanded ? "rotate-90" : ""}`} />
        </span>
      </button>
      {expanded ? (
        <RowPanel client={client} task={task} onOpen={onOpen} onOpenNode={onOpenNode} onOpenChanges={onOpenChanges} />
      ) : null}
    </div>
  );
}

/**
 * A group's heading: what it is and how many are in it.
 *
 * @remarks
 * "待我介入 · 5" with a bolt in the attention colour, "运行中 · 3" with the dot matrix, "已完成 · 2" with a grey check.
 *
 * @sideEffects none
 * @param props - The group.
 * @returns The heading.
 */
function GroupHeading({ group }: { readonly group: TaskGroup }) {
  const count = group.tasks.length + group.hidden;
  return (
    <h3 className="flex items-center gap-1.5 px-2.5 pt-3 pb-1 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
      {group.key === "attention" ? <Lightning size={12} className="text-[var(--attn)]" /> : null}
      {group.key === "running" ? <RunningDots size={12} /> : null}
      {group.key === "done" ? <CheckCircle size={12} className="text-[var(--text-dim)]" /> : null}
      {GROUP_HEADINGS[group.key]} · {count}
    </h3>
  );
}

/**
 * The task list: the first of the task area's fixed tabs (SPEC-0006, "界面 · 任务列表"; 设计稿第 2 屏).
 *
 * @remarks
 * Rows come from `list_tasks({ watch: true })` and its pushes, ordered attention → running → done; the done group
 * shows the last seven days and at most five until "显示全部". The project filter at the top right lists every project
 * and "不属于项目". Read-only in T7: a row opens the task. The times are written as of the minute, refreshed every
 * half minute.
 *
 * @sideEffects Subscribes to the client's task list and index and the area's state; refreshes every 30 seconds.
 * @param props - The client, the task area's state, and what opening a task does.
 * @returns The list.
 */
export function TaskList({
  client,
  area,
  onOpen,
  onOpenChanges,
}: {
  readonly client: AtriumClient;
  readonly area: StoreApi<TaskArea>;
  readonly onOpen: (taskId: string) => void;
  readonly onOpenChanges: (workspaceId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const tasks = useStore(client.tasks);
  const index = useStore(client.index);
  const filter = useStore(area, (state) => state.filter);
  const showAll = useStore(area, (state) => state.showAll);
  const clock = useClock();
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => clock.every(30_000, refresh), [clock]);
  const now = clock.now();
  const { groups, total } = arrangeTasks(tasks.tasks, { filter, now, showAll });
  const filterName =
    filter === null
      ? "全部"
      : filter === NO_PROJECT
        ? "不属于项目"
        : (index.projects.find((project) => project.id === filter)?.name ?? "全部");
  return (
    <section aria-label="任务列表" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-6 py-6">
        <div className="flex items-center gap-3 px-2.5">
          <h2 className="text-[length:var(--fs)] font-semibold text-[var(--text)]">任务</h2>
          <span className="rounded-[var(--r-pill)] bg-[var(--surface-2)] px-2 text-[length:var(--fs-sm)] leading-[20px] text-[var(--text-muted)] tabular-nums">
            {total}
          </span>
          <MenuButton
            label="按项目筛选"
            align="start"
            content={
              <>
                <Folder size={13} />
                {filterName}
                <CaretDown size={10} />
              </>
            }
          >
            {(close) => (
              <div className="max-h-80 w-56 overflow-y-auto">
                {[
                  { value: null, name: "全部" },
                  ...index.projects.map((project) => ({ value: project.id, name: project.name })),
                  { value: NO_PROJECT, name: "不属于项目" },
                ].map((choice) => (
                  <button
                    key={choice.value ?? "all"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={filter === choice.value}
                    className={`${MENU_ITEM} aria-checked:text-[var(--tint)]`}
                    onClick={() => {
                      close();
                      area.getState().setFilter(choice.value);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                  </button>
                ))}
              </div>
            )}
          </MenuButton>
          <span className="flex-1" />
          <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">
            在对话里输入 <code className="font-[family-name:var(--font-mono)] text-[var(--tint)]">/task</code> 创建任务
          </span>
        </div>
        <div
          data-testid="task-card"
          className="mt-3 rounded-[var(--r-card)] bg-[var(--surface-1)] px-2 pb-2 shadow-[var(--card-shadow)]"
        >
          {tasks.status !== "ready" ? (
            <p role="status" className="px-2.5 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
              正在读取任务…
            </p>
          ) : total === 0 ? (
            <p role="status" className="px-2.5 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
              {filter === null ? "还没有任务。" : "这个范围里没有任务。"}
              在对话里说清要做什么，再输入 /task 就会生成任务。
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.key} data-testid="task-group" data-group={group.key}>
                <GroupHeading group={group} />
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    client={client}
                    task={task}
                    place={placeWords(task, index.projects, index.workspaces)}
                    now={now}
                    expanded={expanded === task.id}
                    onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
                    onOpen={() => onOpen(task.id)}
                    onOpenNode={(taskId, node) => area.getState().openNode(taskId, node)}
                    onOpenChanges={onOpenChanges}
                  />
                ))}
                {group.key === "done" && group.foldable > 0 ? (
                  <button
                    type="button"
                    onClick={() => area.getState().setShowAll(!showAll)}
                    className="mt-0.5 flex h-[30px] w-full items-center rounded-[var(--r)] px-2.5 text-left text-[length:var(--fs-meta)] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
                  >
                    {showAll ? "收起" : `显示全部 ${group.tasks.length + group.hidden} 个`}
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
