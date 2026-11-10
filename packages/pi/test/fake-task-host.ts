import { type PiEvent, type PiProcess } from "../src/process/pi-process";
import {
  type TaskCommandAction,
  type TaskErrorCode,
  type TaskRequest,
  commandText,
  readRequest,
} from "../src/task/schema";

/** A call the extension made to the host. */
export type SeenCall = Extract<TaskRequest, { kind: "call" }>;

/** What the fake host answers a call with. */
export type FakeAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TaskErrorCode; readonly params?: Record<string, unknown> };

/** How a run ended, as the host's TaskRunner would judge it. */
export type Settlement =
  | { readonly kind: "node_done"; readonly args: Extract<SeenCall, { op: "node_done" }>["args"] }
  | { readonly kind: "request_graph_change"; readonly args: Extract<SeenCall, { op: "request_graph_change" }>["args"] }
  /** The run ended normally with no settled call: SPEC-0006's `no_done`. */
  | { readonly kind: "no_done" }
  /** The run was stopped. */
  | { readonly kind: "stopped" }
  /** The run ended in an error. */
  | { readonly kind: "error" };

/** Why a pending settlement stopped counting. */
export type VoidReason = "turn_start" | "stopped" | "error";

/**
 * A stand-in for the host's TaskRunner, to test the extension against real pi.
 *
 * @remarks
 * It does what SPEC-0006 ("结束") gives the host: answers the extension's calls over the channel
 * (ADR-0013), records an accepted `node_done` or `request_graph_change` as the *pending
 * settlement*, voids it when pi starts another request (`turn_start`) or the run ends in an error
 * or a stop, and at `agent_settled` lets the last pending one stand, otherwise judges the run
 * `no_done`. It reads only what the host reads: pi's events. It is the reference for the judgement
 * T4b writes; it is not the TaskRunner.
 *
 * @sideEffects Subscribes to a pi process's events and sends it replies; test-only.
 */
export class FakeTaskHost {
  /** The calls the extension made, in order. */
  readonly calls: SeenCall[] = [];
  /** The ids the extension cancelled (ADR-0013, point 6). */
  readonly cancelled: string[] = [];
  /** How each run ended, in order. */
  readonly settlements: Settlement[] = [];
  /** Why pending settlements were voided, in order. */
  readonly voids: VoidReason[] = [];
  /** Requests the extension sent that the host could not read. */
  readonly bad: (string | null)[] = [];
  /** The accepted call that would stand if the run ended now. */
  pending: Settlement | null = null;

  private readonly outstanding: Promise<unknown>[] = [];
  private readonly held = new Map<string, SeenCall>();
  private readonly failures: unknown[] = [];
  private readonly off: () => void;

  /**
   * Starts listening to a pi process.
   *
   * @remarks
   * `answer` decides each call; the default accepts everything, and `"hold"` leaves a call waiting
   * until `release`.
   *
   * @sideEffects Subscribes to the process's events.
   * @param pi - The pi process.
   * @param answer - How to answer a call.
   */
  constructor(
    private readonly pi: PiProcess,
    private readonly answer: (call: SeenCall) => FakeAnswer | "hold" = () => ({ ok: true }),
  ) {
    this.off = pi.onEvent((event) => this.see(event));
  }

  /**
   * Stops listening and waits for the replies in flight.
   *
   * @remarks
   * A reply pi refused fails the test here, not silently.
   *
   * @sideEffects Unsubscribes.
   * @returns Once every reply sent has been accepted by pi.
   */
  async close(): Promise<void> {
    this.off();
    await Promise.all(this.outstanding);
    if (this.failures.length > 0) throw new Error("a reply to pi failed", { cause: this.failures[0] });
  }

  /**
   * Answers a call that was held.
   *
   * @remarks
   * Lets a test put something between the extension's call and the host's answer.
   *
   * @sideEffects Sends the reply to pi; may set the pending settlement.
   * @param id - The call's id.
   * @param answer - The answer; accepting by default.
   * @throws {Error} When no such call is held.
   */
  release(id: string, answer: FakeAnswer = { ok: true }): void {
    const call = this.held.get(id);
    if (call === undefined) throw new Error(`no held call ${id}`);
    this.held.delete(id);
    this.reply(call, answer);
  }

