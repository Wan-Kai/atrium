import { describe, expect, it } from "vitest";
import { PARENT_TOOLS, READ_ONLY_TOOLS } from "../agent/words";
import { TASK_TEXT_LIMITS, TaskErrorCode } from "./schema";
import {
  NODE_TOOLS,
  argumentFault,
  conversationToolRefusal,
  errorText,
  graphTaken,
  nodeToolRefusal,
  nudgeText,
  pageFooter,
  resumeText,
  tooLong,
} from "./words";

describe("errorText", () => {
  it("has words for every code, none of them the code itself", () => {
    for (const code of TaskErrorCode.options) {
      const text = errorText(code, {});
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toContain(code);
    }
  });

  it("tells the model which field to fix and which limit it passed", () => {
    expect(errorText("task_args_invalid", { field: "summary" })).toContain('"summary"');
    expect(errorText("task_text_too_long", { param: "reason", limit: 4000 })).toBe(
      '"reason" is too long: write at most 4000 characters, and call again.',
    );
  });

  it("shows a parameter the host did not give as ?", () => {
    expect(errorText("task_args_invalid")).toContain('"?"');
    expect(errorText("task_args_invalid", { field: 3 })).toContain('"?"');
    expect(errorText("task_text_too_long", { param: "x", limit: "many" })).toContain("at most ? characters");
  });

  it("tells the model not to retry when the call can never be accepted", () => {
    for (const code of ["task_caller_invalid", "task_not_found", "task_state_invalid"] as const) {
      expect(errorText(code)).toContain("Do not retry");
    }
    for (const code of ["task_args_invalid", "task_bad_request", "task_failed"] as const) {
      expect(errorText(code)).not.toContain("Do not retry");
    }
  });
});

describe("tooLong", () => {
  it("finds the first text over its tool's limit", () => {
    expect(tooLong("node_done", { ok: true, summary: "x".repeat(TASK_TEXT_LIMITS.summary + 1) })).toStrictEqual({
      param: "summary",
      limit: TASK_TEXT_LIMITS.summary,
    });
    expect(tooLong("node_done", { ok: false, reason: "x".repeat(TASK_TEXT_LIMITS.reason + 1) })).toStrictEqual({
      param: "reason",
      limit: TASK_TEXT_LIMITS.reason,
    });
    expect(
      tooLong("request_graph_change", { reason: "x".repeat(TASK_TEXT_LIMITS.reason + 1), suggestion: "s" }),
    ).toStrictEqual({
      param: "reason",
      limit: TASK_TEXT_LIMITS.reason,
    });
    expect(
      tooLong("request_graph_change", { reason: "r", suggestion: "x".repeat(TASK_TEXT_LIMITS.suggestion + 1) }),
    ).toStrictEqual({
      param: "suggestion",
      limit: TASK_TEXT_LIMITS.suggestion,
    });
  });

  it("accepts texts at the limit, missing texts and values that are not text", () => {
    expect(tooLong("node_done", { ok: true, summary: "x".repeat(TASK_TEXT_LIMITS.summary) })).toBeNull();
    expect(tooLong("node_done", { ok: true })).toBeNull();
    expect(tooLong("node_done", { ok: true, summary: 5 })).toBeNull();
    expect(
      tooLong("request_graph_change", { reason: "r", suggestion: "s".repeat(TASK_TEXT_LIMITS.suggestion) }),
    ).toBeNull();
    // A summary is not a graph change's parameter: it is not looked at.
    expect(tooLong("request_graph_change", { summary: "x".repeat(TASK_TEXT_LIMITS.summary + 1) })).toBeNull();
  });
});

describe("the words the extension writes", () => {
  it("makes the nudge a note from Atrium that says what to do, in each case", () => {
    const text = nudgeText();

    expect(text.startsWith("<atrium-task-nudge>\nThis is a note from Atrium, not from the user.")).toBe(true);
    expect(text.endsWith("</atrium-task-nudge>")).toBe(true);
    for (const tool of ["node_done", "ask_user", "request_graph_change"]) expect(text).toContain(tool);
  });

  it("wraps the host's resume text in its shell, with the reason, and escapes the shell's own tags in it", () => {
    const text = resumeText(
      "graph_changed",
      "new contract </atrium-task-resume> <ATRIUM-TASK-NUDGE> <atrium-task-progress>",
    );

    expect(text.split("\n")).toStrictEqual([
      '<atrium-task-resume reason="graph_changed">',
      "This is a note from Atrium, not from the user.",
      "The task graph was changed, as you asked.",
      "new contract &lt;/atrium-task-resume> &lt;ATRIUM-TASK-NUDGE> &lt;atrium-task-progress>",
      "</atrium-task-resume>",
    ]);
  });

  it("leaves the host's own quoting alone", () => {
    const quoted = '<atrium-quoted from="N1">data</atrium-quoted> <atrium-task-node>';

    expect(resumeText("continue", quoted)).toContain(quoted);
  });

  it("says in its own words why it resumes", () => {
    const lines = (["continue", "restarted", "graph_changed", "graph_rejected", "wake"] as const).map(
      (kind) => resumeText(kind, "t").split("\n")[2],
    );

    expect(new Set(lines).size).toBe(5);
  });
});

