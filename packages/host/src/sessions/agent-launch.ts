import {
  AGENT_FLAG,
  ASK_USER_TOOL,
  type AgentSelf,
  CHILD_TOOLS,
  CONVERSATION_TOOLS,
  NODE_TOOLS,
  PARENT_TOOLS,
  READ_ONLY_TOOLS,
  STUDY_FLAG,
  TASK_FLAG,
  type TaskSelf,
  encodeArgument,
  studyArgument,
} from "@atrium/pi";
import { isDirectionId } from "@atrium/protocol";
import type { CatalogEntry } from "./session-catalog";
import { agentDepth } from "./child-tree";

/** What the launch rules read of a session. */
type LaunchEntry = Pick<CatalogEntry, "sessionId" | "containerId" | "parent" | "archived" | "agent"> &
  Partial<Pick<CatalogEntry, "task" | "study">>;

/** The agent depth at which a session has none of the main agent's tools (SPEC-0002, "概念 · 层数"). */
const MAX_DEPTH = 2;

/** Legacy search names children leave out in favor of pi-fff's explicit names (SPEC-0002). */
const CHILD_SEARCH_EXCLUSIONS = ["grep", "find"] as const;

/**
 * Who a session is, as Atrium's extension is told (ADR-0013, point 3).
 *
 * @remarks
 * A child the agent opened has its own two tools, its role and where its tools are limited; any
 * other session is no one's child here. Its depth decides the main agent's tools. A `work` child
 * is isolated: its `edit` / `write` stay in its directory (SPEC-0002, "路径隔离"); a session the
 * user opened is not.
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param sessionId - The session.
 * @returns Who it is.
 */
export function agentSelf(entries: readonly LaunchEntry[], sessionId: string): AgentSelf {
  const entry = entries.find((candidate) => candidate.sessionId === sessionId);
  const agent = entry?.parent?.by === "agent" ? (entry.agent ?? null) : null;
  return {
    v: 1,
    child: agent !== null,
    role: agent?.role ?? null,
    depth: agentDepth(entries, sessionId),
    guard: agent?.toolGuard ?? "flags",
    isolated: agent?.role === "work",
  };
}

/**
 * pi's flags limiting a session's tools.
 *
 * @remarks
 * SPEC-0002, "角色与限制": a read-only child the agent opened gets the white list `--tools`, with
 * the main agent's tools below depth 2; a `work` child has legacy `grep` / `find` and
 * `ask_user` excluded (SPEC-0003), and at depth 2 the main agent's tools too. Any session not
 * opened by the agent has a child's own two tools excluded. A child whose limits are its
 * extension's (`toolGuard: "extension"`, carrying its parent's conversation) starts with its
 * parent's flags, without the exclusion of its own two tools, but always excludes legacy
 * search names so only FFF's explicit names remain. With `hard`, as for the terminal, it gets
 * the flags it would have without context instead. A loop of parents stops at the session met again.
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param sessionId - The session.
 * @param hard - Whether to leave out the extension's limits, as pi in a terminal has no extension.
 * @param seen - The sessions passed on the way up.
 * @returns The flags.
 */
export function toolFlags(
  entries: readonly LaunchEntry[],
  sessionId: string,
  hard = false,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const self = agentSelf(entries, sessionId);
  const deep = self.depth >= MAX_DEPTH;
  if (!self.child) return ["--exclude-tools", [...CHILD_TOOLS, ...(deep ? PARENT_TOOLS : [])].join(",")];
  // Stryker disable next-line OptionalChaining: a child the agent opened is listed, with its parent.
  const parent = entries.find((entry) => entry.sessionId === sessionId)?.parent?.sessionId;
  if (
    self.guard === "extension" &&
    !hard &&
    // Stryker disable next-line ConditionalExpression: as above.
    parent !== undefined &&
    !seen.has(parent)
  ) {
    return withChildTools(toolFlags(entries, parent, false, new Set([...seen, sessionId])));
  }
  if (self.role !== "work")
    return ["--tools", [...READ_ONLY_TOOLS, ...CHILD_TOOLS, ...(deep ? [] : PARENT_TOOLS)].join(",")];
  return ["--exclude-tools", [...CHILD_SEARCH_EXCLUSIONS, ...(deep ? PARENT_TOOLS : []), ASK_USER_TOOL].join(",")];
}

/**
 * A parent's tool flags with a child's own two tools let back in.
 *
 * @remarks
 * See `toolFlags`: a white list keeps them, an exclusion loses them; inherited exclusions
 * merge with the legacy search names every child excludes.
 *
 * @sideEffects none
 * @param flags - The parent's flags.
 * @returns The child's.
 */
function withChildTools(flags: readonly string[]): string[] {
  const out: string[] = [];
  const excluded = new Set<string>(CHILD_SEARCH_EXCLUSIONS);
  for (let at = 0; at < flags.length; at += 2) {
    // Stryker disable next-line StringLiteral: `at` is below the length.
    const flag = flags[at] ?? "";
    // Stryker disable next-line StringLiteral,MethodExpression,ConditionalExpression: `toolFlags` gives every flag a value, a list never empty.
    const names = (flags[at + 1] ?? "").split(",").filter((name) => name !== "");
    if (flag === "--exclude-tools") {
      for (const name of names) {
        if (!(CHILD_TOOLS as readonly string[]).includes(name)) excluded.add(name);
      }
    } else {
      out.push(flag, names.join(","));
    }
  }
  return [...out, "--exclude-tools", [...excluded].join(",")];
}

