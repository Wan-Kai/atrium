import type { AtriumClient } from "@atrium/client";
import { useEffect } from "react";
import { useStore } from "zustand";
import { describeTaskError } from "./task-words";
import { TaskConversation } from "./task-conversation";

/**
 * A node's conversation as a tab of its own, full width (SPEC-0006, "节点对话"; 设计稿第 8 屏 A).
 *
 * @remarks
 * The tab belongs to the task tab on its left. It is an ordinary session: you can interject (`prompt` / `steer`),
 * stop the round, and answer the node's questions (it may use `ask_user`). The node's pi may not be running (it
 * passed, or the host restarted): `open_task_session` starts only that pi, without a tab of the project's. The
 * session id comes from the open task, so this opens the task on the host as the task tab does; a node that has not
 * started has no conversation and says so.
 *
 * @sideEffects Sends `open_task`; the conversation watches the session, starts its pi and sends messages.
 * @param props - The client, the task and the node.
 * @returns The tab's content.
 */
export function NodeTab({
  client,
  taskId,
  node,
  onBack,
}: {
  readonly client: AtriumClient;
  readonly taskId: string;
  readonly node: string;
  readonly onBack: () => void;
}) {
  const state = useStore(client.task(taskId));
  useEffect(() => {
    // Fire and forget: what the host answers lands in the task's state, a lost connection asks again when back.
    client.openTask(taskId).catch(() => undefined);
  }, [client, taskId]);
  const task = state.task;
  const found = task?.nodes.find((one) => one.id === node);
  if (task === null || found === undefined) {
    return (
      <p role="status" className="px-6 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
        {state.status === "missing"
          ? describeTaskError("task_not_found")
          : task === null
            ? "正在读取任务…"
            : "这个节点已经不在图里了"}
      </p>
    );
  }
  if (found.sessionId === null)
    return (
      <p role="status" className="px-6 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
        {node} 还没开始，没有对话可看
      </p>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="node-tab" data-task={taskId} data-node={node}>
      <header className="flex min-h-[40px] shrink-0 items-center gap-3 px-4 shadow-[inset_0_-0.5px_0_var(--line)]">
        <span className="text-[length:var(--fs-meta)] font-semibold text-[var(--text)]">
          {node} {found.name}
        </span>
        <span className="min-w-0 truncate text-[length:var(--fs-meta)] text-[var(--text-dim)]">
          节点对话 · 属于「{task.name === "" ? "任务" : task.name}」
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onBack}
          className="text-[length:var(--fs-meta)] text-[var(--tint)] hover:underline"
        >
          回到任务图 ›
        </button>
      </header>
      <TaskConversation
        client={client}
        taskId={taskId}
        sessionId={found.sessionId}
        followed={task.followed}
        title="节点对话"
        heading={false}
        idlePlaceholder="插话：发给这个节点"
      />
    </div>
  );
}
