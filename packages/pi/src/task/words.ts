import { READ_ONLY_TOOLS } from "../agent/words";
import { CONVERSATION_TOOLS, type NodeRole, type ResumeKind, TASK_TEXT_LIMITS, type TaskErrorCode } from "./schema";

/** The tools every node has beside its role's (SPEC-0006, "起"). */
export const NODE_TOOLS = ["node_done", "request_graph_change"] as const;

/** What the model is told when a call was stopped: pi keeps it as the error result. */
export const TASK_STOPPED = "The call was stopped.";

/** What the codes without parameters tell the model. */
const FIXED_ERRORS: Readonly<
  Record<Exclude<TaskErrorCode, "task_args_invalid" | "task_text_too_long" | "task_graph_invalid">, string>
> = {
  task_caller_invalid:
    "Atrium does not accept this call from this conversation: this conversation is not the one that runs this step right now. Do not retry; end your turn.",
  task_not_found: "Atrium does not know this task any more. Do not retry; end your turn.",
  task_state_invalid: "The task is not in a state that takes this call. Do not retry; end your turn.",
  task_bad_request: "Atrium could not read this call. Call again with the parameters as described.",
  task_failed: "Atrium could not take this call just now. Try once more; if it fails again, end your turn and say so.",
};

/**
 * A string parameter of the host's error, for the words.
 *
 * @remarks
 * The host's parameters are data from another process; an absent or non-text one shows as `?`.
 *
 * @sideEffects none
 * @param params - The parameters.
 * @param key - Which one.
 * @returns The text.
 */
function named(params: Readonly<Record<string, unknown>>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "?";
}

/**
 * What a refused call tells the model.
 *
 * @remarks
 * The host answers with a code and parameters only; the extension words them (ADR-0013, point 9).
 * An unknown parameter shows as `?`.
 *
 * @sideEffects none
 * @param code - The host's code.
 * @param params - Its parameters.
 * @returns The text.
 */
export function errorText(code: TaskErrorCode, params: Readonly<Record<string, unknown>> = {}): string {
  if (code === "task_args_invalid") {
    return `Atrium refused the call: "${named(params, "field")}" is missing or empty. Fix it and call again.`;
  }
  if (code === "task_graph_invalid") {
    const node = typeof params["node"] === "string" ? ` (node ${params["node"]})` : "";
    return `Atrium refused the graph: ${named(params, "code")}${node}. Fix the graph and call task_propose_graph again.`;
  }
  if (code === "task_text_too_long") {
    const limit = typeof params["limit"] === "number" ? String(params["limit"]) : "?";
    return `"${named(params, "param")}" is too long: write at most ${limit} characters, and call again.`;
  }
  return FIXED_ERRORS[code];
}

/**
 * The first parameter of a call that is longer than its limit.
 *
 * @remarks
 * ADR-0013, point 9: the extension checks the limits so the model gets `task_text_too_long`, not
 * pi's validation failure.
 *
 * @sideEffects none
 * @param tool - The tool.
 * @param params - Its parameters.
 * @returns Which parameter and its limit, or `null` when none is too long.
 */
export function tooLong(
  tool: "node_done" | "request_graph_change",
  params: Readonly<Record<string, unknown>>,
): { readonly param: string; readonly limit: number } | null {
  const limits: readonly (readonly [string, number])[] =
    tool === "node_done"
      ? [
          ["summary", TASK_TEXT_LIMITS.summary],
          ["reason", TASK_TEXT_LIMITS.reason],
        ]
      : [
          ["reason", TASK_TEXT_LIMITS.reason],
          ["suggestion", TASK_TEXT_LIMITS.suggestion],
        ];
  for (const [param, limit] of limits) {
    const value = params[param];
    if (typeof value === "string" && value.length > limit) return { param, limit };
  }
  return null;
}

/**
 * What a refused or unreadable argument of a conversation tool tells the model.
 *
 * @remarks
 * Generic: the tools' parameters are checked by their schema, which names the parameter that is too long or wrong.
 *
 * @sideEffects none
 * @param issue - The schema's first issue.
 * @returns The code and its parameters.
 */
export function argumentFault(issue: {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly maximum?: unknown;
}): { readonly code: TaskErrorCode; readonly params?: Readonly<Record<string, unknown>> } {
  const param = typeof issue.path[0] === "string" ? issue.path[0] : "?";
  if (issue.code === "too_big" && typeof issue.maximum === "number") {
    return { code: "task_text_too_long", params: { param, limit: issue.maximum } };
  }
  return { code: "task_bad_request" };
}

/** What `node_done` tells the model once the host took it. */
export const NODE_DONE_TAKEN =
  "Recorded. This step ends when your turn ends; do not call anything else. If you call another tool or the user writes to you first, this call is void and you must call node_done again.";

/** What `request_graph_change` tells the model once the host took it. */
export const GRAPH_CHANGE_TAKEN =
  "Request sent. This step pauses when your turn ends; do not call anything else. You will be told whether the graph changed.";

/**
 * The reminder that starts a turn when the last one ended without `node_done`.
 *
 * @remarks
 * SPEC-0006, "失败 · no_done": the extension words it (the host produces no text for the model),
 * saying what to do in each case the model could be in.
 *
 * @sideEffects none
 * @returns The text.
 */
