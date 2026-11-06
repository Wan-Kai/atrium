import { ReviewRecord, ThinkingLevel } from "@atrium/protocol";
import { z } from "zod";
import { ENVELOPE_LIMIT } from "../agent/channel";
import { decodeArgument } from "../agent/agent";

/**
 * The contract between Atrium's task extension (in pi) and the host's TaskRunner (SPEC-0006, "扩展与通道").
 *
 * @remarks
 * Everything the two sides exchange is defined here once, in zod, and the host imports it
 * (ADR-0013, point 9: "扩展和宿主共用"). The channel is ADR-0013's, under its own names:
 *
 * - extension to host: `setStatus("atrium-task:<request id>", <envelope JSON>)` ({@link TaskRequest});
 * - host to extension: the hidden command `/atrium-task <action> <base64url JSON>` ({@link TaskCommand});
 * - who the session is: the start-up argument `--atrium-task=<base64url JSON>` ({@link TaskSelf}).
 */

/** The status key prefix the extension asks the host on: `atrium-task:<request id>` (ADR-0013, point 1). */
export const TASK_STATUS = "atrium-task";

/** The start-up flag that says what kind of task session this is: `--atrium-task=<base64url JSON>`. */
export const TASK_FLAG = "atrium-task";

/** The hidden command the host hands the task extension things with: `/atrium-task <action> <argument>`. */
export const TASK_COMMAND = "atrium-task";

/** The custom type of the messages the task extension writes into pi's session (`details.kind` tells which). */
export const TASK_MESSAGE = "atrium-task";

/** The custom type of the record a review leaves in the task conversation once its verdict took effect (ADR-0017). */
export const REVIEW_MESSAGE = "atrium-review";

/** The most an envelope or a command's argument holds before it is encoded (ADR-0013, point 9). */
const TASK_ENVELOPE_LIMIT = ENVELOPE_LIMIT;

/**
 * The longest each piece of text the task tools and commands take may be.
 *
 * @remarks
 * SPEC-0006 sets none, so these follow SPEC-0002's tables (`task`, `message`: 32 000;
 * `question`: 4 000; progress: 2 000). The extension checks them and answers the model
 * `task_text_too_long`; what reaches the host longer than that was not sent by Atrium's extension.
 */
export const TASK_TEXT_LIMITS = {
  /** `node_done`'s `summary`. */
  summary: 32_000,
  /** `node_done`'s `reason` and `request_graph_change`'s `reason`. */
  reason: 4000,
  /** `request_graph_change`'s `suggestion`. */
  suggestion: 32_000,
  /** The `text` of `/atrium-task resume`. */
  resume: 32_000,
  /** The `text` of `/atrium-task progress`. */
  progress: 2000,
  /** The `text` of `/atrium-task review`. */
  review: 8000,
} as const;

/** The tools only a node's session has, and its model calls to end its step or ask for a new graph. */
export const NODE_TOOLS = ["node_done", "request_graph_change"] as const;

/**
 * The tools only the task conversation has (SPEC-0006, "任务对话").
 *
 * @remarks
 * Eight, not SPEC-0006's nine: `task_set_schedule` comes with schedules (T10), and a tool that records a
 * schedule nothing runs would promise the user something that does not happen (SPEC-0006, "T6 定下的细节").
 */
export const CONVERSATION_TOOLS = [
  "task_read_source",
  "task_set_summary",
  "task_set_meta",
  "task_status",
  "task_read_node",
  "task_diff",
  "task_propose_graph",
  "task_send_to_node",
] as const;

/**
 * The ids of the four guides the task conversation chooses from (SPEC-0006, "附录：引导词").
 *
 * @remarks
 * The texts are the host's (`packages/host/src/tasks/guides.ts`); the id is what `task_propose_graph`
 * names and the task records.
 */
export const GUIDE_IDS = ["feature", "fix", "scheduled_fix", "research"] as const;
export const GuideId = z.enum(GUIDE_IDS);
export type GuideId = z.infer<typeof GuideId>;

