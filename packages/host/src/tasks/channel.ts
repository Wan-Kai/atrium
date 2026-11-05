import { type TaskErrorCode, type TaskRequest, taskCommandText } from "@atrium/pi";
import { latestRun } from "./graph";
import type { NodeId, Task } from "./types";

/*
 * The host's side of the task extension's calls (SPEC-0006, "扩展与通道"): who may call, whether the
 * arguments hold, and how the answer goes back.
 */

/** A call from the extension. */
export type TaskCall = Extract<TaskRequest, { kind: "call" }>;

/** The session a call came from, as the host knows it (never from the call's own words). */
export interface Caller {
  readonly sessionId: string;
  readonly node: NodeId;
  readonly attempt: number;
}

/** Whether the host takes a call, and if not why. */
export type CallVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: TaskErrorCode;
      readonly params?: Readonly<Record<string, unknown>>;
    };

/**
 * Whether a string holds something besides white space.
 *
 * @remarks
 * `summary`, `reason` and `suggestion` must say something (SPEC-0006, "结束" 1).
 *
 * @sideEffects none
 * @param text - The string.
 * @returns Whether it is not empty once trimmed.
 */
function said(text: string | undefined): boolean {
  return text !== undefined && text.trim() !== "";
}

/**
 * The verdict for an argument that says nothing.
 *
 * @remarks
 * `task_args_invalid` with the field named (SPEC-0006, "结束" 1).
 *
 * @sideEffects none
 * @param field - The argument.
 * @returns The verdict.
 */
function invalid(field: string): CallVerdict {
  return { ok: false, code: "task_args_invalid", params: { field } };
}

/**
 * Decides whether the host takes a call.
 *
 * @remarks
 * SPEC-0006, "扩展与通道" and "结束" 1. The caller is the session the request came from, found by the pi
 * process; only the latest run of the node, with this session, while the node is `running`, may call
 * (`task_caller_invalid`). Then the arguments: `node_done({ ok: true })` needs a summary and
 * `node_done({ ok: false })` a reason; `request_graph_change` needs both fields (`task_args_invalid`, with
 * `params.field`). A task that is gone is `task_not_found`.
 *
 * @sideEffects none
 * @param task - The task, or `undefined` when it is not known.
 * @param caller - The session and the run it belongs to.
 * @param call - The call.
 * @returns The verdict.
 */
export function checkCall(task: Task | undefined, caller: Caller, call: TaskCall): CallVerdict {
  if (task === undefined) return { ok: false, code: "task_not_found" };
  const run = latestRun(task, caller.node);
  if (
    task.cancelled ||
    task.endedAt !== null ||
    run === undefined ||
    run.void === true ||
    run.sessionId !== caller.sessionId ||
    run.attempt !== caller.attempt ||
    run.state !== "running"
  ) {
    return { ok: false, code: "task_caller_invalid" };
  }
  if (call.op === "node_done") {
    if (call.args.ok) return said(call.args.summary) ? { ok: true } : invalid("summary");
    return said(call.args.reason) ? { ok: true } : invalid("reason");
  }
  if (!said(call.args.reason)) return invalid("reason");
  return said(call.args.suggestion) ? { ok: true } : invalid("suggestion");
}

/**
 * The hidden command that answers a call.
 *
 * @remarks
 * `/atrium-task reply <base64url>` (ADR-0013, point 2). An accepted call is answered `{ recorded: true }`.
 *
 * @sideEffects none
 * @param id - The call's id.
 * @param verdict - The verdict.
 * @returns The text to send pi as a prompt.
 */
export function replyText(id: string, verdict: CallVerdict): string {
  return taskCommandText(
    "reply",
    verdict.ok
      ? { v: 1, id, ok: true, result: { recorded: true } }
      : {
          v: 1,
          id,
          ok: false,
          code: verdict.code,
          ...(verdict.params === undefined ? {} : { params: verdict.params }),
        },
  );
}
