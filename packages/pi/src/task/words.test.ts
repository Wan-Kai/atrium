import { describe, expect, it } from "vitest";
import { PARENT_TOOLS, READ_ONLY_TOOLS } from "../agent/words";
import { TASK_TEXT_LIMITS, TaskErrorCode } from "./schema";
import { NODE_TOOLS, errorText, nodeToolRefusal, nudgeText, resumeText, tooLong } from "./words";

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
