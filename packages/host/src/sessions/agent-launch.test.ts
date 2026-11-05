import { encodeArgument } from "@atrium/pi";
import type { AgentRole } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../store/agent-records";
import { agentLaunchFlags, agentSelf, sessionLaunchFlags, taskLaunchFlags, toolFlags } from "./agent-launch";
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
      isolated: false,
    });
    expect([agentSelf(entries, "main"), agentSelf(entries, "yours"), agentSelf(entries, "record-less")]).toStrictEqual([
      { v: 1, child: false, role: null, depth: 0, guard: "flags", isolated: false },
      { v: 1, child: false, role: null, depth: 0, guard: "flags", isolated: false },
      { v: 1, child: false, role: null, depth: 1, guard: "flags", isolated: false },
    ]);
  });
});

describe("agentSelf, isolated (SPEC-0002, 路径隔离)", () => {
  it("isolates the work children the agent opened, and no one else", () => {
    const entries = [
      entry("main"),
      entry("worker", ["main", "agent"], ["work", "flags"]),
      entry("forked-worker", ["main", "agent"], ["work", "extension"]),
      entry("deep-worker", ["worker", "agent"], ["work", "flags"]),
      entry("explorer", ["main", "agent"], ["explore", "flags"]),
      entry("adviser", ["main", "agent"], ["advise", "flags"]),
      // The agent's record stays on a session, but one the user opened (or took over) is theirs.
      entry("yours", ["main", "user"], ["work", "flags"]),
    ];

    expect(
      ["main", "worker", "forked-worker", "deep-worker", "explorer", "adviser", "yours"].map(
        (id) => agentSelf(entries, id).isolated,
      ),
    ).toStrictEqual([false, true, true, true, false, false, false]);
  });

  it("puts the switch in the flag the extension reads", () => {
    const entries = [entry("main"), entry("worker", ["main", "agent"], ["work", "flags"])];
    const flagOf = (id: string) => agentLaunchFlags(entries, id)[0];

    expect(flagOf("worker")).toBe(
      `--atrium-agent=${encodeArgument({ v: 1, child: true, role: "work", depth: 1, guard: "flags", isolated: true })}`,
    );
    expect(flagOf("main")).toBe(
      `--atrium-agent=${encodeArgument({ v: 1, child: false, role: null, depth: 0, guard: "flags", isolated: false })}`,
    );
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
      `read,bash,ffgrep,fffind,ls,report_progress,ask_parent,${PARENT}`,
    ]);
    expect(toolFlags(entries, "grandchild")).toStrictEqual([
      "--tools",
      "read,bash,ffgrep,fffind,ls,report_progress,ask_parent",
    ]);
  });

  it("gives a work child everything but legacy search and ask_user, and at depth 2 none of the main agent's tools either", () => {
    const entries = [
      entry("main"),
      entry("child", ["main", "agent"], ["work", "flags"]),
      entry("grandchild", ["child", "agent"], ["work", "flags"]),
    ];

    expect([toolFlags(entries, "child"), toolFlags(entries, "grandchild")]).toStrictEqual([
      ["--exclude-tools", "grep,find,ask_user"],
      ["--exclude-tools", `grep,find,${PARENT},ask_user`],
    ]);
  });

  it.each(["work", "explore", "advise"] as const)(
    "excludes legacy search for an inherited %s child even when the parent's remaining flags are empty",
    (role) => {
      const entries = [entry("main"), entry("forked", ["main", "agent"], [role, "extension"])];

      expect(toolFlags(entries, "forked")).toStrictEqual(["--exclude-tools", "grep,find"]);
    },
  );

  it("does not change search tools in a child you opened yourself", () => {
    const entries = [entry("main"), entry("yours", ["main", "user"])];

    expect(toolFlags(entries, "yours")).toStrictEqual(["--exclude-tools", "report_progress,ask_parent"]);
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

    expect(toolFlags(entries, "forked")).toStrictEqual(["--exclude-tools", "grep,find"]);
    expect(toolFlags(entries, "forked-reader")).toStrictEqual([
      "--tools",
      `read,bash,ffgrep,fffind,ls,report_progress,ask_parent,${PARENT}`,
      "--exclude-tools",
      "grep,find",
    ]);
    expect(toolFlags(entries, "loop-a")).toStrictEqual(["--exclude-tools", "grep,find,ask_user"]);
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

    expect(toolFlags(entries, "forked-again")).toStrictEqual(["--exclude-tools", "grep,find"]);
    expect(toolFlags(entries, "forked-deep")).toStrictEqual(["--exclude-tools", `grep,find,${PARENT},ask_user`]);
  });

  it("gives a forked child, for a terminal, the hard limits it would have without context", () => {
    const entries = [entry("main"), entry("forked", ["main", "agent"], ["explore", "extension"])];

    expect(toolFlags(entries, "forked", true)).toStrictEqual([
      "--tools",
      `read,bash,ffgrep,fffind,ls,report_progress,ask_parent,${PARENT}`,
    ]);
  });
});