export function nudgeText(): string {
  return [
    "<atrium-task-nudge>",
    "This is a note from Atrium, not from the user.",
    "Your last turn ended without a recorded node_done, so this step is not finished.",
    "If the work is done, call node_done now, on its own and as your only tool call, with the handoff summary.",
    "If you cannot finish it, call node_done with ok false and the reason. If you need the user's decision, use ask_user; if the graph must change, call request_graph_change.",
    "</atrium-task-nudge>",
  ].join("\n");
}

/** What each reason for resuming tells the model it is. */
const RESUME_LINES: Readonly<Record<ResumeKind, string>> = {
  continue: "You are continuing this step.",
  restarted: "Atrium restarted while you were working.",
  graph_changed: "The task graph was changed, as you asked.",
  graph_rejected: "The graph change you asked for was not made.",
  wake: "A node asked for a change of the graph.",
};

/** The tags of the extension's own shells, which no text inside a shell may write. */
const SHELL_TAG = /<(\/?atrium-task-(?:resume|nudge|progress))/giu;

/**
 * The words that resume a session, in a shell that says they come from Atrium.
 *
 * @remarks
 * The host composes `text` (it holds the new contract after a graph change, with foreign text
 * already quoted and escaped, ADR-0013, point 10); the extension adds the first line, which says it
 * is not the user's, and escapes the tags of its own shell inside, so the text cannot close it.
 *
 * @sideEffects none
 * @param kind - Why it resumes.
 * @param text - The host's text.
 * @returns The text.
 */
export function resumeText(kind: ResumeKind, text: string): string {
  return [
    `<atrium-task-resume reason="${kind}">`,
    "This is a note from Atrium, not from the user.",
    RESUME_LINES[kind],
    text.replaceAll(SHELL_TAG, "&lt;$1"),
    "</atrium-task-resume>",
  ].join("\n");
}

/**
 * What the task conversation may use.
 *
 * @remarks
 * SPEC-0006, "起": SPEC-0002's read-only list, the task conversation's tools and `ask_user`; no `edit`,
 * `write` or `agent_*`. The host's `--tools` list is the first check, this the second.
 *
 * @sideEffects none
 * @param tool - The tool.
 * @returns Why not, or `null` when it may.
 */
export function conversationToolRefusal(tool: string): string | null {
  const allowed = [...READ_ONLY_TOOLS, ...CONVERSATION_TOOLS, "ask_user"] as readonly string[];
  return allowed.includes(tool)
    ? null
    : `The task conversation can only use ${allowed.join(", ")}; it changes no files.`;
}

/**
 * The page a long read ends with, so the model knows whether to ask for the next.
 *
 * @remarks
 * A text of one page has no footer.
 *
 * @sideEffects none
 * @param page - The page shown.
 * @param pages - How many there are.
 * @returns The line, empty for a text of one page.
 */
export function pageFooter(page: number, pages: number): string {
  return pages <= 1
    ? ""
    : `\n[page ${String(page)} of ${String(pages)}${page < pages ? "; ask for the next page to read on" : ""}]`;
}

/** What `task_set_summary` and `task_set_meta` tell the model once the host took them. */
export const RECORDED = "Recorded.";

/** What `task_send_to_node` tells the model once the host took it. */
export const SENT_TO_NODE = "Sent. The node reads it at its next turn boundary.";

/**
 * What `task_propose_graph` tells the model once the host took the graph.
 *
 * @remarks
 * Says whether the graph is in force or waits for the user, since the model's next words to the user depend on it.
 *
 * @sideEffects none
 * @param version - The graph's version.
 * @param pending - Whether it waits for the user's approval (the task already started).
 * @returns The text.
 */
export function graphTaken(version: number, pending: boolean): string {
  return pending
    ? `Graph version ${String(version)} recorded. It takes effect only when the user approves it; tell the user what changed and why.`
    : `Graph version ${String(version)} recorded and in force. The user can still ask for changes before starting the task.`;
}

/**
 * What a node of a role may use besides the node tools and `ask_user`.
 *
 * @remarks
 * SPEC-0006, "起": `explore`, `advise` and `check` nodes get SPEC-0002's read-only list (a `check`
 * node's Bash is not limited to reading; it runs tests and builds), a `work` node everything else
 * but the old `grep` / `find` and the agent tools. Anything else about the roles is the host's
 * `--tools` list; this is the second check.
 *
 * @sideEffects none
 * @param role - The node's role.
 * @param tool - The tool.
 * @param agentTools - The agent tools (SPEC-0002), which no node has.
 * @returns Why not, or `null` when it may.
 */
export function nodeToolRefusal(role: NodeRole, tool: string, agentTools: readonly string[]): string | null {
  if ((NODE_TOOLS as readonly string[]).includes(tool) || tool === "ask_user") return null;
  if (agentTools.includes(tool)) return "A task node cannot start or talk to sub-agents.";
  if (role === "work") {
    return tool === "grep" || tool === "find"
      ? "Use ffgrep and fffind for search; the old grep and find tools are disabled."
      : null;
  }
  if ((READ_ONLY_TOOLS as readonly string[]).includes(tool)) return null;
  return `This node (${role}) can only use ${[...READ_ONLY_TOOLS, ...NODE_TOOLS, "ask_user"].join(", ")}.`;
}