/** The role of a node (SPEC-0006, "节点"); what its session may use follows from it. */
export const NodeRole = z.enum(["explore", "work", "check", "advise"]);
export type NodeRole = z.infer<typeof NodeRole>;

/**
 * Who a task session is, as the host's `--atrium-task` flag says.
 *
 * @remarks
 * Only the kind of session and its role, never an identity: the host knows who is calling from the
 * pi process the request came from, and does not read this (SPEC-0006, "调用方由宿主认定"). Without the
 * flag (or with one that does not read) the session is neither, and the task part registers
 * nothing. The `conversation` kind is the task conversation (T6): it gets the `task_*` tools
 * ({@link CONVERSATION_TOOLS}) and takes the hidden commands.
 */
export const TaskSelf = z.discriminatedUnion("kind", [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("node"),
    /** The node's role: it decides which tools the session may use. */
    role: NodeRole,
    /**
     * Whether the node may only change files under its working directory. Absent means true: every
     * node is isolated; the host sets `false` only to switch the guard off.
     */
    isolated: z.boolean().optional(),
  }),
  z.strictObject({ v: z.literal(1), kind: z.literal("conversation") }),
]);
export type TaskSelf = z.infer<typeof TaskSelf>;

/**
 * Reads who the session is from the flag's value.
 *
 * @remarks
 * Anything that is not base64url JSON of a {@link TaskSelf} is `null`: neither a node nor a task
 * conversation, so the task part registers nothing (SPEC-0006, "扩展与通道").
 *
 * @sideEffects none
 * @param flag - The flag's value.
 * @returns Who it is, or `null`.
 */
export function readSelf(flag: string | undefined): TaskSelf | null {
  const parsed = TaskSelf.safeParse(flag === undefined ? undefined : decodeArgument(flag));
  return parsed.success ? parsed.data : null;
}

/** A request id: a tool call's id, or `n<number>` (ADR-0013, point 4). */
const RequestId = z.string().min(1).max(256);

/**
 * The arguments of `node_done`, as the extension sends them to the host.
 *
 * @remarks
 * The host validates them (SPEC-0006, "结束" step 1): `ok: true` needs a non-empty `summary`,
 * `ok: false` a non-empty `reason`; if not, it answers `task_args_invalid` with `params.field`.
 * The extension only limits the length and fills a missing `summary` with the empty string.
 */
export const NodeDoneArgs = z.strictObject({
  /** `true`: the step is done; `false`: the node gives up (the failure `gave_up`). */
  ok: z.boolean(),
  /** The handoff summary the downstream nodes read; empty when `ok` is false and the model wrote none. */
  summary: z.string().max(TASK_TEXT_LIMITS.summary),
  /** Why the node gives up; with `ok: false` only. */
  reason: z.string().max(TASK_TEXT_LIMITS.reason).optional(),
});
export type NodeDoneArgs = z.infer<typeof NodeDoneArgs>;

/** The arguments of `request_graph_change`, as the extension sends them to the host. */
export const GraphChangeArgs = z.strictObject({
  /** Why the graph has to change. */
  reason: z.string().min(1).max(TASK_TEXT_LIMITS.reason),
  /** What the node suggests the graph should become. */
  suggestion: z.string().min(1).max(TASK_TEXT_LIMITS.suggestion),
});
export type GraphChangeArgs = z.infer<typeof GraphChangeArgs>;

/** The longest the parts of a requirement summary may be (the conversation writes them; SPEC-0002's sizes). */
const SUMMARY_LIMITS = { goal: 8000, item: 2000, items: 50 } as const;

/** A list of short statements of a requirement summary. */
const SummaryList = z.array(z.string().max(SUMMARY_LIMITS.item)).max(SUMMARY_LIMITS.items);

