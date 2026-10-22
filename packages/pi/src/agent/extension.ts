import { AGENT_COMMAND, AGENT_MESSAGE, agentNote, decodeArgument, noteText } from "./agent";
import { ASK_USER_STOPPED, ASK_USER_TOOL, type AskUserResult, answerText, checkQuestions } from "./ask-user";
import {
  AGENT_FLAG,
  AGENT_STATUS,
  type AgentErrorCode,
  type AgentReply,
  AgentSelf,
  type AskResult,
  type CallOp,
  type CallResults,
  Delivery,
  MessageDetails,
  type NoteOp,
  READ_LIMITS,
  TEXT_LIMITS,
  readCancel,
  readReply,
  writeRequest,
} from "./channel";
import {
  CHILD_TOOLS,
  PARENT_TOOLS,
  PREAMBLE_OPEN,
  READ_ONLY_TOOLS,
  SUB_AGENT_ASKS_PARENT,
  askText,
  errorText,
  reportText,
  resultText,
  taskText,
} from "./words";

/** pi's one-way status line, which the extension asks the host on (ADR-0013, point 1). */
interface StatusLine {
  setStatus(key: string, text: string | undefined): void;
}

/** One of pi's session entries, as the extension reads it. */
export interface SessionEntryView {
  readonly type: string;
}

/** The part of pi's session the extension reads: where it is written, where it is now, and its entries. */
export interface SessionView {
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getBranch(): readonly SessionEntryView[];
}

/** The part of a tool's or a hook's context the extension uses. */
interface AgentContext {
  readonly ui: StatusLine;
  readonly sessionManager: SessionView;
}

/** A tool's result, as pi takes it. */
interface ToolResult {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: unknown;
  readonly isError?: boolean;
}

/** A tool, as the extension registers it with pi; its parameters are plain JSON Schema. */
interface AgentTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  /** `sequential` runs a batch with this tool one call at a time. */
  readonly executionMode?: "sequential" | "parallel";
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: AgentContext,
  ): Promise<ToolResult>;
}

/** The part of pi's extension API child conversations use; its test checks pi's `ExtensionAPI` fits it. */
export interface AgentApi {
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, ctx: { readonly ui: StatusLine; isIdle(): boolean }) => Promise<void>;
    },
  ): void;
  sendMessage(
    message: {
      readonly customType: string;
      readonly content: string;
      readonly display: boolean;
      readonly details: unknown;
    },
    options?: { readonly triggerTurn?: boolean; readonly deliverAs?: "steer" },
  ): void;
  registerTool(tool: AgentTool): void;
  registerFlag(name: string, options: { readonly description: string; readonly type: "string" }): void;
  getFlag(name: string): boolean | string | undefined;
  on(
    event: "tool_call",
    handler: (
      event: { readonly toolName: string; readonly toolCallId: string; readonly input: unknown },
      ctx: AgentContext,
    ) => { block: true; reason: string } | undefined,
  ): unknown;
  on(
    event: "turn_end",
    handler: (event: { readonly message: unknown }, ctx: { readonly signal: AbortSignal | undefined }) => void,
  ): unknown;
  on(event: "agent_end", handler: (event: { readonly messages: readonly unknown[] }) => void): unknown;
  on(event: "message_start", handler: (event: { readonly message: unknown }) => void): unknown;
}

/** How many delivery ids the extension remembers handing pi, so one sent again goes once. */
const HANDED_KEPT = 256;

