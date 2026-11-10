import type { AtriumClient } from "@atrium/client";
import type { Project, TaskNode, TaskPendingGraph, TaskView, Workspace } from "@atrium/protocol";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { ReviewEnvContext } from "../chat/review-env";
import { type TaskLinks, TaskLinksContext } from "../chat/task-links";
import { workspaceName } from "../sidebar/names";
import { TaskConversation } from "./task-conversation";
import { type NodeMark, TaskGraph } from "./task-graph";
import { taskReviewEnv, describeTaskCommandError } from "./review-words";
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

/** The class of the bar's buttons: 28px pills, as the cards' (design-language, "任务区"). */
const BAR_BUTTON =
  "atrium-press inline-flex h-7 items-center gap-1 rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] whitespace-nowrap disabled:cursor-default disabled:opacity-50";

/**
 * A button that asks again before it does something that cannot be undone.
 *
 * @remarks
 * 放弃任务 and 取消任务 (SPEC-0006, "T8b 定下的细节"): the first press turns the button into a question with "确定"
 * and "不了" beside it, in the bar itself and not in a dialog; "不了" and Esc go back. Nothing is sent by the first
 * press.
 *
 * @sideEffects Keeps whether it is asking; calls `onConfirm` on "确定".
 * @param props - The label, the question, and what confirming does.
 * @returns The button, or the question.
 */
function ConfirmButton({
  label,
  question,
  disabled,
  onConfirm,
}: {
  readonly label: string;
  readonly question: string;
  readonly disabled: boolean;
  readonly onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAsking(true)}
        className={`${BAR_BUTTON} text-[var(--danger)] hover:bg-[var(--danger-soft)]`}
      >
        {label}
      </button>
    );
  return (
    <span
      role="group"
      aria-label={question}
      data-testid="confirm-asking"
      className="inline-flex items-center gap-1.5"
      onKeyDown={(event) => {
        if (event.key === "Escape") setAsking(false);
      }}
    >
      <span className="text-[length:var(--fs-meta)] whitespace-nowrap text-[var(--danger)]">{question}</span>
      <button
        type="button"
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        className={`${BAR_BUTTON} bg-[var(--danger)] font-medium text-white`}
      >
        确定
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className={`${BAR_BUTTON} text-[var(--text-2)] hover:bg-[var(--hover)]`}
      >
        不了
      </button>
    </span>
  );
}

/**
 * The task bar: name, status, project and worktree, the link to the conversation it was made from, the model, and
 * the buttons.
 *
 * @remarks
 * 设计稿第 4、5 屏. While designing: 放弃任务 and 确认并启动 (the second waits for a drawn graph). Running or waiting:
 * 暂停任务 and 取消任务; paused: 继续 and 取消任务 (the host sends a paused task as `stopped` with `paused` set, never
 * `running`); stopped by a node's failure or by the user's own stop: 取消任务; over: none. 放弃 and 取消 ask again first.
 * A followed task (T7.1) is another process's: no buttons. The model is shown, not changed: it changes by saying
 * so in the task conversation. A task made by a schedule has no conversation to link. A command's failure is
 * worded under the bar.
 *
 * @sideEffects Sends `start_task`, `abandon_task`, `pause_task`, `resume_task`, `cancel_task` and, for a kept
 * worktree, `answer_archive`; the callback opens the source conversation.
 * @param props - The client, the task, the places' names, and what opening the source does.
 * @returns The bar.
 */
