import {
  AgentEventKind,
  AgentRole,
  type AgentStatus,
  AskedQuestion,
  QUESTION_LIMITS,
  ThinkingLevel,
} from "@atrium/protocol";
import type { AskUserResult } from "./ask-user";
import { z } from "zod";

/** The status key prefix the extension asks the host on: `atrium-agent:<request id>` (ADR-0013, point 1). */
export const AGENT_STATUS = "atrium-agent";

/** The flag the host gives the extension who it is with: `--atrium-agent=<base64url JSON>` (ADR-0013, point 3). */
export const AGENT_FLAG = "atrium-agent";

/** The most an envelope or a command's argument holds before it is encoded (ADR-0013, point 9). */
export const ENVELOPE_LIMIT = 1024 * 1024;

/** The most of a reply a notice or a tool's result carries (SPEC-0002, "送达"). */
export const REPLY_LIMIT = 4000;

/** The longest each piece of text the tools take may be (SPEC-0002's tables; ADR-0013, point 9). */
export const TEXT_LIMITS = { task: 32_000, message: 32_000, answer: 8000, question: 4000, progress: 2000 } as const;

/** The most `agent_read` reads at once: characters of a reply, or steps (SPEC-0002, `agent_read`). */
export const READ_LIMITS = { reply: 16_000, steps: 50 } as const;

/** A handle: what the main agent names a child with, and addresses it by (SPEC-0002, "句柄与显示名"). */
export const HANDLE = /^[a-z][a-z0-9-]{0,39}$/u;

/** The events after which a task has no more to say. */
export const FINAL_EVENTS: readonly AgentEventKind[] = ["finished", "failed", "stopped", "ended"];

