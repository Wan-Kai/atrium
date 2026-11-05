import { decodeArgument } from "../agent/agent";
import { CHILD_TOOLS, PARENT_TOOLS } from "../agent/words";
import { guardGit } from "./git-guard";
import { guardPaths } from "./path-guard";
import {
  GraphChangeArgs,
  NodeDoneArgs,
  NudgeCommand,
  ProgressCommand,
  ReplyCommand,
  ResumeCommand,
  TASK_COMMAND,
  TASK_FLAG,
  TASK_MESSAGE,
  TASK_STATUS,
  TASK_TEXT_LIMITS,
  TaskCallResults,
  type TaskCallOp,
  type TaskErrorCode,
  type TaskMessageDetails,
  type TaskReply,
  readSelf,
  writeRequest,
} from "./schema";
import {
  GRAPH_CHANGE_TAKEN,
  NODE_DONE_TAKEN,
  TASK_STOPPED,
  errorText,
  nodeToolRefusal,
  nudgeText,
  resumeText,
  tooLong,
} from "./words";

/** pi's one-way status line, which the extension asks the host on (ADR-0013, point 1). */
interface StatusLine {
  setStatus(key: string, text: string | undefined): void;
}

/** One of pi's session entries, as the extension reads it. */
interface EntryView {
  readonly type: string;
}

/** The part of a tool's or a command's context the extension uses. */
interface TaskContext {
  readonly ui: StatusLine;
  readonly sessionManager: { getBranch(): readonly EntryView[] };
}

/** A tool's result, as pi takes it; `terminate` ends the run when every result of the batch has it. */
interface ToolResult {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: unknown;
  readonly isError?: boolean;
  readonly terminate?: boolean;
}

/** A tool, as the extension registers it with pi; its parameters are plain JSON Schema. */
interface TaskTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  /** `sequential` runs a batch with this tool one call at a time. */
  readonly executionMode: "sequential";
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: TaskContext,
  ): Promise<ToolResult>;
}

/** The part of pi's API the task extension uses; its test checks pi's `ExtensionAPI` fits it. */
export interface TaskApi {
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, ctx: TaskContext & { isIdle(): boolean }) => Promise<void>;
    },
  ): void;
  sendMessage(
    message: {
      readonly customType: string;
      readonly content: string;
      readonly display: boolean;
      readonly details: unknown;
    },
    options?: { readonly triggerTurn?: boolean },
  ): void;
  registerTool(tool: TaskTool): void;
  registerFlag(name: string, options: { readonly description: string; readonly type: "string" }): void;
  on(
    event: "tool_call",
    handler: (
      event: { readonly toolName: string; readonly input: unknown },
      ctx: { readonly cwd: string },
    ) => { block: true; reason: string } | undefined,
  ): unknown;
}

/** What the extension needs besides pi, which tests replace. */
export interface TaskDeps {
  /** pi's own arguments: the flag is read from them, since pi hands the extension its flags only after loading. */
  readonly argv: readonly string[];
}

/** The deps pi runs the extension with. */
const REAL_DEPS: TaskDeps = { argv: process.argv };

/**
 * Finds the `--atrium-task=<value>` argument among pi's.
 *
 * @remarks
 * The flag must be one argument with an `=` (ADR-0013, point 3: a base64url value can start with
 * `-`). The tools have to be registered while the extension loads, before pi sets any flag, so the
 * extension reads its own process's arguments; `registerFlag` is still done, so pi does not reject
 * the argument as unknown.
 *
 * @sideEffects none
 * @param argv - pi's arguments.
 * @returns The value, or `undefined` when there is none.
 */
