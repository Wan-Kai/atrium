import { encodeArgument } from "@atrium/pi";
import type { AgentRole } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../store/agent-records";
import { agentLaunchFlags, agentSelf, toolFlags } from "./agent-launch";
import { agentDepth } from "./child-tree";

/** The main agent's tools, as pi's flags list them. */
const PARENT = "agent_spawn,agent_send,agent_reply,agent_list,agent_read,agent_stop,agent_models";

/** What the launch rules read of a session. */
interface Entry {
  readonly sessionId: string;
  readonly containerId: string;
  readonly parent: { readonly sessionId: string; readonly by: "user" | "agent" } | null;
  readonly archived: boolean;
  readonly agent: AgentRecord | null;
}

/**
 * A session, its parent, who opened it and, for one the agent opened, its role and guard.
 *
 * @remarks
 * Only what the launch rules read.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param parent - Its parent and who opened it; `null` for none.
 * @param agent - Its role and tool guard, for a child the agent opened.
 * @returns The entry.
 */
function entry(
  sessionId: string,
  parent: readonly [string, "user" | "agent"] | null = null,
  agent: readonly [AgentRole, "flags" | "extension"] | null = null,
): Entry {
  return {
    sessionId,
    containerId: "w1",
    parent: parent === null ? null : { sessionId: parent[0], by: parent[1] },
    archived: false,
    agent:
      agent === null
        ? null
        : { handle: sessionId, role: agent[0], toolGuard: agent[1], startOn: null, worktree: false, tasks: [] },
  };
}

describe("agentDepth", () => {
  it("counts the agent-opened links up from a session, stopping at one you opened", () => {
    const entries = [
      entry("main"),
      entry("child", ["main", "agent"], ["work", "flags"]),
      entry("grandchild", ["child", "agent"], ["explore", "flags"]),
      entry("yours", ["grandchild", "user"]),
      entry("again", ["yours", "agent"], ["work", "flags"]),
    ];

    expect(["main", "child", "grandchild", "yours", "again"].map((id) => agentDepth(entries, id))).toStrictEqual([
      0, 1, 2, 0, 1,
    ]);
  });

  it("breaks a loop where it closes, above a session too, and ends at a parent not listed", () => {
    const entries = [
      entry("a", ["b", "agent"], ["work", "flags"]),
      entry("b", ["a", "agent"], ["work", "flags"]),
      entry("orphan", ["gone", "agent"], ["work", "flags"]),
      entry("below", ["a", "agent"], ["work", "flags"]),
    ];

    expect([
      agentDepth(entries, "a"),
      agentDepth(entries, "orphan"),
      agentDepth(entries, "unknown"),
      agentDepth(entries, "below"),
    ]).toStrictEqual([1, 0, 0, 2]);
  });
});

describe("agentSelf", () => {
  it("says a child the agent opened is one, with its role, depth and guard, and any other session is no one's child", () => {
    const entries = [
      entry("main"),
      entry("child", ["main", "agent"], ["advise", "extension"]),
      entry("yours", ["main", "user"]),
      entry("record-less", ["main", "agent"]),
    ];

    expect(agentSelf(entries, "child")).toStrictEqual({
      v: 1,
      child: true,
      role: "advise",
      depth: 1,
      guard: "extension",
    });
    expect([agentSelf(entries, "main"), agentSelf(entries, "yours"), agentSelf(entries, "record-less")]).toStrictEqual([
      { v: 1, child: false, role: null, depth: 0, guard: "flags" },
      { v: 1, child: false, role: null, depth: 0, guard: "flags" },
      { v: 1, child: false, role: null, depth: 1, guard: "flags" },
    ]);
  });
});

describe("toolFlags", () => {
  it("leaves a child's own tools out of a session the agent did not open", () => {
    expect(toolFlags([entry("main")], "main")).toStrictEqual(["--exclude-tools", "report_progress,ask_parent"]);
  });

  it("gives a read-only child a white list, with the main agent's tools only above depth 2", () => {
    const entries = [
      entry("main"),
      entry("child", ["main", "agent"], ["explore", "flags"]),
      entry("grandchild", ["child", "agent"], ["advise", "flags"]),
    ];

    expect(toolFlags(entries, "child")).toStrictEqual([
      "--tools",
      `read,bash,grep,find,ls,report_progress,ask_parent,${PARENT}`,
    ]);
    expect(toolFlags(entries, "grandchild")).toStrictEqual([
      "--tools",
      "read,bash,grep,find,ls,report_progress,ask_parent",
    ]);
  });

  it("gives a work child everything but ask_user, and at depth 2 none of the main agent's tools either", () => {
    const entries = [
      entry("main"),
      entry("child", ["main", "agent"], ["work", "flags"]),
      entry("grandchild", ["child", "agent"], ["work", "flags"]),
    ];

    expect([toolFlags(entries, "child"), toolFlags(entries, "grandchild")]).toStrictEqual([
      ["--exclude-tools", "ask_user"],
      ["--exclude-tools", `${PARENT},ask_user`],
    ]);
  });

  it("starts a child with its parent's conversation on its parent's flags, its own two tools let in", () => {
    const entries = [
      entry("main"),
      entry("forked", ["main", "agent"], ["explore", "extension"]),
      entry("reader", ["main", "agent"], ["explore", "flags"]),
      entry("forked-reader", ["reader", "agent"], ["advise", "extension"]),
      entry("loop-a", ["loop-b", "agent"], ["work", "extension"]),
      entry("loop-b", ["loop-a", "agent"], ["work", "extension"]),
    ];

    expect(toolFlags(entries, "forked")).toStrictEqual([]);
    expect(toolFlags(entries, "forked-reader")).toStrictEqual([
      "--tools",
      `read,bash,grep,find,ls,report_progress,ask_parent,${PARENT}`,
    ]);
    expect(toolFlags(entries, "loop-a")).toStrictEqual(["--exclude-tools", "ask_user"]);
  });

  it("starts a child forked from a forked child on the flags its parent starts with, keeping an exclusion of the main agent's tools", () => {
    const entries = [
      entry("main"),
      entry("forked", ["main", "agent"], ["explore", "extension"]),
      entry("forked-again", ["forked", "agent"], ["work", "extension"]),
      entry("child", ["main", "agent"], ["work", "flags"]),
      entry("grandchild", ["child", "agent"], ["work", "flags"]),
      entry("forked-deep", ["grandchild", "agent"], ["explore", "extension"]),
    ];

    expect(toolFlags(entries, "forked-again")).toStrictEqual([]);
    expect(toolFlags(entries, "forked-deep")).toStrictEqual(["--exclude-tools", `${PARENT},ask_user`]);
  });

  it("gives a forked child, for a terminal, the hard limits it would have without context", () => {
    const entries = [entry("main"), entry("forked", ["main", "agent"], ["explore", "extension"])];

    expect(toolFlags(entries, "forked", true)).toStrictEqual([
      "--tools",
      `read,bash,grep,find,ls,report_progress,ask_parent,${PARENT}`,
    ]);
  });
});

describe("agentLaunchFlags", () => {
  it("tells the extension who the session is in one argument, then the tools' limits", () => {
    const entries = [entry("main"), entry("child", ["main", "agent"], ["explore", "flags"])];

    expect(agentLaunchFlags(entries, "child")).toStrictEqual([
      `--atrium-agent=${encodeArgument({ v: 1, child: true, role: "explore", depth: 1, guard: "flags" })}`,
      "--tools",
      `read,bash,grep,find,ls,report_progress,ask_parent,${PARENT}`,
    ]);
  });
});