/** The error codes the host answers a call with; the extension words them (SPEC-0002, "错误码"). */
export const AgentErrorCode = z.enum([
  "agent_limit",
  "agent_depth_limit",
  "agent_not_allowed",
  "agent_gone",
  "agent_handed_off",
  "agent_busy",
  "agent_name_taken",
  "agent_name_invalid",
  "agent_role_not_allowed",
  "agent_place_invalid",
  "agent_place_failed",
  "agent_model_unknown",
  "agent_thinking_invalid",
  "agent_context_unavailable",
  "agent_question_closed",
  "agent_question_open",
  "agent_text_too_long",
  "agent_bad_request",
  /** `ask_user` from a child the agent opened, which asks its parent instead (SPEC-0003). */
  "ask_user_unavailable",
  "agent_failed",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;

/** A request id: a tool call's id, or `n<number>` (ADR-0013, point 4). */
const RequestId = z.string().min(1).max(256);

/** Who addresses a child: its handle, or `id:<session id>` (SPEC-0002, "句柄与显示名"). */
const To = z.string().min(1).max(256);

/**
 * A piece of text no longer than its limit, as the host checks it again.
 *
 * @remarks
 * The extension checks first and answers `agent_text_too_long` (ADR-0013, point 9); what reaches
 * the host longer than that was not sent by Atrium's extension, and is a bad request.
 *
 * @sideEffects none
 * @param limit - The limit.
 * @returns The schema.
 */
function text(limit: number) {
  return z.string().min(1).max(limit);
}

/** What each call carries: its tool's parameters, checked by the tool's schema (ADR-0013, point 8). */
const CallArgs = {
  spawn: z.strictObject({
    name: z.string().min(1).max(256),
    task: text(TEXT_LIMITS.task),
    role: AgentRole.optional(),
    context: z.enum(["none", "fork"]).optional(),
    place: z.enum(["same", "worktree"]).optional(),
    model: z.string().min(1).max(256).optional(),
    thinking: ThinkingLevel.optional(),
    /** The branch the extension cut, in the directory `branch` gave it, when `context` is `fork`. */
    branch: z.string().min(1).max(4096).optional(),
  }),
  send: z.strictObject({
    to: To,
    message: text(TEXT_LIMITS.message),
  }),
  reply: z.strictObject({ to: To, questionId: RequestId, answer: text(TEXT_LIMITS.answer) }),
  list: z.strictObject({ includeEnded: z.boolean().optional() }),
  read: z
    .strictObject({
      to: To,
      taskId: z.string().min(1).max(256).optional(),
      what: z.enum(["reply", "steps"]).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(READ_LIMITS.reply).optional(),
    })
    // A reply's limit counts characters, up to 16000; steps' counts steps, up to 50 (SPEC-0002, `agent_read`).
    .refine((args) => args.what !== "steps" || args.limit === undefined || args.limit <= READ_LIMITS.steps),
  stop: z.strictObject({ to: To }),
  models: z.strictObject({}),
  ask: z.strictObject({
    question: text(TEXT_LIMITS.question),
    options: z.array(z.string().min(1).max(500)).max(6).optional(),
    timeoutSeconds: z.number().int().min(60).max(3600).optional(),
  }),
  branch: z.strictObject({}),
  /** `ask_user`'s questions, as the extension read them (SPEC-0003, "接口与数据"). */
  ask_user: z.strictObject({
    questions: z
      .array(AskedQuestion)
      .min(1)
      .max(QUESTION_LIMITS.questions)
      // As the extension read them: names distinct, previews only on single choices (SPEC-0003, "工具").
      .refine((questions) => new Set(questions.map((one) => one.header)).size === questions.length)
      .refine((questions) =>
        questions.every(
          (one) =>
            new Set(one.options.map((option) => option.label)).size === one.options.length &&
            (!one.multiSelect || one.options.every((option) => option.preview === null)),
        ),
      ),
  }),
} as const;

/** The calls the extension makes. */
export type CallOp = keyof typeof CallArgs;

/** What each note carries (ADR-0013, points 6–8). */
const NoteArgs = {
  progress: z.strictObject({ message: text(TEXT_LIMITS.progress) }),
  cancel: z.strictObject({ id: RequestId }),
  answered: z.strictObject({ id: RequestId }),
  closed: z.strictObject({ id: RequestId }),
} as const;

/** The notes the extension sends. */
export type NoteOp = keyof typeof NoteArgs;

/** A call or a note, as the extension writes it into its status (ADR-0013, point 1). */
export type AgentRequest =
  | {
      readonly [Op in CallOp]: {
        readonly kind: "call";
        readonly id: string;
        readonly op: Op;
        readonly args: z.infer<(typeof CallArgs)[Op]>;
      };
    }[CallOp]
  | {
      readonly [Op in NoteOp]: {
        readonly kind: "note";
        readonly id: string;
        readonly op: Op;
        readonly args: z.infer<(typeof NoteArgs)[Op]>;
      };
    }[NoteOp];

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
 * Reads a request from the text of an `atrium-agent:` status.
 *
 * @remarks
 * ADR-0013, point 9: anything that is not a version 1 envelope with a known operation and its
 * arguments is a bad request; the id comes back when there is one, so a call can be answered
 * `agent_bad_request`.
 *
 * @sideEffects none
 * @param status - The status's text.
 * @returns The request, or the id of a bad one (`null` when none could be read).
 */
export function readRequest(
  status: string,
): { readonly request: AgentRequest } | { readonly bad: string | null; readonly kind: "call" | "note" | null } {
  let value: unknown;
  try {
    value = status.length > ENVELOPE_LIMIT ? undefined : JSON.parse(status);
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
  return { request: { kind, id, op, args: parsed.data } as AgentRequest };
}

/**
 * Writes a request as the text of its status.
 *
 * @remarks
 * See `readRequest`.
 *
 * @sideEffects none
 * @param request - The request.
 * @returns The text.
 */
export function writeRequest(request: AgentRequest): string {
  return JSON.stringify({ v: 1, ...request });
}

/** The host's answer to a call (ADR-0013, point 2, `reply`). */
export type AgentReply =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly code: AgentErrorCode;
      readonly params?: Readonly<Record<string, unknown>> | undefined;
    };

/** What the extension reads of `reply`; the result is the host's, written in the same bundle. */
const ReplyCommand = z.union([
  z.strictObject({ v: z.literal(1), id: RequestId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    v: z.literal(1),
    id: RequestId,
    ok: z.literal(false),
    code: AgentErrorCode,
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);

/**
 * Reads the argument of `/atrium-agent reply`.
 *
 * @remarks
 * Anything else does nothing (ADR-0013, point 7).
 *
 * @sideEffects none
 * @param value - The decoded argument.
 * @returns The reply, or `null`.
 */
export function readReply(value: unknown): AgentReply | null {
  const parsed = ReplyCommand.safeParse(value);
  if (!parsed.success) return null;
  const { v: _v, ...reply } = parsed.data;
  return reply;
}

/** Why the host closed a question it was asked (SPEC-0002, `ask_parent`). */
export const CancelReason = z.enum(["detached", "archived", "handed_off", "reply_failed"]);
export type CancelReason = z.infer<typeof CancelReason>;

/** What `/atrium-agent cancel` carries (ADR-0013, point 2). */
const CancelCommand = z.strictObject({ v: z.literal(1), id: RequestId, reason: CancelReason });

/**
 * Reads the argument of `/atrium-agent cancel`.
 *
 * @remarks
 * See `readReply`.
 *
 * @sideEffects none
 * @param value - The decoded argument.
 * @returns The id and why, or `null`.
 */
export function readCancel(value: unknown): { readonly id: string; readonly reason: CancelReason } | null {
  const parsed = CancelCommand.safeParse(value);
  return parsed.success ? { id: parsed.data.id, reason: parsed.data.reason } : null;
}

/** A reply's text, cut to {@link REPLY_LIMIT}, with how long it was. */
const Reply = z.strictObject({ text: z.string(), totalChars: z.number().int().nonnegative() });

/** One thing that happened to a task, as the parent is told it (SPEC-0002, "通知父会话的事件"). */
export const AgentEvent = z.strictObject({
  /** The child's handle. */
  name: z.string(),
  /** Its display name. */
  title: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  event: AgentEventKind,
  /** Why it stopped or ended. */
  reason: z.string().optional(),
  /** The task this one follows up, when a grandchild's notice opened its turn after that one ended. */
  followUpOf: z.string().optional(),
  /** How long the task took, until this event. */
  elapsedMs: z.number().int().nonnegative().optional(),
  reply: Reply.optional(),
  questionId: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  /** A `work` child's place, with its delivery (SPEC-0002, "交付"). */
  branch: z.string().optional(),
  workspace: z.string().optional(),
  changes: z.strictObject({ files: z.number().int(), added: z.number().int(), removed: z.number().int() }).optional(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

/** A child's latest progress, not yet passed on (SPEC-0002, `report_progress`). */
export const AgentProgress = z.strictObject({ name: z.string(), title: z.string(), message: z.string() });
export type AgentProgress = z.infer<typeof AgentProgress>;

/** What a child's first task tells it about itself (SPEC-0002, "子对话的角色说明放在第一件事的消息里"). */
export const TaskPreamble = z.strictObject({
  role: AgentRole,
  /** It carries its parent's conversation, cut at the parent's call. */
  forked: z.boolean(),
  /** It may open children of its own. */
  canSpawn: z.boolean(),
  /** Where it works, for a `work` child in its own worktree. */
  workspace: z.string().optional(),
});
export type TaskPreamble = z.infer<typeof TaskPreamble>;

/** What `/atrium-agent deliver` carries: notices up, or a task down (SPEC-0002, "送达"). */
export const Delivery = z.discriminatedUnion("kind", [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("report"),
    deliveries: z.array(z.string().min(1)).min(1),
    events: z.array(AgentEvent),
    progress: z.array(AgentProgress),
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("task"),
    deliveries: z.array(z.string().min(1)).min(1),
    /** Who it comes from: the parent's handle, or `main`. */
    from: z.string(),
    /** The parent's display name. */
    fromTitle: z.string(),
    taskId: z.string(),
    text: text(TEXT_LIMITS.message),
    /** Only with a child's first task. */
    preamble: TaskPreamble.optional(),
    /** Words for the task in hand, not a new task (SPEC-0002, `agent_send`). */
    steer: z.literal(true).optional(),
  }),
]);
export type Delivery = z.infer<typeof Delivery>;

/** One event an `atrium-agent` report message keeps for the transcript: no reply, which the content has. */
export const ReportDetail = AgentEvent.omit({ reply: true, options: true });
export type ReportDetail = z.infer<typeof ReportDetail>;

/** What an `atrium-agent` custom message keeps in `details`, never shown to the model (ADR-0013, point 10). */
export const MessageDetails = z.discriminatedUnion("kind", [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("report"),
    deliveries: z.array(z.string()),
    events: z.array(ReportDetail),
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("task"),
    deliveries: z.array(z.string()),
    from: z.string(),
    fromTitle: z.string(),
    taskId: z.string(),
    text: z.string(),
    /** Words for the task in hand, which its run took in (SPEC-0002, `agent_send`). */
    steer: z.literal(true).optional(),
  }),
]);
export type MessageDetails = z.infer<typeof MessageDetails>;

/** Who the extension is, as the host's flag says (ADR-0013, point 3). */
export const AgentSelf = z.strictObject({
  v: z.literal(1),
  /** The agent opened it: it has `report_progress` and `ask_parent`. */
  child: z.boolean(),
  role: AgentRole.nullable(),
  /** Its agent depth; at 2 it has none of the main agent's tools. */
  depth: z.number().int().nonnegative(),
  /** Where its tools are limited: pi's flags, or the extension's `tool_call` hook. */
  guard: z.enum(["flags", "extension"]),
});
export type AgentSelf = z.infer<typeof AgentSelf>;

/** A child as `agent_spawn` answers it (SPEC-0002, `agent_spawn`). */
export interface SpawnResult {
  readonly name: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly role: AgentRole;
  readonly place: "same" | "worktree";
  readonly workspace?: string;
  readonly branch?: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly status: AgentStatus;
}

/** What `agent_send` answers. */
interface SendResult {
  readonly to: string;
  readonly sessionId: string;
  readonly taskId: string;
  /** It waits for the child's run in progress to end. */
  readonly queued: boolean;
  /** It went into the task in hand, `taskId`, not a new one (SPEC-0002, `agent_send`). */
  readonly steered: boolean;
}

/** One child as `agent_list` answers it. */
export interface ListedChild {
  readonly name: string;
  readonly title: string;
  readonly sessionId: string;
  readonly role: AgentRole | null;
  readonly status: AgentStatus;
  readonly place: "same" | "worktree";
  readonly branch?: string;
  readonly model: string | null;
  readonly thinking: ThinkingLevel | null;
  readonly updatedAt: number;
  readonly openTasks: readonly string[];
  readonly lastProgress?: string;
}

/** What `agent_read` answers. */
export type ReadResult =
  | { readonly text: string; readonly totalChars: number; readonly nextOffset: number | null }
  | { readonly text: null; readonly reason: "no_reply_yet" }
  | { readonly steps: readonly { readonly title: string; readonly status: "done" | "failed" | "running" }[] };

/** What `agent_stop` answers. */
interface StopResult {
  readonly to: string;
  readonly sessionId: string;
  readonly previousStatus: AgentStatus;
  /** The handles of the children stopped with it. */
  readonly stopped: readonly string[];
}

/** One model as `agent_models` answers it. */
interface ListedModel {
  readonly id: string;
  readonly name: string;
  readonly thinking: readonly ThinkingLevel[];
  readonly current?: true;
}

/** What `ask_parent` answers (SPEC-0002, `ask_parent`). */
export type AskResult =
  | { readonly answered: true; readonly answer: string }
  | {
      readonly answered: false;
      readonly reason: "timeout" | "aborted" | "user_turn" | CancelReason;
    };

/** What `agent_reply` answers. */
interface ReplyResult {
  readonly delivered: true | "unknown";
}

/** What each call is answered with. */
export interface CallResults {
  readonly spawn: SpawnResult;
  readonly send: SendResult;
  readonly reply: ReplyResult;
  readonly list: { readonly children: readonly ListedChild[] };
  readonly read: ReadResult;
  readonly stop: StopResult;
  readonly models: { readonly models: readonly ListedModel[] };
  readonly ask: AskResult;
  readonly branch: { readonly dir: string };
  readonly ask_user: AskUserResult;
}