/** The requirement summary, as the task conversation writes it (SPEC-0006, "数据 · task.json"). */
export const SummaryArgs = z.strictObject({
  goal: z.string().min(1).max(SUMMARY_LIMITS.goal),
  decisions: SummaryList,
  constraints: SummaryList,
  nonGoals: SummaryList,
  openQuestions: SummaryList,
  acceptance: SummaryList,
});
export type SummaryArgs = z.infer<typeof SummaryArgs>;

/** A page number of a long text, from 1. */
const PageNumber = z.number().int().min(1).max(10_000).optional();

/** The most nodes and edges a proposed graph may carry through the channel (the host's rules are narrower). */
const GRAPH_LIMITS = { nodes: 40, edges: 200 } as const;

/** What each call carries: its tool's parameters, after the extension has read them. */
export const CallArgs = {
  /** The node says its step is finished, or that it gives up. */
  node_done: NodeDoneArgs,
  /** The node asks for the graph to change. */
  request_graph_change: GraphChangeArgs,
  /** The task conversation reads the conversation the task was made from. */
  task_read_source: z.strictObject({ page: PageNumber }),
  /** It writes the requirement summary. */
  task_set_summary: z.strictObject({ summary: SummaryArgs }),
  /** It renames the task or changes its model. */
  task_set_meta: z.strictObject({
    name: z.string().min(1).max(200).optional(),
    model: z
      .strictObject({
        providerId: z.string().min(1).max(200),
        modelId: z.string().min(1).max(200),
        thinking: ThinkingLevel.optional(),
      })
      .optional(),
  }),
  /** It asks how the task stands. */
  task_status: z.strictObject({}),
  /** It reads a node's contract, hand-over summary or conversation. */
  task_read_node: z.strictObject({
    id: z.string().min(1).max(64),
    what: z.enum(["contract", "summary", "transcript"]),
    page: PageNumber,
  }),
  /** It reads the worktree's changes. */
  task_diff: z.strictObject({ since: z.string().min(1).max(64).optional() }),
  /** It proposes a graph; the host checks the nodes and edges with its own schema. */
  task_propose_graph: z.strictObject({
    nodes: z.array(z.unknown()).min(1).max(GRAPH_LIMITS.nodes),
    edges: z.array(z.unknown()).max(GRAPH_LIMITS.edges),
    note: z.string().max(TASK_TEXT_LIMITS.reason),
    guide: GuideId.optional(),
  }),
  /** It passes a word on to a running node. */
  task_send_to_node: z.strictObject({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(TASK_TEXT_LIMITS.resume),
  }),
} as const;

/** The calls the extension makes. */
export type TaskCallOp = keyof typeof CallArgs;

/** The calls of a node's session. */
export type NodeOp = (typeof NODE_TOOLS)[number];

/** What the extension sends the host that wants no answer (ADR-0013, points 6–8). */
const NoteArgs = {
  /** The tool was stopped and no longer waits: the host drops the call and sends no reply. */
  cancel: z.strictObject({ id: RequestId }),
} as const;

/** The notes the extension sends. */
type TaskNoteOp = keyof typeof NoteArgs;

/**
 * A call or a note, as the extension writes it into its status (ADR-0013, point 1).
 *
 * @remarks
 * `id` is the tool call's id for a call, `n<number>` for a note. The same id again is the same
 * request (ADR-0013, point 4); the extension never sends one twice.
 */
export type TaskRequest =
  | {
      readonly [Op in TaskCallOp]: {
        readonly kind: "call";
        readonly id: string;
        readonly op: Op;
        readonly args: z.infer<(typeof CallArgs)[Op]>;
      };
    }[TaskCallOp]
  | {
      readonly [Op in TaskNoteOp]: {
        readonly kind: "note";
        readonly id: string;
        readonly op: Op;
        readonly args: z.infer<(typeof NoteArgs)[Op]>;
      };
    }[TaskNoteOp];

/** The envelope around a request, before its arguments are read. */
const Envelope = z.strictObject({
  v: z.number(),
  id: RequestId,
  kind: z.enum(["call", "note"]),
  op: z.string(),
  args: z.unknown(),
});