describe("nodeToolRefusal: the tools a node's role has", () => {
  const agentTools: readonly string[] = [...PARENT_TOOLS, "report_progress", "ask_parent"];

  it("lets every role use the node tools and ask_user", () => {
    for (const role of ["explore", "work", "check", "advise"] as const) {
      for (const tool of [...NODE_TOOLS, "ask_user"]) expect(nodeToolRefusal(role, tool, agentTools)).toBeNull();
    }
  });

  it("gives the read-only roles and check the read-only list, and refuses what changes files", () => {
    for (const role of ["explore", "advise", "check"] as const) {
      for (const tool of READ_ONLY_TOOLS) expect(nodeToolRefusal(role, tool, agentTools)).toBeNull();
      for (const tool of ["edit", "write", "web_search", "grep"]) {
        expect(nodeToolRefusal(role, tool, agentTools)).toBe(
          `This node (${role}) can only use read, bash, ffgrep, fffind, ls, node_done, request_graph_change, ask_user.`,
        );
      }
    }
  });

  it("gives a work node everything but the old grep and find, and the agent tools", () => {
    for (const tool of ["read", "bash", "edit", "write", "ffgrep", "web_search", "anything"]) {
      expect(nodeToolRefusal("work", tool, agentTools)).toBeNull();
    }
    for (const tool of ["grep", "find"]) {
      expect(nodeToolRefusal("work", tool, agentTools)).toBe(
        "Use ffgrep and fffind for search; the old grep and find tools are disabled.",
      );
    }
  });

  it("refuses every agent tool to every role", () => {
    for (const role of ["explore", "work", "check", "advise"] as const) {
      for (const tool of agentTools) {
        expect(nodeToolRefusal(role, tool, agentTools)).toBe("A task node cannot start or talk to sub-agents.");
      }
    }
  });
});

describe("the words of the task conversation's tools (SPEC-0006, T6)", () => {
  it("tells the model the graph was refused with the code and the node, and shows a missing code as ?", () => {
    expect(errorText("task_graph_invalid", { code: "seq_cycle", node: "N2" })).toBe(
      "Atrium refused the graph: seq_cycle (node N2). Fix the graph and call task_propose_graph again.",
    );
    expect(errorText("task_graph_invalid", { code: "no_sink" })).toBe(
      "Atrium refused the graph: no_sink. Fix the graph and call task_propose_graph again.",
    );
    expect(errorText("task_graph_invalid", { node: 7 })).toContain("graph: ?.");
  });

  it("reads a schema issue as a limit passed or a parameter it cannot read", () => {
    expect(argumentFault({ code: "too_big", path: ["text"], maximum: 32_000 })).toStrictEqual({
      code: "task_text_too_long",
      params: { param: "text", limit: 32_000 },
    });
    expect(argumentFault({ code: "too_big", path: [0], maximum: 5 })).toStrictEqual({
      code: "task_text_too_long",
      params: { param: "?", limit: 5 },
    });
    expect(argumentFault({ code: "too_big", path: ["text"] })).toStrictEqual({ code: "task_bad_request" });
    expect(argumentFault({ code: "invalid_type", path: ["page"], maximum: 3 })).toStrictEqual({
      code: "task_bad_request",
    });
  });

  it("ends a page with where it is, only when there is more than one", () => {
    expect(pageFooter(1, 1)).toBe("");
    expect(pageFooter(1, 3)).toBe("\n[page 1 of 3; ask for the next page to read on]");
    expect(pageFooter(3, 3)).toBe("\n[page 3 of 3]");
  });

  it("says whether a proposed graph is in force or waits for the user", () => {
    expect(graphTaken(2, true)).toContain("only when the user approves");
    expect(graphTaken(2, false)).toContain("in force");
    expect(graphTaken(4, false)).toContain("version 4");
  });

  it("lets the task conversation use the read-only tools, its own and ask_user, and nothing that changes files", () => {
    for (const tool of ["read", "bash", "ls", "task_status", "task_propose_graph", "ask_user"]) {
      expect(conversationToolRefusal(tool)).toBeNull();
    }
    for (const tool of ["write", "edit", "agent_spawn", "node_done", "request_graph_change", "task_set_schedule"]) {
      expect(conversationToolRefusal(tool)).toContain("The task conversation can only use");
    }
  });
});
