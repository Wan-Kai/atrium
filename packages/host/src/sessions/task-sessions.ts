import type { PiEvent } from "@atrium/pi";
import type { SessionEvent } from "@atrium/protocol";
import type { TaskSessionRecord } from "../store/task-session-record";

/**
 * What a task session tells the task runner (SPEC-0006, "扩展与通道").
 *
 * @remarks
 * `epoch` is which start of pi it came from: a request from a pi that has since been replaced is
 * the old process's and the runner drops it (ADR-0013, point 5).
 */
export type TaskSessionSignal =
  | { readonly kind: "request"; readonly epoch: number; readonly text: string }
  | { readonly kind: "pi"; readonly epoch: number; readonly event: PiEvent }
  | { readonly kind: "session"; readonly epoch: number; readonly event: SessionEvent };

/** A new node session to record and start. */
interface NewTaskSession {
  readonly containerId: string;
  readonly cwd: string;
  readonly name: string;
  readonly task: TaskSessionRecord;
}

/**
 * The session layer as the task runner uses it: node sessions, which borrow only SPEC-0002's way of
 * starting and stopping pi (SPEC-0006, "一个 agent 节点怎么跑 · 起").
 *
 * @remarks
 * A node session is no child conversation: it has no `agent` record, no automatic report to a parent, no
 * place among a parent's six, and the host's restart does not hold its deliveries. It is not listed
 * among the sessions of the UI.
 */
export interface TaskSessions {
  /** Records a session of a task and starts its pi; resolves to its id once pi runs. */
  create(session: NewTaskSession): Promise<string>;
  /** The session recorded for a node's run, if there is one (SPEC-0006, "动作要幂等": `start_node`). */
  find(taskId: string, node: string, attempt: number): string | undefined;
  /** What the session's record says it is for; `undefined` for a session that belongs to no task. */
  recordOf(sessionId: string): TaskSessionRecord | undefined;
  /** Starts the session's pi if it has none. */
  open(sessionId: string): Promise<void>;
  /**
   * Sends a message to the model; resolves once pi has taken it.
   *
   * @remarks
   * It has no deadline of its own (pi may be checking the model first), so the caller's `signal` is how a
   * host that is closing gets out of a pi that never answers.
   */
  prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
  /** Sends one of Atrium's hidden commands, which pi runs at once (ADR-0013, point 2); see `prompt` for `signal`. */
  command(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
  /** Whether the session has a pi that runs. */
  alive(sessionId: string): boolean;
  /** Stops the session's pi and lets go of what the host keeps for it; the record stays. */
  stop(sessionId: string): Promise<void>;
  /** Calls `listener` with what the sessions of tasks tell; returns a function that stops it. */
  subscribe(listener: (sessionId: string, signal: TaskSessionSignal) => void): () => void;
}