/** Each call's arguments by its name, for a name read off the channel. */
const CALL_SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map(Object.entries(CallArgs));

/** Each note's arguments by its name. */
const NOTE_SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map(Object.entries(NoteArgs));

/**
 * Reads a request from the text of an `atrium-task:` status (the host's side).
 *
 * @remarks
 * Anything that is not a version 1 envelope with a known operation and its arguments is a bad
 * request; the id comes back when there is one, so the host can answer a call `task_bad_request`
 * (ADR-0013, point 9). A status text longer than the envelope limit is bad too.
 *
 * @sideEffects none
 * @param status - The status's text.
 * @returns The request, or the id of a bad one (`null` when none could be read) and what it was.
 */
export function readRequest(
  status: string,
): { readonly request: TaskRequest } | { readonly bad: string | null; readonly kind: "call" | "note" | null } {
  let value: unknown;
  try {
    value = status.length > TASK_ENVELOPE_LIMIT ? undefined : JSON.parse(status);
  } catch {
    // Not JSON: a bad request without an id.
  }
  const envelope = Envelope.safeParse(value);
  if (!envelope.success) return { bad: null, kind: null };
  const { v, id, kind, op, args } = envelope.data;
  const schema = (kind === "call" ? CALL_SCHEMAS : NOTE_SCHEMAS).get(op);
  const parsed = v === 1 && schema !== undefined ? schema.safeParse(args) : null;
  if (parsed === null || !parsed.success) return { bad: id, kind };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the operation's own schema read the arguments.
  return { request: { kind, id, op, args: parsed.data } as TaskRequest };
}

/**
 * Writes a request as the text of its status (the extension's side).
 *
 * @remarks
 * See {@link readRequest}.
 *
 * @sideEffects none
 * @param request - The request.
 * @returns The text.
 */
export function writeRequest(request: TaskRequest): string {
  return JSON.stringify({ v: 1, ...request });
}

/** The tools the task conversation calls, by name. */
export type ConversationOp = (typeof CONVERSATION_TOOLS)[number];

/**
 * The error codes the host answers a call with; the extension words them for the model.
 *
 * @remarks
 * `task_caller_invalid` is SPEC-0006's: the session is not the one the tool is for (not the node's
 * latest run, or the node is not `running`). `task_not_found` and `task_state_invalid` are SPEC-0006's
 * too, for the host to use when it knows better. The rest are the channel's own (the SPEC lists no
 * codes for it): `task_args_invalid` for what the host's validation refused (`params.field` names
 * `summary`, `reason` or `suggestion`), `task_text_too_long` (`params.param`, `params.limit`; the
 * extension answers it itself), `task_bad_request` for an envelope the host could not read, and
 * `task_failed` for anything else that went wrong on the host's side. `task_graph_invalid` is SPEC-0006's,
 * for a proposed graph the validator refused (`params.code` is the first problem's code, `params.node` the node
 * it is about when there is one).
 */
export const TaskErrorCode = z.enum([
  "task_caller_invalid",
  "task_graph_invalid",
  "task_not_found",
  "task_state_invalid",
  "task_args_invalid",
  "task_text_too_long",
  "task_bad_request",
  "task_failed",
]);
export type TaskErrorCode = z.infer<typeof TaskErrorCode>;

/**
 * What the host answers each call with when it accepts it.
 *
 * @remarks
 * Both tools answer `{ recorded: true }`: for `node_done`, the call is now the node's pending
 * settlement; for `request_graph_change`, the request is noted. The extension then ends the turn
 * (`terminate: true`).
 */
export const TaskCallResults = {
  node_done: z.strictObject({ recorded: z.literal(true) }),
  request_graph_change: z.strictObject({ recorded: z.literal(true) }),
  task_read_source: z.strictObject({ text: z.string(), page: z.number().int(), pages: z.number().int() }),
  task_set_summary: z.strictObject({ recorded: z.literal(true) }),
  task_set_meta: z.strictObject({ recorded: z.literal(true) }),
  task_status: z.strictObject({ text: z.string() }),
  task_read_node: z.strictObject({ text: z.string(), page: z.number().int(), pages: z.number().int() }),
  task_diff: z.strictObject({ text: z.string() }),
  task_propose_graph: z.strictObject({ version: z.number().int(), pending: z.boolean() }),
  task_send_to_node: z.strictObject({ recorded: z.literal(true) }),
} as const satisfies Record<TaskCallOp, z.ZodType>;