export function flagValue(argv: readonly string[]): string | undefined {
  const prefix = `--${TASK_FLAG}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/**
 * A JSON Schema object of the given properties.
 *
 * @remarks
 * pi checks plain JSON Schema as it checks TypeBox's; nothing of pi is bundled.
 *
 * @sideEffects none
 * @param properties - The properties.
 * @param required - The required ones.
 * @returns The schema.
 */
function object(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * A tool result of text.
 *
 * @remarks
 * `details` is kept in the session file and never shown to the model.
 *
 * @sideEffects none
 * @param text - What the model reads.
 * @param details - What the session keeps.
 * @param extra - `isError`, or `terminate`.
 * @returns The result.
 */
function toolResult(text: string, details: unknown, extra: { isError?: true; terminate?: true } = {}): ToolResult {
  return { content: [{ type: "text", text }], details, ...extra };
}

/**
 * An error result for the model.
 *
 * @remarks
 * The details keep the code.
 *
 * @sideEffects none
 * @param code - The code.
 * @param extra - Its parameters.
 * @returns The result.
 */
function failed(code: TaskErrorCode, extra?: Readonly<Record<string, unknown>>): ToolResult {
  return toolResult(errorText(code, extra), { v: 1, error: code }, { isError: true });
}

/**
 * The `details.id` of a custom message, if it is one of the task extension's.
 *
 * @remarks
 * How the extension knows a command it already carried out, also in a pi that was restarted
 * (SPEC-0006, "动作要幂等": the host may send one again).
 *
 * @sideEffects none
 * @param entry - A session entry.
 * @returns The id, or `undefined`.
 */
function messageId(entry: EntryView): string | undefined {
  if (entry.type !== "custom_message" || Reflect.get(entry, "customType") !== TASK_MESSAGE) return undefined;
  const details: unknown = Reflect.get(entry, "details");
  const id: unknown = typeof details === "object" && details !== null ? Reflect.get(details, "id") : undefined;
  return typeof id === "string" ? id : undefined;
}

/** What each node tool is: its words for the model, its parameters, and what it tells the model on success. */
const NODE_TOOL_SPECS: Readonly<
  Record<TaskCallOp, Omit<TaskTool, "execute" | "name" | "executionMode"> & { readonly taken: string }>
> = {
  node_done: {
    label: "Finish node",
    description:
      'Report that your step of the task is finished, or that you give up on it, and end your turn. Call it alone, as your only tool call, after everything else is done: if you call other tools in the same batch, or the user writes to you before your turn ends, the call is void and you must call it again. With ok true, summary is the handoff the next steps read: what you did; where the output is; the result of each point of "done when", one by one; what you leave to later steps and did not do; risks and what you are unsure of. With ok false, reason says why you cannot finish.',
    promptSnippet: "Finish this step of the task with a handoff summary (call it alone)",
    parameters: object(
      {
        ok: { type: "boolean", description: "true: the step is done. false: you give up and say why in reason." },
        summary: {
          type: "string",
          description: `The handoff summary. Required when ok is true. At most ${String(TASK_TEXT_LIMITS.summary)} characters.`,
        },
        reason: {
          type: "string",
          description: `Why you give up. Required when ok is false. At most ${String(TASK_TEXT_LIMITS.reason)} characters.`,
        },
      },
      ["ok"],
    ),
    taken: NODE_DONE_TAKEN,
  },
  request_graph_change: {
    label: "Request graph change",
    description:
      "Ask for the task's graph of steps to change, when you cannot finish your step without doing what later steps are for, or the steps do not fit the work. Call it alone, as your only tool call: your turn ends, and this step waits until the user decides. If you only need an answer from the user, use ask_user instead; if you are unsure, ask rather than guess.",
    promptSnippet: "Ask for the task graph to change (call it alone)",
    parameters: object(
      {
        reason: {
          type: "string",
          minLength: 1,
          description: `Why the graph has to change. At most ${String(TASK_TEXT_LIMITS.reason)} characters.`,
        },
        suggestion: {
          type: "string",
          minLength: 1,
          description: `What the graph should become. At most ${String(TASK_TEXT_LIMITS.suggestion)} characters.`,
        },
      },
      ["reason", "suggestion"],
    ),
    taken: GRAPH_CHANGE_TAKEN,
  },
};

/**
 * Registers Atrium's task part: the node tools, `/atrium-task`, the flag, and the guards.
 *
 * @remarks
 * SPEC-0006, "扩展与通道" and ADR-0013. The flag `--atrium-task=<base64url JSON>` says whether the
 * session is a task node, the task conversation, or neither; neither registers nothing of the task
 * part (the path and git guards are still set up, and follow their `isolated` switches). A node
 * gets `node_done` and `request_graph_change`: each asks the host over the status line
 * `atrium-task:<id>` and waits for `/atrium-task reply`, then ends the turn (`terminate: true`) and
 * runs alone in its batch (`executionMode: "sequential"`). Whether the call stands (the pending
 * settlement, voided by a new request to the model, an error or a stop) is the host's to judge from
 * pi's events; the extension only reports the call. `nudge` and `resume` start a turn with words the
 * extension writes or wraps; `progress` writes a line without one. A node's `tool_call` hook also
 * refuses the tools its role does not have. Anything the extension cannot read does nothing.
 *
 * @sideEffects Registers a flag and two `tool_call` hooks with pi; for a task session also a command,
 * and for a node two tools and a third hook. The tools ask the host; the command writes custom
 * messages into the session.
 * @param pi - pi's extension API.
 * @param isolated - Whether the agent part (SPEC-0002) made this session isolated.
 * @param deps - pi's arguments; tests alone pass other ones.
 */
export default function atriumTask(pi: TaskApi, isolated: () => boolean, deps: TaskDeps = REAL_DEPS): void {
  pi.registerFlag(TASK_FLAG, {
    description: "What kind of task session this is, set by Atrium's host",
    type: "string",
  });
  const self = readSelf(flagValue(deps.argv));
  const nodeIsolated = self?.kind === "node" && self.isolated !== false;
  /**
   * Whether the guards are on: a node always is, unless the host switched it off, and so is a session the agent part isolated.
   *
   * @remarks
   * Asked at every call, because the agent part reads its flag only after pi has loaded.
   *
   * @sideEffects none
   * @returns Whether.
   */
  const isOn = (): boolean => nodeIsolated || isolated();
  guardPaths(pi, isOn);
  guardGit(pi, isOn);
  if (self === null) return;

  /** Calls waiting for the host's answer, by request id. */
  const calls = new Map<string, (reply: TaskReply) => void>();
  let sequence = 0;

  /**
   * Sends the host a note, which it does not answer.
   *
   * @remarks
   * ADR-0013, point 6: the only note is `cancel`, for a call given up.
   *
   * @sideEffects Writes and clears a status.
   * @param ui - The status line.
   * @param id - The call's id.
   */
  const cancel = (ui: StatusLine, id: string): void => {
    const noteId = `n${String(++sequence)}`;
    const key = `${TASK_STATUS}:${noteId}`;
    ui.setStatus(key, writeRequest({ kind: "note", id: noteId, op: "cancel", args: { id } }));
    ui.setStatus(key, undefined);
  };

  /**
   * Asks the host and waits for its answer.
   *
   * @remarks
   * ADR-0013: the request id is the tool call's; the status is cleared once answered, and only the
   * first answer to an id counts. A stopped tool answers itself `null` and tells the host it no
   * longer waits.
   *
   * @sideEffects Writes and clears a status; may send a note.
   * @param ui - The tool's status line.
   * @param id - The request id.
   * @param op - The call.
   * @param args - Its arguments.
   * @param signal - The tool's signal.
   * @returns The answer, or `null` when the tool was stopped.
   */
  const ask = (
    ui: StatusLine,
    id: string,
    op: TaskCallOp,
    args: NodeDoneArgs | GraphChangeArgs,
    signal: AbortSignal | undefined,
  ): Promise<TaskReply | null> => {
    if (signal?.aborted === true) return Promise.resolve(null);
    const key = `${TASK_STATUS}:${id}`;
    return new Promise((resolve) => {
      /**
       * Gives the call up as the tool is stopped.
       *
       * @remarks
       * The host is told to drop it, so no reply comes (ADR-0013, point 6).
       *
       * @sideEffects Clears the status; sends `cancel`.
       */
      const aborted = (): void => {
        calls.delete(id);
        ui.setStatus(key, undefined);
        cancel(ui, id);
        resolve(null);
      };
      signal?.addEventListener("abort", aborted, { once: true });
      calls.set(id, (reply) => {
        signal?.removeEventListener("abort", aborted);
        calls.delete(id);
        ui.setStatus(key, undefined);
        resolve(reply);
      });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `op` and `args` come from the same tool.
      ui.setStatus(key, writeRequest({ kind: "call", id, op, args } as never));
    });
  };

  /**
   * Runs a node tool: checks the lengths, asks the host, and words its answer.
   *
   * @remarks
   * The host validates the contents (SPEC-0006, "结束"); success ends the turn, so it carries
   * `terminate: true`. A refusal is an error result and the model goes on. A stopped tool throws,
   * which pi keeps as the error result.
   *
   * @sideEffects Asks the host.
   * @param op - Which tool.
   * @param id - The tool call's id.
   * @param params - Its parameters.
   * @param signal - Its signal.
   * @param ctx - Its context.
   * @returns The result.
   * @throws {Error} When stopped.
   */
  const run = async (
    op: TaskCallOp,
    id: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    ctx: TaskContext,
  ): Promise<ToolResult> => {
    const long = tooLong(op, params);
    if (long !== null) return failed("task_text_too_long", long);
    const args =
      op === "node_done"
        ? NodeDoneArgs.safeParse({
            ok: params["ok"],
            summary: params["summary"] ?? "",
            ...(params["reason"] === undefined ? {} : { reason: params["reason"] }),
          })
        : GraphChangeArgs.safeParse({ reason: params["reason"], suggestion: params["suggestion"] });
    if (!args.success) return failed("task_bad_request");
    const reply = await ask(ctx.ui, id, op, args.data, signal);
    if (reply === null) throw new Error(TASK_STOPPED);
    if (!reply.ok) return failed(reply.code, reply.params);
    if (!TaskCallResults[op].safeParse(reply.result).success) return failed("task_bad_request");
    return toolResult(NODE_TOOL_SPECS[op].taken, { v: 1, tool: op }, { terminate: true });
  };

  /**
   * Takes the host's answer to a call.
   *
   * @remarks
   * Anything unreadable, or for a call not waiting (late, repeated, or from before a restart), does
   * nothing (ADR-0013, points 5 and 7).
   *
   * @sideEffects Settles the call it answers.
   * @param value - The command's argument.
   */
  const replied = (value: unknown): void => {
    const parsed = ReplyCommand.safeParse(value);
    if (!parsed.success) return;
    const { v: _v, ...reply } = parsed.data;
    calls.get(reply.id)?.(reply);
  };

  /** The ids of the commands carried out in this process, which the session file may not show yet. */
  const handled = new Set<string>();

  /**
   * Takes a command's id, unless the command was carried out already, in this process or before it.
   *
   * @remarks
   * The session file keeps the messages the commands wrote with their ids; the set covers the
   * moment before pi has written one.
   *
   * @sideEffects Remembers the id.
   * @param id - The command's id.
   * @param ctx - The command's context.
   * @returns Whether the command is new.
   */
  const claim = (id: string, ctx: TaskContext): boolean => {
    if (handled.has(id) || ctx.sessionManager.getBranch().some((entry) => messageId(entry) === id)) return false;
    handled.add(id);
    return true;
  };

  /**
   * Writes a custom message into the session, with or without starting a turn.
   *
   * @remarks
   * `triggerTurn: true` on an idle pi starts a run; the host sends `nudge` and `resume` only when
   * the session is idle (after `agent_settled`, or a pi just started).
   *
   * @sideEffects Writes a custom message; may start a run.
   * @param content - What the model reads.
   * @param details - What the session keeps.
   * @param triggerTurn - Whether it starts a turn.
   */
  const write = (content: string, details: TaskMessageDetails, triggerTurn: boolean): void => {
    pi.sendMessage({ customType: TASK_MESSAGE, content, display: true, details }, { triggerTurn });
  };

  pi.registerCommand(TASK_COMMAND, {
    description: "Atrium's tasks, sent by Atrium's host",
    handler: (args, ctx) => {
      const [action, argument] = args.trim().split(/\s+/);
      // A missing argument reads as nothing, as any word that is not base64url JSON does.
      const value = decodeArgument(String(argument));
      if (action === "reply") {
        replied(value);
      } else if (action === "nudge") {
        const nudge = NudgeCommand.safeParse(value);
        if (nudge.success && self.kind === "node" && claim(nudge.data.id, ctx)) {
          write(nudgeText(), { v: 1, kind: "nudge", id: nudge.data.id }, true);
        }
      } else if (action === "resume") {
        const resume = ResumeCommand.safeParse(value);
        if (resume.success && claim(resume.data.id, ctx)) {
          const { id, kind, text } = resume.data;
          write(resumeText(kind, text), { v: 1, kind: "resume", id, reason: kind }, true);
        }
      } else if (action === "progress") {
        const progress = ProgressCommand.safeParse(value);
        if (progress.success && claim(progress.data.id, ctx)) {
          const { id, at, text } = progress.data;
          write(text, { v: 1, kind: "progress", id, at, text }, false);
        }
      }
      return Promise.resolve();
    },
  });

  if (self.kind !== "node") return;
  const { role } = self;
  for (const op of ["node_done", "request_graph_change"] as const) {
    const { taken: _taken, ...spec } = NODE_TOOL_SPECS[op];
    pi.registerTool({
      name: op,
      ...spec,
      // A second call in the same batch waits for the first, so a batch with this tool is never parallel.
      executionMode: "sequential",
      execute: (id, params, signal, _onUpdate, ctx) => run(op, id, params, signal, ctx),
    });
  }
  pi.on("tool_call", (event) => {
    const why = nodeToolRefusal(role, event.toolName, [...PARENT_TOOLS, ...CHILD_TOOLS]);
    return why === null ? undefined : { block: true, reason: why };
  });
}