  /**
   * Sends a hidden command to the extension.
   *
   * @remarks
   * As the host's TaskRunner does: a prompt that pi handles as a command.
   *
   * @sideEffects Sends `/atrium-task <action> <argument>` to pi as a prompt.
   * @param action - The action.
   * @param argument - Its argument, with `v: 1`.
   * @returns pi's answer to the command.
   */
  async command(action: TaskCommandAction, argument: unknown): Promise<unknown> {
    return this.pi.request({ type: "prompt", message: commandText(action, argument) });
  }

  /**
   * Takes one pi event the way the host's TaskRunner does.
   *
   * @remarks
   * The channel's requests are answered; `turn_start` voids a pending settlement; `agent_end` tells
   * how the run ended; `agent_settled` settles it.
   *
   * @sideEffects May send a reply to pi; changes what is pending and what has settled.
   * @param event - The event.
   */
  private see(event: PiEvent): void {
    if (event.type === "extension_ui_request" && event.method === "setStatus") {
      if (event.statusKey.startsWith("atrium-task:") && event.statusText !== undefined) this.take(event.statusText);
    } else if (event.type === "turn_start") {
      if (this.pending !== null) this.voids.push("turn_start");
      this.pending = null;
    } else if (event.type === "agent_end") {
      const last = event.messages.findLast((message) => message.role === "assistant");
      this.failed = last !== undefined && Reflect.get(last, "stopReason") === "error";
      if (this.failed && this.pending !== null) {
        this.voids.push("error");
        this.pending = null;
      }
    } else if (event.type === "agent_settled") {
      // pi says a stopped run was stopped (`aborted`); its last message then reads as an error too.
      const stopped = Reflect.get(event, "aborted") === true;
      if (stopped && this.pending !== null) this.voids.push("stopped");
      this.settlements.push(
        stopped ? { kind: "stopped" } : this.failed ? { kind: "error" } : (this.pending ?? { kind: "no_done" }),
      );
      this.pending = null;
      this.failed = false;
    }
  }

  /** Whether the latest run's last message was an error, from `agent_end`. */
  private failed = false;

  /**
   * Reads one request from the status line and answers a call.
   *
   * @remarks
   * A request the schema cannot read is kept in `bad`, as the host would answer it `task_bad_request`.
   *
   * @sideEffects May send a reply to pi; records what it saw.
   * @param text - The status's text.
   */
  private take(text: string): void {
    const read = readRequest(text);
    if ("bad" in read) {
      this.bad.push(read.bad);
      return;
    }
    const { request } = read;
    if (request.kind === "note") {
      this.cancelled.push(request.args.id);
      return;
    }
    this.calls.push(request);
    const answer = this.answer(request);
    if (answer === "hold") this.held.set(request.id, request);
    else this.reply(request, answer);
  }

  /**
   * Answers a call, and records an accepted one as the pending settlement.
   *
   * @remarks
   * SPEC-0006, "结束": the host records the call when it accepts it.
   *
   * @sideEffects Sends the reply to pi; may set the pending settlement.
   * @param request - The call.
   * @param answer - The answer.
   */
  private reply(request: SeenCall, answer: FakeAnswer): void {
    if (answer.ok) {
      if (request.op === "node_done") this.pending = { kind: "node_done", args: request.args };
      else if (request.op === "request_graph_change")
        this.pending = { kind: "request_graph_change", args: request.args };
    }
    const body = answer.ok
      ? { v: 1, id: request.id, ok: true, result: { recorded: true } }
      : {
          v: 1,
          id: request.id,
          ok: false,
          code: answer.code,
          ...(answer.params === undefined ? {} : { params: answer.params }),
        };
    this.outstanding.push(
      this.command("reply", body).catch((error: unknown) => {
        this.failures.push(error);
      }),
    );
  }
}
