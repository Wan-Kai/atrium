import type { AtriumClient } from "@atrium/client";
import type { Project, TaskView, Workspace } from "@atrium/protocol";
import { useEffect, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { type TaskLinks, TaskLinksContext } from "../chat/task-links";
import { workspaceName } from "../sidebar/names";
import { TaskConversation } from "./task-conversation";
import { TaskGraph } from "./task-graph";
import { TaskKindIcon } from "./task-icons";
import { currentWords, describeTaskError, modelWords, statusWords } from "./task-words";

/** What a task with no workspace has for changes. */
const NO_CHANGES = createStore<null>(() => null);

/** The colour each status's words take. */
const TONES = {
  attn: "text-[var(--attn-text)]",
  danger: "text-[var(--danger)]",
  run: "text-[var(--tint)]",
  dim: "text-[var(--text-dim)]",
} as const;

/**
 * The task bar: name, status, project and worktree, the link to the conversation it was made from, and the model.
 *
 * @remarks
 * 设计稿第 4、5 屏. The model is shown, not changed: it changes by saying so in the task conversation. The buttons
 * (放弃、确认并启动、暂停、取消) are T8's and are left out rather than drawn dead. A task made by a schedule has no
 * conversation to link.
 *
 * @sideEffects none; the callback opens the source conversation.
 * @param props - The task, the places' names, and what opening the source does.
 * @returns The bar.
 */
function TaskBar({
  task,
  place,
  onOpenSource,
}: {
  readonly task: TaskView;
  readonly place: string;
  readonly onOpenSource: (sessionId: string) => void;
}) {
  const status = statusWords(task);
  return (
    <header className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 shadow-[inset_0_-0.5px_0_var(--line)]">
      <TaskKindIcon scheduled={task.scheduled} size={15} />
      <h1
        className="min-w-0 max-w-[420px] truncate text-[length:var(--fs)] font-semibold text-[var(--text)]"
        data-testid="task-name"
      >
        {task.name === "" ? "（还没起名）" : task.name}
      </h1>
      <span className={`text-[length:var(--fs-meta)] ${TONES[status.tone]}`} data-testid="task-bar-status">
        {task.status === "designing"
          ? "设计中"
          : currentWords(task) === ""
            ? status.text
            : `${currentWords(task)} · ${status.text}`}
      </span>
      <span className="text-[length:var(--fs-meta)] text-[var(--text-dim)]">{place}</span>
      {task.sourceSessionId === null ? null : (
        <button
          type="button"
          onClick={() => onOpenSource(task.sourceSessionId ?? "")}
          className="text-[length:var(--fs-meta)] text-[var(--tint)] hover:underline"
        >
          需求对话 ›
        </button>
      )}
      <span className="flex-1" />
      <span
        className="rounded-[var(--r-pill)] bg-[var(--linked)] px-2.5 py-0.5 text-[length:var(--fs-sm)] text-[var(--tint)]"
        data-testid="task-model"
      >
        任务模型 {modelWords(task.model)}
      </span>
    </header>
  );
}

/**
 * The words for the place a task works: the project and the worktree.
 *
 * @remarks
 * As the list's second line says it (设计稿第 2 屏), "对话 · 不属于项目" for a task outside any project.
 *
 * @sideEffects none
 * @param task - The task.
 * @param projects - The projects.
 * @param workspaces - The workspaces.
 * @returns The words.
 */
function placeOf(task: TaskView, projects: readonly Project[], workspaces: readonly Workspace[]): string {
  if (task.projectId === null) return "对话 · 不属于项目";
  const project = projects.find((one) => one.id === task.projectId)?.name ?? "项目";
  const workspace = workspaces.find((one) => one.id === task.workspaceId);
  return workspace === undefined ? project : `${project} · ${workspaceName(workspace)}`;
}

/**
 * A task's tab: the bar, the graph on the left and the task conversation on the right, read-only.
 *
 * @remarks
 * SPEC-0006 ("界面 · 任务标签"; T7). Opens the task on the host, which pushes it whole on every change, so the graph
 * changes state node by node as the task runs; the host holds one open task per connection, so only the tab on top
 * is mounted. A task the host does not know says so in words (`task_not_found`), as does one that cannot be read.
 * While a human node waits, the changes in the task's worktree are watched for the figure its hover card shows
 * (`watch_changes`, as the changes panel does). The selected node is kept while the tab is open and dropped if the
 * node is not in the graph any more. Links: the conversation's progress lines name nodes by this task's graph.
 *
 * @sideEffects Sends `open_task` and watches the task conversation and the worktree's changes while mounted.
 * @param props - The client, the task's id, how to open the conversation it was made from, and what the
 * conversation's lines may know of other tasks.
 * @returns The tab's content.
 */
export function TaskTab({
  client,
  taskId,
  onOpenSource,
  links,
}: {
  readonly client: AtriumClient;
  readonly taskId: string;
  readonly onOpenSource: (sessionId: string) => void;
  readonly links: Pick<TaskLinks, "task" | "openTask">;
}) {
  const state = useStore(client.task(taskId));
  const index = useStore(client.index);
  const [selected, setSelected] = useState<string | null>(null);
  const task = state.task;
  const workspaceId = task?.workspaceId ?? null;
  const waitsOnHuman = task?.nodes.some((node) => node.kind === "human" && node.state === "waiting") === true;
  const changes = useStore(workspaceId !== null && waitsOnHuman ? client.changes(workspaceId) : NO_CHANGES);

  useEffect(() => {
    // Fire and forget: what the host answers lands in the task's state, a lost connection asks again when back.
    client.openTask(taskId).catch(() => undefined);
  }, [client, taskId]);
  useEffect(() => {
    if (workspaceId === null || !waitsOnHuman) return undefined;
    client.watchChanges([workspaceId]).catch(() => undefined);
    return () => void client.watchChanges([]).catch(() => undefined);
  }, [client, workspaceId, waitsOnHuman]);

  if (task === null) {
    return (
      <p role="status" className="px-6 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
        {state.status === "missing"
          ? describeTaskError("task_not_found")
          : state.status === "failed"
            ? "没能读到这个任务，稍后再试"
            : "正在读取任务…"}
      </p>
    );
  }
  /**
   * A node's name in the task shown.
   *
   * @remarks
   * For the conversation's progress lines, which name nodes by id.
   *
   * @sideEffects none
   * @param node - The node's id.
   * @returns The name, or `undefined` when the graph has no such node.
   */
  const nodeName = (node: string): string | undefined => task.nodes.find((one) => one.id === node)?.name;
  const keep = selected !== null && task.nodes.some((node) => node.id === selected) ? selected : null;
  return (
    <TaskLinksContext value={{ ...links, nodeName }}>
      <div className="flex min-h-0 flex-1 flex-col" data-testid="task-tab" data-task={task.id}>
        <TaskBar task={task} place={placeOf(task, index.projects, index.workspaces)} onOpenSource={onOpenSource} />
        {state.status === "missing" ? (
          <p role="alert" className="px-4 py-1.5 text-[length:var(--fs-sm)] text-[var(--attn-text)]">
            {describeTaskError("task_not_found")}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <div className="relative z-20 flex min-h-0 w-[46%] min-w-[320px] flex-col shadow-[inset_-0.5px_0_0_var(--line)]">
            <TaskGraph task={task} selected={keep} stat={changes?.stat ?? null} onSelect={setSelected} />
          </div>
          <TaskConversation client={client} sessionId={task.taskSessionId} />
        </div>
      </div>
    </TaskLinksContext>
  );
}
