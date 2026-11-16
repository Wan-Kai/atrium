import type { FailureReason, NodeId } from "./types";

/*
 * The words the scheduler hands to a node's or the task conversation's model. They are prompts for
 * the model, not text for the user (coding-standards.md, "宿主不产出给用户看的文字"); the wording
 * is SPEC-0006's.
 */

/** A held node picks up again (SPEC-0006, "调度器" 2). */
export const RESUME_HELD = "刚才任务暂停了，接着做";

/** The new graph was approved; the runner adds the new contract after this line (SPEC-0006, "中途"). */
export const RESUME_GRAPH_APPROVED = "图已改，下面是新的契约";

/** The new graph was refused (SPEC-0006, "中途"). */
export const RESUME_GRAPH_REJECTED = "不改图，按原来的做";

/** The host restarted under a running node (SPEC-0006, "宿主重启" 2). */
export const RESUME_RESTARTED =
  "宿主重启了。先看一下你已经做了什么（会话记录和 worktree 的改动），再接着做；做完调用 node_done";

/** A question that was waiting for the user is void after a restart (SPEC-0006, "宿主重启" 2). */
export const RESUME_QUESTION_VOID = "刚才的问题作废了，需要的话再问";

/**
 * The line that sends a failed node back to work.
 *
 * @remarks
 * SPEC-0006 writes "上次失败的原因：…"; the event carries only the failure's code, so that is what goes
 * in. The runner may say more.
 *
 * @sideEffects none
 * @param reason - Why it failed.
 * @returns The line.
 */
export function resumeAfterFailure(reason: FailureReason | null): string {
  return `上次失败的原因：${reason ?? "unknown"}，接着做`;
}

/**
 * The note that wakes the task conversation after a node asked for a graph change.
 *
 * @remarks
 * The node's reason and suggestion are not in the event (events hold ids and states, not conversation
 * content), so the runner adds them.
 *
 * @sideEffects none
 * @param node - The node that asked.
 * @returns The note.
 */
export function wakeForGraphChange(node: NodeId): string {
  return `${node} 申请改图`;
}

/** The user pressed "continue" on a node they had stopped (SPEC-0006, "节点"). */
export const CONTINUE_NODE = "继续";