describe("agentLaunchFlags", () => {
  it("tells the extension who the session is in one argument, then the tools' limits", () => {
    const entries = [entry("main"), entry("child", ["main", "agent"], ["explore", "flags"])];

    expect(agentLaunchFlags(entries, "child")).toStrictEqual([
      `--atrium-agent=${encodeArgument({ v: 1, child: true, role: "explore", depth: 1, guard: "flags", isolated: false })}`,
      "--tools",
      `read,bash,ffgrep,fffind,ls,report_progress,ask_parent,${PARENT}`,
    ]);
  });
});

/**
 * A node's session, as the launch rules read it.
 *
 * @remarks
 * Without a role, the record of a node whose role is unknown.
 *
 * @sideEffects none
 * @param nodeRole - The node's role.
 * @returns The entry.
 */
function node(nodeRole?: "explore" | "work" | "check" | "advise") {
  return {
    ...entry("node"),
    task: {
      taskId: "tsk_1",
      role: "node" as const,
      node: "N1",
      attempt: 1,
      ...(nodeRole === undefined ? {} : { nodeRole }),
      startOn: null,
    },
  };
}

/**
 * Who the flags say the session is.
 *
 * @remarks
 * Decodes the `--atrium-task` value, as the extension does.
 *
 * @sideEffects none
 * @param flags - The launch flags.
 * @returns The decoded value.
 */
function selfOf(flags: string[] | null): unknown {
  return JSON.parse(Buffer.from((flags?.[0] ?? "").slice("--atrium-task=".length), "base64url").toString());
}

describe('taskLaunchFlags (SPEC-0006, "一个 agent 节点怎么跑 · 起")', () => {
  it.each(["explore", "advise", "check"] as const)(
    "limits a %s node to the read-only white list and its three tools",
    (role) => {
      const flags = taskLaunchFlags(node(role));

      expect(flags?.slice(1)).toStrictEqual([
        "--tools",
        "read,bash,ffgrep,fffind,ls,node_done,request_graph_change,ask_user",
      ]);
      expect(selfOf(flags)).toStrictEqual({ v: 1, kind: "node", role });
    },
  );

  it("gives a work node every tool but the legacy search and the agent's", () => {
    const flags = taskLaunchFlags(node("work"));

    expect(flags?.slice(1)).toStrictEqual(["--exclude-tools", `grep,find,${PARENT},report_progress,ask_parent`]);
    expect(selfOf(flags)).toStrictEqual({ v: 1, kind: "node", role: "work" });
  });

  it("never carries the agent's flag, so the node is no child of SPEC-0002", () => {
    for (const role of ["explore", "work", "check", "advise"] as const) {
      expect(taskLaunchFlags(node(role))?.some((flag) => flag.startsWith("--atrium-agent"))).toBe(false);
    }
  });

  it("gives the task conversation the read-only list, its eight tools and ask_user; no edit, write or agent tool", () => {
    const flags = taskLaunchFlags({ ...entry("t"), task: { taskId: "tsk_1", role: "conversation", startOn: null } });

    expect(selfOf(flags)).toStrictEqual({ v: 1, kind: "conversation" });
    expect(flags?.slice(1)).toStrictEqual([
      "--tools",
      "read,bash,ffgrep,fffind,ls,task_read_source,task_set_summary,task_set_meta,task_status,task_read_node,task_diff,task_propose_graph,task_send_to_node,ask_user",
    ]);
    expect(flags?.some((flag) => flag.startsWith("--atrium-agent"))).toBe(false);
  });

  it("is none for a session of no node: an ordinary session, a child, a node without a role", () => {
    expect(taskLaunchFlags(entry("main"))).toBeNull();
    expect(taskLaunchFlags(entry("child", ["main", "agent"], ["work", "flags"]))).toBeNull();
    expect(taskLaunchFlags(node())).toBeNull();
    expect(taskLaunchFlags(undefined)).toBeNull();
  });

  it("leaves a node out of the agent's tree: it is no one's child and has depth 0", () => {
    const entries = [entry("main"), node("work")];

    expect(agentSelf(entries, "node")).toMatchObject({ child: false, depth: 0 });
  });
});

describe("sessionLaunchFlags: a session of a task never gets the agent's flags", () => {
  it("gives a node its own flags, and any other session the agent's", () => {
    expect(sessionLaunchFlags([node("work")], "node")).toStrictEqual(taskLaunchFlags(node("work")));
    expect(sessionLaunchFlags([entry("main")], "main")).toStrictEqual(agentLaunchFlags([entry("main")], "main"));
  });

  it("refuses a node without a role instead of starting it with every tool, and starts a task conversation read-only", () => {
    expect(() => sessionLaunchFlags([node()], "node")).toThrow("a task session without a launch path");
    const conversation = { ...entry("t"), task: { taskId: "tsk_1", role: "conversation" as const, startOn: null } };
    expect(sessionLaunchFlags([conversation], "t")).toStrictEqual(taskLaunchFlags(conversation));
  });
});