/** What the extension needs besides pi: timers, and how to cut a branch, which tests replace. */
export interface AgentDeps {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * Cuts the session at `leaf` into a new file in `dir`, as pi's `SessionManager.open(file,
   * dir).createBranchedSession(leaf)` does; the path, or `undefined` when pi wrote none.
   */
  branch(session: SessionView, file: string, dir: string, leaf: string): string | undefined;
}

/** How long `ask_parent` waits by default, in seconds (SPEC-0002, `ask_parent`). */
const ASK_TIMEOUT_S = 600;

/** How many closed questions are kept, so a repeated answer is confirmed again (SPEC-0002, `agent_reply`). */
const CLOSED_KEPT = 64;

/**
 * Cuts a branch with the class of pi's own session manager.
 *
 * @remarks
 * The extension is bundled without pi (overview.md, "Atrium 自带的 pi 扩展"), so the class comes
 * from the session the tool was given; the contract test `agent-fork` runs it in real pi.
 *
 * @sideEffects Writes the branch's session file.
 * @param session - The tool's session.
 * @param file - The session's file.
 * @param dir - Where to write the branch.
 * @param leaf - The entry to cut at.
 * @returns The branch's path, or `undefined`.
 */
export function branchWithPi(session: SessionView, file: string, dir: string, leaf: string): string | undefined {
  const manager: unknown = Reflect.get(session, "constructor");
  const open: unknown = typeof manager === "function" ? Reflect.get(manager, "open") : undefined;
  if (typeof open !== "function") return undefined;
  const opened: unknown = Reflect.apply(open, manager, [file, dir]);
  const cut: unknown =
    typeof opened === "object" && opened !== null ? Reflect.get(opened, "createBranchedSession") : undefined;
  if (typeof cut !== "function") return undefined;
  const path: unknown = Reflect.apply(cut, opened, [leaf]);
  return typeof path === "string" ? path : undefined;
}

/** The deps pi runs the extension with. */
const REAL_DEPS: AgentDeps = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only ever given what setTimeout above returned.
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  branch: branchWithPi,
};

/**
 * A text tool parameter, its limit in the description.
 *
 * @remarks
 * The extension checks the limit, not pi, so the model gets `agent_text_too_long` (ADR-0013, point 9).
 *
 * @sideEffects none
 * @param description - What it is.
 * @param limit - Its limit.
 * @returns The schema.
 */
function textParam(description: string, limit: number): Record<string, unknown> {
  return { type: "string", minLength: 1, description: `${description} At most ${String(limit)} characters.` };
}

/** The `to` parameter. */
const TO = { type: "string", minLength: 1, description: 'The sub-agent: its name (handle), or "id:<session id>".' };

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
function object(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/** What all main-agent tools' descriptions end with (SPEC-0002, "工具说明写明"). */
const PARENT_RULES =
  "Sub-agents' replies are not shown to the user: tell them what matters. Do not poll: with nothing else to do, end your turn, and a notice will wake you. Do not make up results that have not come back. Let only one sub-agent write in a directory at a time.";

/** The main agent's tools: description and parameters (SPEC-0002, "主 agent 用的工具"). */
const PARENT_TOOL_SPECS: Readonly<Record<(typeof PARENT_TOOLS)[number], Omit<AgentTool, "execute" | "name">>> = {
  agent_spawn: {
    label: "Start sub-agent",
    description: `Start a sub-agent: a child conversation that works on a task in parallel and reports back. Good for independent research that can run in parallel, a review by another model, or changes whose files do not overlap; do simple lookups yourself. It runs in the background, and you get a notice when it finishes. ${PARENT_RULES}`,
    promptSnippet: "Start a sub-agent on a task in the background",
    parameters: object(
      {
        name: {
          type: "string",
          description:
            "Its handle, never changed or reused: a lowercase letter then up to 39 lowercase letters, digits or hyphens, like auth-audit.",
        },
        task: textParam("What it should do, with everything it needs.", TEXT_LIMITS.task),
        role: {
          type: "string",
          enum: ["explore", "work", "advise"],
          description:
            "explore: read-only research (default). work: may change files. advise: read-only review, often on another model.",
        },
        context: {
          type: "string",
          enum: ["none", "fork"],
          description: "fork: it starts with this whole conversation so far. Default none.",
        },
        place: {
          type: "string",
          enum: ["same", "worktree"],
          description:
            "worktree: its own new git worktree (work only). Default: worktree for work when possible, else same.",
        },
        model: { type: "string", description: "provider/modelId; default yours. Call agent_models if unsure." },
        thinking: {
          type: "string",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          description: "Thinking level; default yours, adjusted to what the model supports.",
        },
      },
      ["name", "task"],
    ),
  },
  agent_send: {
    label: "Message sub-agent",
    description: `Message one of your sub-agents. While it works on a task you gave it, the message goes into that task once its current tool calls finish; otherwise it starts its next task, with its whole conversation. While it waits for your answer to a question, answer with agent_reply instead. ${PARENT_RULES}`,
    parameters: object({ to: TO, message: textParam("The task.", TEXT_LIMITS.message) }, ["to", "message"]),
  },
  agent_reply: {
    label: "Answer sub-agent",
    description: "Answer a question a sub-agent asked you with ask_parent.",
    parameters: object(
      {
        to: TO,
        questionId: { type: "string", description: "The question's id, from its notice." },
        answer: textParam("Your answer.", TEXT_LIMITS.answer),
      },
      ["to", "questionId", "answer"],
    ),
  },
  agent_list: {
    label: "List sub-agents",
    description: "List your sub-agents, with their status and open tasks.",
    parameters: object({
      includeEnded: { type: "boolean", description: "Also list archived and handed-off ones. Default false." },
    }),
  },
  agent_read: {
    label: "Read sub-agent",
    description: "Read a sub-agent's reply to a task, page by page, or its latest steps.",
    parameters: object(
      {
        to: TO,
        taskId: { type: "string", description: "The task; default its latest." },
        what: { type: "string", enum: ["reply", "steps"], description: "reply (default) or steps." },
        offset: { type: "integer", minimum: 0, description: "For reply: where to start, in characters." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: READ_LIMITS.reply,
          description: `Characters (reply, default 8000) or steps (default 10, at most ${String(READ_LIMITS.steps)}).`,
        },
      },
      ["to"],
    ),
  },
  agent_stop: {
    label: "Stop sub-agent",
    description:
      "Stop a sub-agent's current run, and the running sub-agents it started. Its conversation stays: agent_send gives it more work.",
    parameters: object({ to: TO }, ["to"]),
  },
  agent_models: {
    label: "List models",
    description: "List the models a sub-agent can use, with the thinking levels each supports.",
    parameters: object({}),
  },
};

/** The calls each main-agent tool makes. */
const PARENT_OPS: Readonly<Record<(typeof PARENT_TOOLS)[number], Exclude<CallOp, "ask_user">>> = {
  agent_spawn: "spawn",
  agent_send: "send",
  agent_reply: "reply",
  agent_list: "list",
  agent_read: "read",
  agent_stop: "stop",
  agent_models: "models",
};

/** The text parameters each tool limits, with their limits (ADR-0013, point 9). */
const LIMITED: Readonly<Record<string, readonly (readonly [string, number])[]>> = {
  agent_spawn: [["task", TEXT_LIMITS.task]],
  agent_send: [["message", TEXT_LIMITS.message]],
  agent_reply: [["answer", TEXT_LIMITS.answer]],
  ask_parent: [["question", TEXT_LIMITS.question]],
  report_progress: [["message", TEXT_LIMITS.progress]],
};

/**
 * The first text parameter of a call that is too long.
 *
 * @remarks
 * See `LIMITED`.
 *
 * @sideEffects none
 * @param tool - The tool.
 * @param params - Its parameters.
 * @returns The parameter and its limit, or `null`.
 */
function tooLong(tool: string, params: Readonly<Record<string, unknown>>): { field: string; max: number } | null {
  // Stryker disable next-line ArrayDeclaration: pi passes no parameter the schema leaves out, and a filler's "max" is a letter no length exceeds.
  for (const [field, max] of LIMITED[tool] ?? []) {
    const value = params[field];
    // Stryker disable next-line ConditionalExpression: pi checks against the schema before `execute` that every limited field is there and a string.
    if (typeof value === "string" && value.length > max) return { field, max };
  }
  return null;
}

/**
 * A tool's result: text for the model, and what it came from for the transcript.
 *
 * @remarks
 * pi gives the model only the text (SPEC-0002, "工具").
 *
 * @sideEffects none
 * @param text - The text.
 * @param details - The structured result.
 * @param isError - Whether it failed.
 * @returns The result.
 */
function toolResult(text: string, details: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError } : {}) };
}

/**
 * A failed tool's result.
 *
 * @remarks
 * The extension words the host's code (ADR-0013, point 9).
 *
 * @sideEffects none
 * @param code - The code.
 * @param params - Its parameters.
 * @returns The result.
 */
function failed(code: AgentErrorCode, params?: Readonly<Record<string, unknown>>): ToolResult {
  return toolResult(errorText(code, params), { error: code, ...(params === undefined ? {} : { params }) }, true);
}

/**
 * A stopped tool's result.
 *
 * @remarks
 * pi needs the tool to end as soon as its signal aborts (SPEC-0002, "扩展与宿主的通道").
 *
 * @sideEffects none
 * @returns The result.
 */
function stopped(): ToolResult {
  return toolResult("Stopped.", { stopped: true }, true);
}

/**
 * A value with its object keys sorted, null fields left out and numbers and booleans as text, all
 * the way down.
 *
 * @remarks
 * So two tool inputs compare by content, whatever order the model wrote their keys in. The
 * parent's calls come raw from the history, while the hook gets the input pi checked against the
 * tool's schema, which drops optional nulls and turns `"5"` into `5` or `"true"` into `true`; both
 * sides are read loosely alike, so a redo is caught either way (SPEC-0002, "带上下文的子对话").
 *
 * @sideEffects none
 * @param value - The value.
 * @returns The sorted copy.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Stryker disable next-line ConditionalExpression: null fields are left out below before their values are read, and pi's input is an object.
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => Reflect.get(value, key) !== null)
      .toSorted()
      .map((key) => [key, canonical(Reflect.get(value, key))]),
  );
}

/**
 * Whether a session entry is one of Atrium's tasks.
 *
 * @remarks
 * See `parentCalls`.
 *
 * @sideEffects none
 * @param entry - The entry.
 * @returns Whether.
 */
function isTask(entry: SessionEntryView): boolean {
  const details: unknown = Reflect.get(entry, "details");
  return (
    entry.type === "custom_message" &&
    Reflect.get(entry, "customType") === AGENT_MESSAGE &&
    typeof details === "object" &&
    details !== null &&
    Reflect.get(details, "kind") === "task"
  );
}

/**
 * The text of a custom message's content, whether a string or text blocks.
 *
 * @remarks
 * See `opensChild`: pi keeps the content as the extension sent it, a string, but its type allows
 * blocks.
 *
 * @sideEffects none
 * @param entry - The entry.
 * @returns The text; empty when there is none.
 */
function contentText(entry: SessionEntryView): string {
  const content: unknown = Reflect.get(entry, "content");
  if (typeof content === "string") return content;
  // Stryker disable next-line StringLiteral: any text without the preamble's line reads as none does.
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((block) => {
      const text: unknown = typeof block === "object" && block !== null ? Reflect.get(block, "text") : undefined;
      // Stryker disable next-line StringLiteral: as above.
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/**
 * Whether a task is a child's first: the one that opens with the preamble.
 *
 * @remarks
 * Only the first task carries the preamble (SPEC-0002, "子对话的角色说明放在第一件事的消息里"), and
 * `escapeBody` keeps any body from writing its opening line.
 *
 * @sideEffects none
 * @param entry - The task's entry.
 * @returns Whether.
 */
function opensChild(entry: SessionEntryView): boolean {
  return contentText(entry).split("\n").includes(PREAMBLE_OPEN);
}

/**
 * The parent's calls a forked child must not redo, while it works on its first task.
 *
 * @remarks
 * SPEC-0002, "带上下文的子对话（agent 开的）": the parent's batch is the tool calls without a result
 * in the assistant message the branch was cut at, which the child's first task follows; sibling
 * results pi wrote before the cut may lie between. Only the latest task counts: once a later one
 * came, the child is past its first, and nothing is blocked. Older first tasks are its ancestors'
 * (a grandchild's history holds its parent's), and the child's own calls come after the fork, so
 * neither is ever taken for the parent's.
 *
 * @sideEffects none
 * @param branch - The session's entries, root to leaf.
 * @returns The calls, as name and input.
 */
export function parentCalls(branch: readonly SessionEntryView[]): { name: string; input: unknown }[] {
  const at = branch.findLastIndex(isTask);
  const first = branch[at];
  if (first === undefined || !opensChild(first)) return [];
  const answered = new Set<unknown>();
  for (const entry of branch.slice(0, at).toReversed()) {
    if (isTask(entry)) return [];
    if (entry.type !== "message") continue;
    const message: unknown = Reflect.get(entry, "message");
    if (typeof message !== "object" || message === null) return [];
    const role: unknown = Reflect.get(message, "role");
    if (role === "toolResult") {
      answered.add(Reflect.get(message, "toolCallId"));
      continue;
    }
    const content: unknown = Reflect.get(message, "content");
    if (role !== "assistant" || !Array.isArray(content)) return [];
    return (content as unknown[]).flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      Reflect.get(block, "type") === "toolCall" &&
      !answered.has(Reflect.get(block, "id"))
        ? [{ name: String(Reflect.get(block, "name")), input: Reflect.get(block, "arguments") }]
        : [],
    );
  }
  return [];
}

/**
 * Whether a session may call a tool, by who it is.
 *
 * @remarks
 * SPEC-0002, "角色与限制": a read-only role gets `read`, `bash`, `grep`, `find`, `ls` and its
 * own two tools; Bash's read-only use is a behavioral instruction, not a sandbox. `work` gets
 * everything; the main agent's tools only below depth 2; a child's own tools only
 * in a child the agent opened, and `ask_user` only outside one (SPEC-0003). With `guard: "flags"`,
 * pi's own flags already left the rest out.
 *
 * @sideEffects none
 * @param self - Who the session is.
 * @param tool - The tool.
 * @returns Why not, or `null` when it may.
 */
export function refusal(self: AgentSelf, tool: string): string | null {
  const parentTool = (PARENT_TOOLS as readonly string[]).includes(tool);
  const childTool = (CHILD_TOOLS as readonly string[]).includes(tool);
  if (parentTool && self.depth >= 2) return "This sub-agent is too deep to start sub-agents of its own.";
  if (childTool && !self.child) return "Only a sub-agent can use this tool.";
  if (tool === ASK_USER_TOOL && self.child) return SUB_AGENT_ASKS_PARENT;
  if (self.guard !== "extension" || self.role === null || self.role === "work") return null;
  if (parentTool || childTool || (READ_ONLY_TOOLS as readonly string[]).includes(tool)) return null;
  return `This sub-agent is read-only (${self.role}): it can use ${[...READ_ONLY_TOOLS, ...CHILD_TOOLS].join(", ")}${self.depth < 2 ? " and the agent_* tools" : ""}.`;
}

/**
 * Reads who the session is from the host's flag.
 *
 * @remarks
 * ADR-0013, point 3. Without the flag, as in pi started by hand with the extension, it is no one's
 * child, at depth 0, limited by pi's flags.
 *
 * @sideEffects none
 * @param flag - The flag's value.
 * @returns Who it is.
 */
export function selfOf(flag: boolean | string | undefined): AgentSelf {
  // Stryker disable next-line ConditionalExpression: `decodeArgument` reads a boolean, which is not base64url JSON, as nothing too.
  const parsed = AgentSelf.safeParse(typeof flag === "string" ? decodeArgument(flag) : undefined);
  return parsed.success ? parsed.data : { v: 1, child: false, role: null, depth: 0, guard: "flags" };
}

/** A question the child asked (SPEC-0002, `ask_parent`). */
interface Question {
  /** Settles `ask_parent`'s call, once. */
  settle: (result: AskResult) => void;
  /** The answer it took, once answered. */
  answer: string | null;
  open: boolean;
}

/**
 * Registers Atrium's child conversations: the agent tools, `/atrium-agent`, the flag and the tool guard.
 *
 * @remarks
 * SPEC-0002 and ADR-0013. Every tool asks the host over the status line `atrium-agent:<id>` and
 * waits for `/atrium-agent reply`; the host decides, the extension only words its answers and
 * the model's errors. `deliver` writes notices and tasks as `atrium-agent` custom messages, which
 * start a run when pi is idle and steer one in progress; `note` writes the host's note without a
 * run. `ask_parent` keeps its own timer and confirms what it took or closed; a stopped tool tells
 * the host so (`cancel`). The `tool_call` hook limits tools by who the session is, as the host's
 * flag says, and keeps a forked child from redoing its parent's unanswered calls. Anything the
 * extension cannot read does nothing.
 *
 * @sideEffects Registers ten tools, a command, a flag and four hooks with pi; the tools ask the host
 * and the command writes custom messages into the session.
 * @param pi - pi's extension API.
 * @param deps - Timers and branching; tests alone pass other ones.
 */
export default function atriumAgent(pi: AgentApi, deps: AgentDeps = REAL_DEPS): void {
  /** Calls waiting for the host's answer, by request id. */
  const calls = new Map<string, (reply: AgentReply) => void>();
  /** Questions asked, by id: the open ones and the latest closed ones, for a repeated answer. */
  const questions = new Map<string, Question>();
  /** The status line to send notes on, from the latest command or tool. */
  let line: StatusLine | null = null;
  let sequence = 0;
  let self: AgentSelf | null = null;

  pi.registerFlag(AGENT_FLAG, { description: "Who this session is, set by Atrium's host", type: "string" });

  /**
   * Who the session is, read once.
   *
   * @remarks
   * pi sets flags after extensions load, so not at registration.
   *
   * @sideEffects Keeps what it read.
   * @returns Who it is.
   */
  const who = (): AgentSelf => {
    self ??= selfOf(pi.getFlag(AGENT_FLAG));
    return self;
  };

  /**
   * Sends the host a note, which it does not answer.
   *
   * @remarks
   * ADR-0013, points 6–8. Without a status line yet, nothing ran, and there is nothing to tell.
   *
   * @sideEffects Writes and clears a status.
   * @param op - The note.
   * @param args - Its arguments.
   */
  const note = (op: NoteOp, args: Readonly<Record<string, unknown>>): void => {
    // Stryker disable next-line ConditionalExpression: every caller sets the line first; the check only narrows the type.
    if (line === null) return;
    const id = `n${String(++sequence)}`;
    const key = `${AGENT_STATUS}:${id}`;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each caller passes its note's own arguments.
    line.setStatus(key, writeRequest({ kind: "note", id, op, args } as never));
    line.setStatus(key, undefined);
  };

  /**
   * Asks the host and waits for its answer.
   *
   * @remarks
   * ADR-0013: the request id is the tool call's; the status is cleared once answered. A stopped
   * tool answers itself `null` and tells the host it no longer waits. A call its caller ended
   * itself (`ask_parent` closed by its timer or the host) answers `null` too, quietly: the caller
   * already told the host, and stopping the run later must not tell it again.
   *
   * @sideEffects Writes and clears a status; may send a note.
   * @param ui - The tool's status line.
   * @param id - The request id.
   * @param op - The call.
   * @param args - Its arguments.
   * @param signal - The tool's signal.
   * @param ended - Aborted when the caller no longer waits.
   * @returns The answer, or `null` when the tool was stopped or the caller ended it.
   */
  const ask = (
    ui: StatusLine,
    id: string,
    op: CallOp,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    ended?: AbortSignal,
  ): Promise<AgentReply | null> => {
    line = ui;
    const key = `${AGENT_STATUS}:${id}`;
    if (signal?.aborted === true) return Promise.resolve(null);
    return new Promise((resolve) => {
      /**
       * Gives the call up as the tool is stopped.
       *
       * @remarks
       * The host is told to drop it, so no reply comes (ADR-0013).
       *
       * @sideEffects Clears the status; sends `cancel`.
       */
      const aborted = (): void => {
        calls.delete(id);
        ui.setStatus(key, undefined);
        note("cancel", { id });
        resolve(null);
      };
      /**
       * Gives the call up as its caller ended it.
       *
       * @remarks
       * The caller cleared the status and told the host; the tool's signal no longer concerns it.
       * Harmless after the call ended otherwise: the call is gone, and the promise settled.
       *
       * @sideEffects Forgets the call.
       */
      const quiet = (): void => {
        signal?.removeEventListener("abort", aborted);
        calls.delete(id);
        // Stryker disable next-line all: the caller has its answer already; nothing awaits this promise, which only settles so nothing is left pending.
        resolve(null);
      };
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: a signal aborts once, and the listener is removed when the host answers.
      signal?.addEventListener("abort", aborted, { once: true });
      ended?.addEventListener("abort", quiet);
      calls.set(id, (reply) => {
        signal?.removeEventListener("abort", aborted);
        ui.setStatus(key, undefined);
        resolve(reply);
      });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool's schema and `tooLong` checked the arguments.
      ui.setStatus(key, writeRequest({ kind: "call", id, op, args } as never));
    });
  };

  /**
   * Cuts this session where it is now into the directory the host gives.
   *
   * @remarks
   * `agent_spawn` with `context: "fork"` (SPEC-0002, "带上下文的子对话（agent 开的）"): the file and
   * leaf are read before anything awaits, so the cut is at the assistant message that called it.
   *
   * @sideEffects Asks the host; writes the branch.
   * @param id - The tool call's id.
   * @param signal - Its signal.
   * @param ctx - Its context.
   * @returns The branch's path, or the result to answer with instead.
   */
  const branchHere = async (
    id: string,
    signal: AbortSignal | undefined,
    ctx: AgentContext,
  ): Promise<{ readonly branch: string } | { readonly result: ToolResult }> => {
    const file = ctx.sessionManager.getSessionFile();
    const leaf = ctx.sessionManager.getLeafId();
    if (file === undefined || leaf === null) return { result: failed("agent_context_unavailable") };
    const given = await ask(ctx.ui, `${id}/branch`, "branch", {}, signal);
    // Stryker disable next-line ObjectLiteral: `given` is null only once the signal aborted, and then the spawn's own ask answers null at once, without writing, which ends in the same `stopped()`.
    if (given === null) return { result: stopped() };
    if (!given.ok) return { result: failed(given.code, given.params) };
    const dir: unknown =
      typeof given.result === "object" && given.result !== null ? Reflect.get(given.result, "dir") : null;
    let branch: string | undefined;
    try {
      branch = typeof dir === "string" ? deps.branch(ctx.sessionManager, file, dir, leaf) : undefined;
    } /* Stryker disable next-line BlockStatement: an empty catch leaves `branch` undefined, as this does. */ catch {
      branch = undefined;
    }
    return branch === undefined ? { result: failed("agent_context_unavailable") } : { branch };
  };

  /**
   * Runs one of the main agent's tools: checks its text, asks the host, words the answer.
   *
   * @remarks
   * See `branchHere` for `agent_spawn` with context.
   *
   * @sideEffects Asks the host; may write a branch.
   * @param tool - The tool.
   * @param id - The tool call's id.
   * @param params - Its parameters.
   * @param signal - Its signal.
   * @param ctx - Its context.
   * @returns The result.
   */
  const runParentTool = async (
    tool: (typeof PARENT_TOOLS)[number],
    id: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    ctx: AgentContext,
  ): Promise<ToolResult> => {
    const long = tooLong(tool, params);
    if (long !== null) return failed("agent_text_too_long", long);
    let args = params;
    // Stryker disable next-line ConditionalExpression: only `agent_spawn` declares `context`, and pi refuses parameters a schema leaves out before `execute`.
    if (tool === "agent_spawn" && params["context"] === "fork") {
      const cut = await branchHere(id, signal, ctx);
      if ("result" in cut) return cut.result;
      args = { ...params, branch: cut.branch };
    }
    const op = PARENT_OPS[tool];
    const reply = await ask(ctx.ui, id, op, args, signal);
    if (reply === null) return stopped();
    if (!reply.ok) return failed(reply.code, reply.params);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host answers each call with its own result, in the same bundle.
    return toolResult(resultText(op, reply.result as CallResults[typeof op]), reply.result);
  };

  /**
   * Asks the parent's agent and waits for the answer, the time to run out, or the host to close it.
   *
   * @remarks
   * SPEC-0002, `ask_parent`: the extension keeps the timer; on timeout it tells the host the question
   * closed, on an answer that it took it. The first that settles counts; closing ends the call to
   * the host, so nothing is left listening on the tool's signal.
   *
   * @sideEffects Asks the host; sets a timer; sends notes.
   * @param id - The tool call's id, which is the question's.
   * @param params - Its parameters.
   * @param signal - Its signal.
   * @param ctx - Its context.
   * @returns The result.
   */
  const askParent = async (
    id: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    ctx: AgentContext,
  ): Promise<ToolResult> => {
    const long = tooLong("ask_parent", params);
    if (long !== null) return failed("agent_text_too_long", long);
    const seconds = typeof params["timeoutSeconds"] === "number" ? params["timeoutSeconds"] : ASK_TIMEOUT_S;
    const key = `${AGENT_STATUS}:${id}`;
    const question: Question = { settle: () => undefined, answer: null, open: true };
    questions.set(id, question);
    /** Ends the call to the host once the question closes, however it closed. */
    const done = new AbortController();
    const outcome = await new Promise<AskResult | Extract<AgentReply, { ok: false }>>((resolve) => {
      let timer: unknown = null;
      /**
       * Closes the question: no answer counts after this.
       *
       * @remarks
       * Kept a while, to answer a repeated `agent_reply` (SPEC-0002, `agent_reply`).
       *
       * @sideEffects Stops the timer; clears the status; may forget old questions.
       */
      const close = (): void => {
        question.open = false;
        deps.clearTimeout(timer);
        ctx.ui.setStatus(key, undefined);
        done.abort();
        forgetOld();
      };
      question.settle = (result) => {
        if (!question.open) return;
        close();
        resolve(result);
      };
      timer = deps.setTimeout(() => {
        // Stryker disable next-line ConditionalExpression: `close` always clears this timer, so it never fires on a closed question.
        if (!question.open) return;
        question.settle({ answered: false, reason: "timeout" });
        note("closed", { id });
      }, seconds * 1000);
      /**
       * Takes the host's answer to the question.
       *
       * @remarks
       * A question already closed by its timer takes none.
       *
       * @sideEffects Settles the question; may send `answered`.
       * @param reply - The host's answer, or `null` when the tool was stopped.
       */
      const replied = (reply: AgentReply | null): void => {
        if (!question.open) return;
        if (reply === null) {
          question.settle({ answered: false, reason: "aborted" });
          return;
        }
        if (!reply.ok) {
          close();
          resolve(reply);
          return;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host answers `ask` with an AskResult, in the same bundle.
        const answer = reply.result as AskResult;
        if (answer.answered) question.answer = answer.answer;
        question.settle(answer);
        if (answer.answered) note("answered", { id });
      };
      // Fire and forget: `ask` never rejects, and `replied` settles the question it answers.
      void ask(ctx.ui, id, "ask", params, signal, done.signal).then(replied);
    });
    if ("ok" in outcome) return failed(outcome.code, outcome.params);
    return toolResult(askText(outcome), outcome);
  };

  /**
   * Drops the oldest closed questions past {@link CLOSED_KEPT}.
   *
   * @remarks
   * Closed questions are kept only to answer a repeated `agent_reply` (SPEC-0002, `agent_reply`).
   *
   * @sideEffects Updates the questions.
   */
  const forgetOld = (): void => {
    const closed = [...questions].filter(([, one]) => !one.open);
    for (const [old] of closed.slice(0, Math.max(0, closed.length - CLOSED_KEPT))) questions.delete(old);
  };

  for (const tool of PARENT_TOOLS)
    pi.registerTool({
      name: tool,
      ...PARENT_TOOL_SPECS[tool],
      execute: (id, params, signal, _onUpdate, ctx) => runParentTool(tool, id, params, signal, ctx),
    });

  pi.registerTool({
    name: "report_progress",
    label: "Report progress",
    description:
      "Tell the agent that started you how the task is going, without interrupting it. It sees this with your next result; keep it short.",
    parameters: object({ message: textParam("The progress.", TEXT_LIMITS.progress) }, ["message"]),
    execute: (_id, params, _signal, _onUpdate, ctx) => {
      const long = tooLong("report_progress", params);
      if (long !== null) return Promise.resolve(failed("agent_text_too_long", long));
      line = ctx.ui;
      note("progress", { message: params["message"] });
      return Promise.resolve(toolResult("Noted.", {}));
    },
  });

  pi.registerTool({
    name: "ask_parent",
    label: "Ask parent agent",
    description:
      "Ask the agent that started you a question and wait for its answer, instead of guessing. If no answer comes, do not guess: stop the work that needs it and end the task saying what you need decided.",
    parameters: object(
      {
        question: textParam("The question.", TEXT_LIMITS.question),
        options: { type: "array", items: { type: "string" }, maxItems: 6, description: "Possible answers, if any." },
        timeoutSeconds: {
          type: "integer",
          minimum: 60,
          maximum: 3600,
          description: `How long to wait for an answer. Default ${String(ASK_TIMEOUT_S)}.`,
        },
      },
      ["question"],
    ),
    execute: (id, params, signal, _onUpdate, ctx) => askParent(id, params, signal, ctx),
  });

  /**
   * Asks the user the questions and waits for the answers.
   *
   * @remarks
   * SPEC-0003, "工具": the questions are checked and read first, and what to fix goes back to the
   * model without asking the host; a child the agent opened asks its parent instead. The host
   * answers when the user does; stopped, the call fails with what the model reads, which pi keeps
   * as the error result (契约测试 `ask-abort`). The result's details keep how the questions ended,
   * for the transcript.
   *
   * @sideEffects Asks the host.
   * @param id - The tool call's id.
   * @param params - Its parameters.
   * @param signal - Its signal.
   * @param ctx - Its context.
   * @returns The result.
   * @throws {Error} When stopped.
   */
  const askUser = async (
    id: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    ctx: AgentContext,
  ): Promise<ToolResult> => {
    if (who().child) return toolResult(SUB_AGENT_ASKS_PARENT, {}, true);
    const read = checkQuestions(params);
    if (!read.ok) return toolResult(read.error, {}, true);
    const reply = await ask(ctx.ui, id, "ask_user", { questions: read.questions }, signal);
    if (reply === null) throw new Error(ASK_USER_STOPPED);
    if (!reply.ok) return failed(reply.code, reply.params);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host answers `ask_user` with an AskUserResult, in the same bundle.
    const result = reply.result as AskUserResult;
    const outcome =
      result.outcome === "answered" ? { kind: "answered", answers: result.answers } : { kind: result.outcome };
    return toolResult(answerText(read.questions, result), { v: 1, outcome });
  };

  pi.registerTool({
    name: ASK_USER_TOOL,
    label: "Ask user",
    description:
      'Ask the user 1 to 4 multiple-choice questions and wait for the answers, when you need their decision to go on: several reasonable approaches, an unclear requirement, a preference. Give each question 2 to 4 options, each with a short label and a description of what choosing it means or costs. The user can always write their own answer, so do not add an "Other" option. If you recommend an option, put it first and end its label with "(Recommended)". Ask related questions together in one call. Do not ask whether a plan is fine, and never ask for passwords or keys. The user may skip the questions, or reply in their own words instead.',
    promptSnippet: "Ask the user multiple-choice questions and wait for the answers",
    // One set of questions at a time: a second call in the same batch waits for the first (SPEC-0003, "工具").
    executionMode: "sequential",
    parameters: object(
      {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "The questions, 1 to 4.",
          items: object(
            {
              header: {
                type: "string",
                description: 'A short name for the question, at most 12 characters, like "Scope".',
              },
              question: { type: "string", description: "The whole question. At most 1000 characters." },
              multiSelect: { type: "boolean", description: "The user may pick several options. Default false." },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                description: "2 to 4 options.",
                items: object(
                  {
                    label: { type: "string", description: "1 to 5 words. At most 60 characters." },
                    description: {
                      type: "string",
                      description: "What choosing it means, or its trade-off. At most 300 characters.",
                    },
                    preview: {
                      type: "string",
                      description:
                        "Markdown to compare the options by, like a layout sketch, code or a config diff; single-choice questions only. At most 4000 characters.",
                    },
                  },
                  ["label", "description"],
                ),
              },
            },
            ["header", "question", "options"],
          ),
        },
      },
      ["questions"],
    ),
    execute: (id, params, signal, _onUpdate, ctx) => askUser(id, params, signal, ctx),
  });

  pi.on("tool_call", (event, ctx) => {
    const why = refusal(who(), event.toolName);
    if (why !== null) return { block: true, reason: why };
    if (!who().child || who().guard !== "extension") return undefined;
    const theirs = parentCalls(ctx.sessionManager.getBranch()).some(
      (call) =>
        call.name === event.toolName &&
        JSON.stringify(canonical(call.input)) === JSON.stringify(canonical(event.input)),
    );
    return theirs
      ? {
          block: true,
          reason:
            "This call belongs to the parent conversation, which handles it; do not redo it. Do only the task you were given.",
        }
      : undefined;
  });

  /**
   * Writes the host's note into the session, without a run.
   *
   * @remarks
   * SPEC-0002, "对话记录里的自定义消息": idle, pi writes it at once.
   *
   * @sideEffects Writes a custom message.
   * @param value - The command's argument.
   */
  const noted = (value: unknown): void => {
    const read = agentNote(value);
    if (read === null) return;
    pi.sendMessage(
      { customType: AGENT_MESSAGE, content: noteText(read), display: true, details: { v: 1, kind: "note", ...read } },
      { triggerTurn: false },
    );
  };

  /**
   * Hands the host's answer to the call waiting for it.
   *
   * @remarks
   * ADR-0013, point 7: the first answer counts; one for an id nobody waits for is dropped, except an
   * answer to a question already closed: the same answer it took is confirmed again, any other is
   * closed (SPEC-0002, `agent_reply`).
   *
   * @sideEffects Settles a call; may send a note.
   * @param value - The command's argument.
   */
  const replied = (value: unknown): void => {
    const reply = readReply(value);
    if (reply === null) return;
    const waiting = calls.get(reply.id);
    if (waiting !== undefined) {
      calls.delete(reply.id);
      waiting(reply);
      return;
    }
    const asked = questions.get(reply.id);
    if (asked === undefined || asked.open || !reply.ok) return;
    const answer: unknown =
      typeof reply.result === "object" && reply.result !== null ? Reflect.get(reply.result, "answer") : undefined;
    note(asked.answer !== null && answer === asked.answer ? "answered" : "closed", { id: reply.id });
  };

  /**
   * Closes a question the host no longer wants answered.
   *
   * @remarks
   * ADR-0013, point 7: the extension says whether it had already taken an answer.
   *
   * @sideEffects Settles `ask_parent`; sends a note.
   * @param value - The command's argument.
   */
  const cancelled = (value: unknown): void => {
    const cancel = readCancel(value);
    if (cancel === null) return;
    const asked = questions.get(cancel.id);
    if (asked === undefined) return;
    asked.settle({ answered: false, reason: cancel.reason });
    note(asked.answer === null ? "closed" : "answered", { id: cancel.id });
  };

  /** What the host delivered while pi ran, held for the turn's end (SPEC-0002, "送达"). */
  // Stryker disable next-line ArrayDeclaration: something held that is no delivery is never written, nor taken for a delivery's id.
  let held: Delivery[] = [];
  /** The delivery ids handed to pi lately, oldest first: in pi's queue, or gone into the context. */
  // Stryker disable next-line ArrayDeclaration: an id the host never gives matches no delivery.
  let handed: string[] = [];
  /** Of those, the ones whose message went into the context. */
  const inContext = new Set<string>();

  /**
   * Writes notices or a task into the session, starting a run or steering the one in progress.
   *
   * @remarks
   * SPEC-0002, "送达": the content is the wrapped text the model reads; `details` keeps the
   * delivery ids the host confirms by, and what the transcript shows.
   *
   * @sideEffects Writes a custom message.
   * @param delivery - The delivery.
   */
  const write = (delivery: Delivery): void => {
    const details: MessageDetails =
      delivery.kind === "report"
        ? {
            v: 1,
            kind: "report",
            deliveries: delivery.deliveries,
            events: delivery.events.map(({ reply: _reply, options: _options, ...event }) => event),
          }
        : {
            v: 1,
            kind: "task",
            deliveries: delivery.deliveries,
            from: delivery.from,
            fromTitle: delivery.fromTitle,
            taskId: delivery.taskId,
            text: delivery.text,
            ...(delivery.steer === true ? { steer: true as const } : {}),
          };
    pi.sendMessage(
      {
        customType: AGENT_MESSAGE,
        content: delivery.kind === "report" ? reportText(delivery) : taskText(delivery),
        display: true,
        details,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  };

  /**
   * Hands pi what is held: the notices as one message, then the words for each task in hand as one,
   * then each new task.
   *
   * @remarks
   * SPEC-0002, "送达": pi takes one steer a turn boundary, so what came meanwhile goes together;
   * the notices first. A new task is never folded into words for another. Into an idle pi the
   * first starts a run.
   *
   * @sideEffects Writes custom messages; empties what is held.
   */
  const flush = (): void => {
    const reports = held.filter((one) => one.kind === "report");
    const groups = new Map<string, Extract<Delivery, { kind: "task" }>[]>();
    for (const one of held) {
      if (one.kind !== "task") continue;
      // Stryker disable next-line ConditionalExpression,StringLiteral: a new task's id is new, so no words share it, and the host hands pi no two new tasks at once.
      const key = one.steer === true ? `words ${one.taskId}` : `task ${one.deliveries.join(" ")}`;
      groups.set(key, [...(groups.get(key) ?? []), one]);
    }
    // Stryker disable next-line ArrayDeclaration: something held that is no delivery is never written, nor taken for a delivery's id.
    held = [];
    const [report] = reports;
    if (report !== undefined)
      write({
        ...report,
        deliveries: reports.flatMap((one) => one.deliveries),
        events: reports.flatMap((one) => one.events),
        progress: reports.flatMap((one) => one.progress),
      });
    for (const [task, ...more] of groups.values()) {
      // Stryker disable next-line ConditionalExpression: a group has at least the task that opened it.
      if (task === undefined) continue;
      write({
        ...task,
        deliveries: [task, ...more].flatMap((one) => one.deliveries),
        text: [task, ...more].map((one) => one.text).join("\n\n"),
      });
    }
    handed.push(
      ...reports.flatMap((one) => one.deliveries),
      ...[...groups.values()].flat().flatMap((one) => one.deliveries),
    );
    // Stryker disable next-line CallExpression: only keeps the set small; an id gone from `handed` is never looked up in it.
    for (const id of handed.splice(0, Math.max(0, handed.length - HANDED_KEPT))) inContext.delete(id);
  };

  /**
   * Forgets what a stopped run had: what is held, and what pi's queue had that the stop cleared.
   *
   * @remarks
   * SPEC-0002, "送达": the host clears pi's queue as it stops a session and still has those
   * deliveries waiting, so they are taken again when it sends them again.
   *
   * @sideEffects Empties what is held; forgets what did not go into the context.
   */
  const forgetStopped = (): void => {
    // Stryker disable next-line ArrayDeclaration: see `held`.
    held = [];
    handed = handed.filter((id) => inContext.has(id));
  };

  /**
   * Takes a delivery from the host: written at once into an idle pi, held while it runs.
   *
   * @remarks
   * SPEC-0002, "送达": what is held goes at the turn's end, and all of it once pi is idle. One the
   * host sends again whole after pi had it goes no second time; one it sends again takes the place
   * of what is held of it, so no event goes twice.
   *
   * @sideEffects May write custom messages; holds the delivery.
   * @param value - The command's argument.
   * @param idle - Whether pi has no run going.
   */
  const deliver = (value: unknown, idle: boolean): void => {
    const parsed = Delivery.safeParse(value);
    if (!parsed.success) return;
    const delivery = parsed.data;
    if (!delivery.deliveries.every((id) => handed.includes(id))) {
      held = [...held.filter((one) => !one.deliveries.some((id) => delivery.deliveries.includes(id))), delivery];
    }
    if (idle) flush();
  };

  pi.on("turn_end", (event, ctx) => {
    // A stopped run takes nothing more, even when its tools' batch ended well (SPEC-0002, "送达").
    if (ctx.signal?.aborted === true || Reflect.get(Object(event.message), "stopReason") === "aborted") forgetStopped();
    else flush();
  });

  pi.on("agent_end", (event) => {
    // What came after the last turn's end goes now: pi starts the run again for it (pi-internals.md §2).
    if (event.messages.some((message) => Reflect.get(Object(message), "stopReason") === "aborted")) forgetStopped();
    // With nothing held, `flush` writes nothing.
    else flush();
  });

  pi.on("message_start", (event) => {
    const message: unknown = event.message;
    if (Reflect.get(Object(message), "customType") !== AGENT_MESSAGE) return;
    const read = MessageDetails.safeParse(Reflect.get(Object(message), "details"));
    // Stryker disable next-line ConditionalExpression: only the extension writes these messages, with details it made.
    if (read.success) for (const id of read.data.deliveries) inContext.add(id);
  });

  pi.registerCommand(AGENT_COMMAND, {
    description: "Atrium's child conversations, sent by Atrium's host",
    handler: (args, ctx) => {
      line = ctx.ui;
      const [action, argument] = args.trim().split(/\s+/);
      // A missing argument reads as nothing, as any word that is not base64url JSON does.
      const value = decodeArgument(String(argument));
      if (action === "note") noted(value);
      else if (action === "reply") replied(value);
      else if (action === "cancel") cancelled(value);
      else if (action === "deliver") deliver(value, ctx.isIdle());
      return Promise.resolve();
    },
  });
}
