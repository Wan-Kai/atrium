import type { AtriumClient } from "@atrium/client";
import type { Project, TaskSummary, Workspace } from "@atrium/protocol";
import { useReducer, useEffect } from "react";
import { type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { CaretDown, CaretRight, CheckCircle, Folder, Lightning } from "../design/icons";
import { RunningDots } from "../design/running-dots";
import { workspaceName } from "../sidebar/names";
import { useClock } from "../state/clock";
import type { TaskArea } from "../state/task-area";
import { NodeStateIcon, TaskKindIcon } from "./task-icons";
import { NO_PROJECT, type TaskGroup, type TaskGroupKey, arrangeTasks } from "./task-list-model";
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
 * One row of the list.
 *
 * @remarks
 * Name and place on the left, then the node the task is at, when it last did something, and what it waits for or how
 * it goes. Pressing it opens the task's tab. A row's answer cards (a question, a graph change) are T8's; this one only
 * shows the state and offers "打开任务". A finished task is dimmer.
 *
 * @sideEffects none; the callback opens the task.
 * @param props - The row, the place line, the time now, and what opening does.
 * @returns The row.
 */
function TaskRow({
  task,
  place,
  now,
  onOpen,
}: {
  readonly task: TaskSummary;
  readonly place: string;
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const status = statusWords(task);
  const done = task.status === "done" || task.status === "cancelled";
  return (
    <button
      type="button"
      data-testid="task-row"
      data-task={task.id}
      data-status={task.status}
      data-attention={task.attention ?? ""}
      onClick={onOpen}
      className={`group grid w-full grid-cols-[20px_minmax(0,1fr)_minmax(0,150px)_84px_minmax(0,170px)_90px] items-center gap-x-3 rounded-[var(--r-md)] px-2.5 py-2 text-left hover:bg-[var(--hover)] ${done ? "text-[var(--text-dim)]" : ""}`}
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
      <span className="flex items-center justify-end gap-0.5 text-[length:var(--fs-sm)] text-[var(--tint)]">
        <span className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">打开任务</span>
        <CaretRight size={13} className="text-[var(--text-dim)]" />
      </span>
    </button>
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
}: {
  readonly client: AtriumClient;
  readonly area: StoreApi<TaskArea>;
  readonly onOpen: (taskId: string) => void;
}) {
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
                    task={task}
                    place={placeWords(task, index.projects, index.workspaces)}
                    now={now}
                    onOpen={() => onOpen(task.id)}
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