function TaskBar({
  client,
  task,
  place,
  onOpenSource,
}: {
  readonly client: AtriumClient;
  readonly task: TaskView;
  readonly place: string;
  readonly onOpenSource: (sessionId: string) => void;
}) {
  const status = statusWords(task);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Runs a task command once, worded on failure.
   *
   * @remarks
   * A second press while one is on its way does nothing.
   *
   * @sideEffects Sends the command; updates the bar's state.
   * @param command - The command.
   */
  const run = (command: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    // Fire and forget: the task's own push shows the result; a failure is worded below.
    void command().then(
      () => setBusy(false),
      (error: unknown) => {
        setBusy(false);
        setFailure(describeTaskCommandError(error));
      },
    );
  };
  const live = task.status === "running" || task.status === "waiting";
  const template = task.scheduleDraft;
  const buttons: ReactNode = task.followed ? null : task.status === "designing" ? (
    <>
      {template?.saved === true ? null : (
        <ConfirmButton
          label="放弃任务"
          question="放弃这个任务？"
          disabled={busy}
          onConfirm={() => run(() => client.abandonTask(task.id))}
        />
      )}
      <button
        type="button"
        disabled={busy || task.nodes.length === 0}
        title={task.nodes.length === 0 ? "还没有图：先在任务对话里把图画出来" : undefined}
        onClick={() => run(() => client.startTask(task.id))}
        className={`${BAR_BUTTON} bg-[var(--tint)] font-medium text-[var(--on-tint)]`}
      >
        {template === null ? "确认并启动" : "确认并保存规则"}
      </button>
    </>
  ) : live || task.status === "stopped" ? (
    <>
      {live || task.paused ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => (task.paused ? client.resumeTask(task.id) : client.pauseTask(task.id)))}
          className={`${BAR_BUTTON} text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]`}
        >
          {task.paused ? "继续" : "暂停任务"}
        </button>
      ) : null}
      <ConfirmButton
        label="取消任务"
        question="取消这个任务？"
        disabled={busy}
        onConfirm={() => run(() => client.cancelTask(task.id))}
      />
    </>
  ) : task.archive === "kept" ? (
    <button
      type="button"
      disabled={busy}
      onClick={() => run(() => client.answerArchive(task.id, "archive"))}
      className={`${BAR_BUTTON} text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]`}
    >
      归档 worktree
    </button>
  ) : null;
  return (
    <header className="shrink-0 shadow-[inset_0_-0.5px_0_var(--line)]">
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
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
            : currentWords(task) === "" || task.status === "done"
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
        {buttons === null ? null : (
          <span className="flex items-center gap-1.5" data-testid="task-buttons">
            {buttons}
          </span>
        )}
      </div>
      {failure === null ? null : (
        <p
          role="alert"
          data-testid="task-bar-failure"
          className="px-4 pb-1.5 text-[length:var(--fs-sm)] text-[var(--danger)]"
        >
          {failure}
        </p>
      )}
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
 * The nodes the graph's last change added or changed.
 *
 * @remarks
 * From the host's `graphDiff` (SPEC-0006, "T8a 定下的细节"): a node added is "新", one changed gets the dashed frame.
 * A proposed graph being looked at uses its own diff against the graph in force.
 *
 * @sideEffects none
 * @param diff - The diff, or `null` for the first version.
 * @returns The marks by node id.
 */
function marksOf(
  diff: { readonly added: readonly string[]; readonly changed: readonly string[] } | null,
): ReadonlyMap<string, NodeMark> {
  const marks = new Map<string, NodeMark>();
  if (diff === null) return marks;
  for (const node of diff.changed) marks.set(node, "changed");
  for (const node of diff.added) marks.set(node, "new");
  return marks;
}

/**
 * A proposed graph as the graph pane draws one: every node not started.
 *
 * @remarks
 * What "点开在图上看" shows (SPEC-0006, "审核卡片"): the nodes carry the plan only, so their states are the not-yet
 * state, except those already in the graph, which keep theirs; the nodes the change removes are not drawn, the card lists them.
 *
 * @sideEffects none
 * @param pending - The proposed graph.
 * @param model - The task's model, which a node without its own inherits.
 * @param current - The nodes of the graph in force.
 * @returns The nodes, the edges and the version, in the shape the graph draws.
 */
function proposedGraph(
  pending: TaskPendingGraph,
  model: TaskView["model"],
  current: readonly TaskNode[],
): Pick<TaskView, "nodes" | "edges" | "graphVersion" | "model"> {
  // A node that is in the graph now keeps how it stands (passed stays passed); only the new ones are not started.
  const nodes: TaskNode[] = pending.nodes.map((planned) => {
    const now = current.find((one) => one.id === planned.id);
    return now === undefined
      ? {
          ...planned,
          state: "pending",
          attempt: 0,
          waitingFor: null,
          blocked: null,
          failure: null,
          summary: null,
          sessionId: null,
          sendBack: [],
        }
      : { ...now, ...planned };
  });
  return { nodes, edges: pending.edges, graphVersion: pending.version, model };
}

/**
 * A task's tab: the bar, the graph on the left and the task conversation on the right.
 *
 * @remarks
 * SPEC-0006 ("界面 · 任务标签"; T7, T8). Opens the task on the host, which pushes it whole on every change, so the graph
 * changes state node by node as the task runs; the host holds one open task per connection, so only the tab on top
 * is mounted. A task the host does not know says so in words (`task_not_found`), as does one that cannot be read.
 * While a human node waits, the changes in the task's worktree are watched for the figure its hover card shows
 * (`watch_changes`, as the changes panel does). The selected node is kept while the tab is open and dropped if the
 * node is not in the graph any more. Links: the conversation's progress lines name nodes by this task's graph and
 * open a node's conversation. The review cards read their words from here (`ReviewEnvContext`): the codes the
 * host sent become sentences in `taskReviewEnv`, "在图上看" swaps the graph for the proposed one until you go back,
 * "查看改动" goes to the worktree's changes panel. Nodes the last change added or changed carry "新" or a dashed
 * frame. The requirements summary sits at the top of the conversation.
 *
 * @sideEffects Sends `open_task` and watches the task conversation and the worktree's changes while mounted; the
 * parts send the task commands.
 * @param props - The client, the task's id, how to open the conversation it was made from, a node's conversation
 * and a workspace's changes, and what the conversation's lines may know of other tasks.
 * @returns The tab's content.
 */
export function TaskTab({
  client,
  taskId,
  onOpenSource,
  onOpenNode,
  onOpenChanges,
  links,
}: {
  readonly client: AtriumClient;
  readonly taskId: string;
  readonly onOpenSource: (sessionId: string) => void;
  readonly onOpenNode: (taskId: string, node: string) => void;
  readonly onOpenChanges: (workspaceId: string) => void;
  readonly links: Pick<TaskLinks, "task" | "openTask">;
}) {
  const state = useStore(client.task(taskId));
  const index = useStore(client.index);
  const [selected, setSelected] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const task = state.task;
  const workspaceId = task?.workspaceId ?? null;
  const waitsOnHuman = task?.nodes.some((node) => node.kind === "human" && node.state === "waiting") === true;
  const changes = useStore(workspaceId !== null && waitsOnHuman ? client.changes(workspaceId) : NO_CHANGES);
  const pending = task?.pending ?? null;
  // Looking is about the proposal waiting, whichever version that is: a newer one that comes while you look is
  // shown with the banner updated, and once none waits you are back on the current graph (T8 review fix 8).
  const lookingAt = looking && pending !== null ? pending : null;
  const drawn = useMemo(
    () => (task === null ? null : lookingAt === null ? task : proposedGraph(lookingAt, task.model, task.nodes)),
    [task, lookingAt],
  );
  const reviewEnv = useMemo(
    () =>
      taskReviewEnv({
        nodeName: (node) =>
          task?.nodes.find((one) => one.id === node)?.name ?? pending?.nodes.find((one) => one.id === node)?.name,
        openChanges: onOpenChanges,
        // Only the proposal that waits can be looked at: a card for another version is the one that was decided.
        showOnGraph: (version) => setLooking(pending?.version === version),
      }),
    [task, pending, onOpenChanges],
  );
  const proposalWaits = pending !== null;
  useEffect(() => {
    // Nothing is proposed any more: the next proposal is not looked at until you ask.
    // oxlint-disable-next-line react/set-state-in-effect -- the task is the host's, which this follows.
    if (!proposalWaits) setLooking(false);
  }, [proposalWaits]);

  useEffect(() => {
    // Fire and forget: what the host answers lands in the task's state, a lost connection asks again when back.
    client.openTask(taskId).catch(() => undefined);
  }, [client, taskId]);
  useEffect(() => {
    if (workspaceId === null || !waitsOnHuman) return undefined;
    client.watchChanges([workspaceId]).catch(() => undefined);
    return () => void client.watchChanges([]).catch(() => undefined);
  }, [client, workspaceId, waitsOnHuman]);

  if (task === null || drawn === null) {
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
  const keep = selected !== null && drawn.nodes.some((node) => node.id === selected) ? selected : null;
  /**
   * Whether a node has a conversation to open: it has started.
   *
   * @remarks
   * A progress line of a node that has no session (human nodes, nodes not started) is plain text, not a link.
   *
   * @sideEffects none
   * @param node - The node's id.
   * @returns Whether it does.
   */
  const canOpenNode = (node: string): boolean => task.nodes.some((one) => one.id === node && one.sessionId !== null);
  const openNode = task.followed ? undefined : (node: string): void => onOpenNode(task.id, node);
  return (
    <TaskLinksContext
      value={{
        ...links,
        nodeName,
        ...(openNode === undefined ? {} : { openNode, canOpenNode }),
      }}
    >
      <ReviewEnvContext value={reviewEnv}>
        <div className="flex min-h-0 flex-1 flex-col" data-testid="task-tab" data-task={task.id}>
          <TaskBar
            client={client}
            task={task}
            place={placeOf(task, index.projects, index.workspaces)}
            onOpenSource={onOpenSource}
          />
          {state.status === "missing" ? (
            <p role="alert" className="px-4 py-1.5 text-[length:var(--fs-sm)] text-[var(--attn-text)]">
              {describeTaskError("task_not_found")}
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <div className="relative z-20 flex min-h-0 w-[46%] min-w-[320px] flex-col shadow-[inset_-0.5px_0_0_var(--line)]">
              {lookingAt === null ? null : (
                <div
                  data-testid="graph-proposed"
                  className="flex shrink-0 items-center gap-2 bg-[var(--attn-soft)] px-4 py-1.5 text-[length:var(--fs-sm)] text-[var(--attn-text)]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    正在看图 v{lookingAt.version}（等你批准）
                    {lookingAt.diff.removed.length > 0 ? ` · 去掉 ${lookingAt.diff.removed.join("、")}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLooking(false)}
                    className="text-[var(--tint)] hover:underline"
                  >
                    回到当前图
                  </button>
                </div>
              )}
              <TaskGraph
                task={drawn}
                selected={keep}
                stat={changes?.stat ?? null}
                marks={marksOf(lookingAt === null ? task.graphDiff : lookingAt.diff)}
                onSelect={setSelected}
                {...(lookingAt === null && openNode !== undefined ? { onOpenNode: openNode } : {})}
              />
            </div>
            <TaskConversation
              client={client}
              taskId={task.id}
              sessionId={task.taskSessionId}
              followed={task.followed}
              requirements={task.requirements}
            />
          </div>
        </div>
      </ReviewEnvContext>
    </TaskLinksContext>
  );
}