/** The host's answer to a call (ADR-0013, point 2, `reply`). */
export type TaskReply =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly code: TaskErrorCode;
      readonly params?: Readonly<Record<string, unknown>> | undefined;
    };

/** What `/atrium-task reply` carries. */
export const ReplyCommand = z.union([
  z.strictObject({ v: z.literal(1), id: RequestId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    v: z.literal(1),
    id: RequestId,
    ok: z.literal(false),
    code: TaskErrorCode,
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type ReplyCommand = z.infer<typeof ReplyCommand>;

/**
 * What `/atrium-task nudge` carries: the host asks the node to call `node_done` (the `no_done` rule).
 *
 * @remarks
 * The host sends it after a normal end of a turn with no settled `node_done`, once per node run
 * (`nudged`). The extension writes the reminder itself (the host produces no text for the model,
 * ADR-0013, point 9) and starts a new turn with it (`sendMessage(…, { triggerTurn: true })`; a
 * follow-up would only queue in an idle pi). `id` makes it idempotent: the same id twice, also
 * across a pi restart, starts one turn.
 */
export const NudgeCommand = z.strictObject({ v: z.literal(1), id: RequestId });
export type NudgeCommand = z.infer<typeof NudgeCommand>;

/**
 * Why the host resumes a session (SPEC-0006's `resume_node` and `wake_task_conversation`).
 *
 * @remarks
 * - `continue`: the node goes on after a stop, a hold, a re-run or the user's "继续";
 * - `restarted`: the host restarted (SPEC-0006, "宿主重启");
 * - `graph_changed`: the graph change was approved (the text carries the new contract);
 * - `graph_rejected`: it was rejected;
 * - `wake`: the task conversation's agent is woken for a node's `request_graph_change`.
 */
export const ResumeKind = z.enum(["continue", "restarted", "graph_changed", "graph_rejected", "wake"]);
export type ResumeKind = z.infer<typeof ResumeKind>;

/**
 * What `/atrium-task resume` carries: words that start a new turn in the session.
 *
 * @remarks
 * The host composes `text` (SPEC-0006's `resume_node` text; it holds the new contract after a graph
 * change, with any foreign text already quoted and escaped by the host, ADR-0013, point 10). The
 * extension only puts a note-from-Atrium shell around it, escaping its own shell tags inside, and
 * sends it with `triggerTurn: true`. `id` is idempotent like {@link NudgeCommand}'s.
 */
export const ResumeCommand = z.strictObject({
  v: z.literal(1),
  id: RequestId,
  kind: ResumeKind,
  text: z.string().min(1).max(TASK_TEXT_LIMITS.resume),
});
export type ResumeCommand = z.infer<typeof ResumeCommand>;

/**
 * What `/atrium-task progress` carries: a line for the task conversation, written without a turn.
 *
 * @remarks
 * SPEC-0006, "任务对话 · 进度行": a `custom_message` with `details.kind: "progress"`, the line's
 * id (deduplicated by it, also across a restart) and its time. It never calls the model. Meant for
 * the task conversation's session.
 */
export const ProgressCommand = z.strictObject({
  v: z.literal(1),
  /** The line's id. */
  id: RequestId,
  /** When the host wrote the line, in epoch milliseconds. */
  at: z.number().int().nonnegative(),
  /** The line, as the transcript shows it; the host composes it, the model never sees it as an instruction. */
  text: z.string().min(1).max(TASK_TEXT_LIMITS.progress),
  /** What happened, as the scheduler names it (`node_started`, `merged`…), for the UI to word. */
  what: z.string().min(1).max(64).optional(),
  /** The node it is about, if any. */
  node: z.string().min(1).max(64).optional(),
});
export type ProgressCommand = z.infer<typeof ProgressCommand>;

/**
 * What `/atrium-task mark` carries: a line for the conversation a task was made from (SPEC-0006, "/task 与创建").
 *
 * @remarks
 * The source conversation is an ordinary session without the task flag, so this is the one action every
 * session takes. `converted` says the conversation became task `taskId`; `abandoned` that the task was dropped
 * while designing. A session file only grows, so the second line does not replace the first: the UI shows the
 * latest line for the task id. It never calls the model.
 */
export const MarkCommand = z.strictObject({
  v: z.literal(1),
  id: RequestId,
  at: z.number().int().nonnegative(),
  taskId: z.string().min(1).max(128),
  state: z.enum(["converted", "abandoned"]),
});
export type MarkCommand = z.infer<typeof MarkCommand>;

/**
 * What `/atrium-task review` carries: the record of a review whose verdict took effect (ADR-0017, decision 2).
 *
 * @remarks
 * The extension writes it as a custom message of type `atrium-review` (`display: true`, no turn), so the model
 * reads it on its next request and the transcript shows a step on the process rail. `text` is the line the model
 * reads, composed by the host from codes and parameters (the host writes no prose for people); `review` is the
 * snapshot the UI draws the step from. `id` makes it idempotent like the other commands'.
 */
export const ReviewCommand = z.strictObject({
  v: z.literal(1),
  id: RequestId,
  at: z.number().int().nonnegative(),
  text: z.string().min(1).max(TASK_TEXT_LIMITS.review),
  review: ReviewRecord,
});
export type ReviewCommand = z.infer<typeof ReviewCommand>;

/** What the `details` of an `atrium-review` custom message keep: the record, with the time and the command's id. */
export const ReviewMessageDetails = z.strictObject({
  v: z.literal(1),
  kind: z.literal("review"),
  id: RequestId,
  at: z.number().int().nonnegative(),
  review: ReviewRecord,
});
export type ReviewMessageDetails = z.infer<typeof ReviewMessageDetails>;

/** What the `details` of a `atrium-task` custom message keep, for the transcript and for the host's checks. */
export const TaskMessageDetails = z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), kind: z.literal("nudge"), id: RequestId }),
  z.strictObject({ v: z.literal(1), kind: z.literal("resume"), id: RequestId, reason: ResumeKind }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("progress"),
    id: RequestId,
    at: z.number().int().nonnegative(),
    text: z.string(),
    what: z.string().optional(),
    node: z.string().optional(),
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("converted"),
    id: RequestId,
    at: z.number().int().nonnegative(),
    taskId: z.string(),
    state: z.enum(["converted", "abandoned"]),
  }),
]);
export type TaskMessageDetails = z.infer<typeof TaskMessageDetails>;

/** The `/atrium-task` actions the host sends, with the schema of each argument. */
export const TASK_COMMANDS = {
  reply: ReplyCommand,
  nudge: NudgeCommand,
  resume: ResumeCommand,
  progress: ProgressCommand,
  mark: MarkCommand,
  review: ReviewCommand,
} as const;

/** An action of `/atrium-task`. */
export type TaskCommandAction = keyof typeof TASK_COMMANDS;

/**
 * Writes the text of an `/atrium-task` command (the host's side).
 *
 * @remarks
 * `/atrium-task <action> <base64url JSON>`; the JSON has `v: 1` and the action's fields. Not
 * checked against the schema here: the extension checks what it reads and ignores the rest.
 *
 * @sideEffects none
 * @param action - The action.
 * @param argument - The action's argument, with `v: 1`.
 * @returns The message text to send pi as a prompt.
 */
export function commandText(action: TaskCommandAction, argument: unknown): string {
  return `/${TASK_COMMAND} ${action} ${Buffer.from(JSON.stringify(argument)).toString("base64url")}`;
}