/**
 * pi's flags for a session Atrium starts with its extension: who it is, and its tools' limits.
 *
 * @remarks
 * `--atrium-agent=<base64url JSON>` as one argument, base64url may start with `-` (ADR-0013,
 * point 3); worked out in this one place for every start (SPEC-0002, "角色与限制").
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param sessionId - The session.
 * @returns The flags.
 */
export function agentLaunchFlags(entries: readonly LaunchEntry[], sessionId: string): string[] {
  return [`--${AGENT_FLAG}=${encodeArgument(agentSelf(entries, sessionId))}`, ...toolFlags(entries, sessionId)];
}

/**
 * pi's flags for a session of a task's node or of its conversation: who it is, and its tools (SPEC-0006,
 * "一个 agent 节点怎么跑 · 起").
 *
 * @remarks
 * `--atrium-task=<base64url JSON>` says the session is a node and which role; it is no identity, the host
 * knows the caller by the pi process (SPEC-0006, "调用方由宿主认定"). There is no `--atrium-agent`: a node
 * is not a child conversation of SPEC-0002, so it has none of `agent_*`, `report_progress` or `ask_parent`
 * and keeps `ask_user` (SPEC-0003). The read-only roles (`explore`, `advise`, `check`) get the white list
 * of SPEC-0002's read-only roles plus the node's three tools; `check` keeps `bash` unrestricted by the
 * white list as every role does, since tests and builds run there. A `work` node has every built-in tool but
 * the legacy `grep` / `find`, and none of the agent's. The extension's guards are on for every node.
 *
 * @sideEffects none
 * @param entry - The node's session.
 * @returns The flags, or `null` for a session that is not a node's.
 */
export function taskLaunchFlags(entry: LaunchEntry | undefined): string[] | null {
  const task = entry?.task;
  if (task?.role === "conversation") {
    // The task conversation: SPEC-0002's read-only list, its own tools and `ask_user`; it edits nothing.
    const self: TaskSelf = { v: 1, kind: "conversation" };
    return [
      `--${TASK_FLAG}=${encodeArgument(self)}`,
      "--tools",
      [...READ_ONLY_TOOLS, ...CONVERSATION_TOOLS, ASK_USER_TOOL].join(","),
    ];
  }
  if (task?.role !== "node" || task.nodeRole === undefined) return null;
  const self: TaskSelf = { v: 1, kind: "node", role: task.nodeRole };
  const flag = `--${TASK_FLAG}=${encodeArgument(self)}`;
  if (task.nodeRole === "work") {
    return [flag, "--exclude-tools", [...CHILD_SEARCH_EXCLUSIONS, ...PARENT_TOOLS, ...CHILD_TOOLS].join(",")];
  }
  return [flag, "--tools", [...READ_ONLY_TOOLS, ...NODE_TOOLS, ASK_USER_TOOL].join(",")];
}

/**
 * pi's flags for a session of any kind: a node's, or else an agent's.
 *
 * @remarks
 * A session with a `task` field never gets the agent's flags (all tools, no isolation): a node without a role
 * is refused instead (SPEC-0006, "一个 agent 节点怎么跑 · 起"). The task conversation has its own flags.
 *
 * @sideEffects none
 * @param entries - The catalogued sessions.
 * @param sessionId - The session.
 * @returns The flags.
 * @throws {Error} When the session belongs to a task but has no launch path of its own.
 */
export function sessionLaunchFlags(entries: readonly LaunchEntry[], sessionId: string): string[] {
  const entry = entries.find((candidate) => candidate.sessionId === sessionId);
  const flags = taskLaunchFlags(entry);
  if (flags !== null) return flags;
  if (entry?.task != null) throw new Error("a task session without a launch path of its own");
  return agentLaunchFlags(entries, sessionId);
}

/**
 * pi's flag for a session of a direction with a use: `--atrium-study=<base64url JSON>`.
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节": only a session of a direction whose record has a use other than
 * asking; every other session, in a workspace or a chat or asking in a direction, gets none, so
 * Atrium's extension registers no study tool there. One argument with `=`, as `--atrium-agent`.
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param sessionId - The session.
 * @param unforked - A quiz with its lesson as parent that could not fork from it after all.
 * @returns The flag, or none.
 */
export function studyLaunchFlags(entries: readonly LaunchEntry[], sessionId: string, unforked = false): string[] {
  const entry = entries.find((candidate) => candidate.sessionId === sessionId);
  const study = entry?.study ?? null;
  if (entry === undefined || !isDirectionId(entry.containerId) || study === null || study.kind === "ask") return [];
  // A quiz not forked from its lesson is told it has none of the lesson's conversation (SPEC-0008, "ML3 定的细节").
  const alone = study.kind === "quiz" && (unforked || (entry.parent ?? null) === null);
  return [`--${STUDY_FLAG}=${studyArgument({ ...study, kind: study.kind, ...(alone ? { context: "none" } : {}) })}`];
}
