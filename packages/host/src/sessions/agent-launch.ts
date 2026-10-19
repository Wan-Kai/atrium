import { AGENT_FLAG, type AgentSelf, CHILD_TOOLS, PARENT_TOOLS, READ_ONLY_TOOLS, encodeArgument } from "@atrium/pi";
import type { CatalogEntry } from "./session-catalog";
import { agentDepth } from "./child-tree";

/** What the launch rules read of a session. */
type LaunchEntry = Pick<CatalogEntry, "sessionId" | "containerId" | "parent" | "archived" | "agent">;

/** The agent depth at which a session has none of the main agent's tools (SPEC-0002, "概念 · 层数"). */
const MAX_DEPTH = 2;

/**
 * Who a session is, as Atrium's extension is told (ADR-0013, point 3).
 *
 * @remarks
 * A child the agent opened has its own two tools, its role and where its tools are limited; any
 * other session is no one's child here. Its depth decides the main agent's tools.
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
  };
}

/**
 * pi's flags limiting a session's tools.
 *
 * @remarks
 * SPEC-0002, "角色与限制": a read-only child the agent opened gets the white list `--tools`, with
 * the main agent's tools below depth 2; a `work` child at depth 2 has those excluded; any session
 * not opened by the agent has a child's own two tools excluded. A child whose limits are its
 * extension's (`toolGuard: "extension"`, carrying its parent's conversation) starts with its
 * parent's flags, so its requests begin as its parent's did, without the exclusion of its own two
 * tools; with `hard`, as for the terminal, it gets the flags it would have without context
 * instead. A loop of parents stops at the session met again.
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
  return deep ? ["--exclude-tools", PARENT_TOOLS.join(",")] : [];
}

/**
 * A parent's tool flags with a child's own two tools let back in.
 *
 * @remarks
 * See `toolFlags`: a white list keeps them, an exclusion loses them; one left empty goes.
 *
 * @sideEffects none
 * @param flags - The parent's flags.
 * @returns The child's.
 */
function withChildTools(flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < flags.length; at += 2) {
    // Stryker disable next-line StringLiteral: `at` is below the length.
    const flag = flags[at] ?? "";
    // Stryker disable next-line StringLiteral,MethodExpression,ConditionalExpression: `toolFlags` gives every flag a value, a list never empty.
    const names = (flags[at + 1] ?? "").split(",").filter((name) => name !== "");
    if (flag === "--exclude-tools") {
      const kept = names.filter((name) => !(CHILD_TOOLS as readonly string[]).includes(name));
      if (kept.length > 0) out.push(flag, kept.join(","));
    } else {
      out.push(flag, names.join(","));
    }
  }
  return out;
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
