import { type Step, TOOL_OUTPUT_LIMIT } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  type ToolStep,
  addUsage,
  cutOutput,
  finishedSteps,
  partStep,
  turnChanges,
  turnOutcome,
  withOutput,
  withResult,
} from "./rules";

/** A tool step with the given fields. */
function tool(fields: Partial<ToolStep>): ToolStep {
  return {
    kind: "tool",
    id: "0",
    callId: "c1",
    tool: "bash",
    args: {},
    status: "running",
    output: null,
    details: null,
    ...fields,
  };
}

/** A finished edit of `path`. */
function edit(path: string, added: number, removed: number, status: ToolStep["status"] = "done"): ToolStep {
  return tool({ tool: "edit", status, details: { tool: "edit", path, diff: "", added, removed } });
}

/** A finished write of `path`. */
function write(path: string, status: ToolStep["status"] = "done"): ToolStep {
  return tool({ tool: "write", status, details: { tool: "write", path, content: "" } });
}

describe("partStep", () => {
  it("makes thinking and text steps from their blocks, untimed, with the position as id", () => {
    expect(partStep({ type: "thinking", text: "hm" }, 3)).toStrictEqual({
      kind: "thinking",
      id: "3",
      text: "hm",
      durationMs: null,
    });
    expect(partStep({ type: "text", text: "hi" }, 0)).toStrictEqual({ kind: "text", id: "0", text: "hi" });
  });

  it("makes a running tool step with the details its arguments give", () => {
    expect(partStep({ type: "toolCall", callId: "c9", tool: "read", args: { path: "a.ts" } }, 12)).toStrictEqual(
      tool({
        id: "12",
        callId: "c9",
        tool: "read",
        args: { path: "a.ts" },
        details: { tool: "read", path: "a.ts", offset: null, limit: null },
      }),
    );
  });
});

describe("cutOutput", () => {
  it("keeps output up to the limit whole", () => {
    const text = "x".repeat(TOOL_OUTPUT_LIMIT);

    expect(cutOutput("bash", text)).toStrictEqual({ text, truncated: false });
    expect(cutOutput("read", "")).toStrictEqual({ text: "", truncated: false });
  });

  it("keeps the end of a command's output and the start of other tools'", () => {
    const text = `${"a".repeat(10)}${"m".repeat(TOOL_OUTPUT_LIMIT - 10)}${"z".repeat(10)}`;

    expect(cutOutput("bash", text)).toStrictEqual({ text: text.slice(10), truncated: true });
    expect(cutOutput("read", text)).toStrictEqual({ text: text.slice(0, TOOL_OUTPUT_LIMIT), truncated: true });
  });

  it("counts bytes and never cuts a character in half", () => {
    // "文" is three bytes; the limit falls inside the character either way.
    const text = `${"a".repeat(TOOL_OUTPUT_LIMIT - 1)}文${"b".repeat(TOOL_OUTPUT_LIMIT - 1)}`;

    expect(cutOutput("read", text)).toStrictEqual({ text: "a".repeat(TOOL_OUTPUT_LIMIT - 1), truncated: true });
    expect(cutOutput("bash", text)).toStrictEqual({ text: "b".repeat(TOOL_OUTPUT_LIMIT - 1), truncated: true });
    expect(cutOutput("read", "文".repeat(TOOL_OUTPUT_LIMIT))).toStrictEqual({
      text: "文".repeat(Math.floor(TOOL_OUTPUT_LIMIT / 3)),
      truncated: true,
    });
  });
});

describe("withOutput and withResult", () => {
  it("shows a running tool's output so far, cut like a result", () => {
    expect(withOutput(tool({}), "partial")).toStrictEqual(tool({ output: { text: "partial", truncated: false } }));
  });

  it("finishes a tool as done or failed, working its details out again with the result's", () => {
    const step = tool({
      tool: "edit",
      args: { path: "a.ts" },
      details: { tool: "edit", path: "a.ts", diff: null, added: 0, removed: 0 },
    });

    expect(withResult(step, { text: "ok", isError: false, details: { diff: "+1 x\n-1 y\n+2 z" } })).toStrictEqual({
      ...step,
      status: "done",
      output: { text: "ok", truncated: false },
      details: { tool: "edit", path: "a.ts", diff: "+1 x\n-1 y\n+2 z", added: 2, removed: 1 },
    });
    expect(withResult(step, { text: "no match", isError: true, details: undefined })).toStrictEqual({
      ...step,
      status: "failed",
      output: { text: "no match", truncated: false },
    });
  });
});

describe("finishedSteps", () => {
  it("marks tools still running as unfinished and leaves every other step as it is", () => {
    const steps: Step[] = [
      { kind: "text", id: "0", text: "a" },
      tool({ id: "1", status: "running" }),
      tool({ id: "2", status: "done" }),
      tool({ id: "3", status: "failed" }),
    ];

    const finished = finishedSteps(steps);

    expect(finished).toStrictEqual([steps[0], tool({ id: "1", status: "unfinished" }), steps[2], steps[3]]);
    expect(finished[0]).toBe(steps[0]);
    expect(finished[2]).toBe(steps[2]);
  });
});

describe("turnOutcome", () => {
  it.each([
    ["stop", { outcome: "done", error: null }],
    ["length", { outcome: "done", error: null }],
    ["aborted", { outcome: "stopped", error: null }],
    ["toolUse", { outcome: "stopped", error: null }],
  ] as const)("reads a turn whose last reply ended with %s", (stopReason, expected) => {
    expect(turnOutcome({ stopReason, errorMessage: "ignored" })).toStrictEqual(expected);
  });

  it("reads a failed last reply as failed with pi's text, or empty text when pi gave none", () => {
    expect(turnOutcome({ stopReason: "error", errorMessage: "429" })).toStrictEqual({
      outcome: "failed",
      error: "429",
    });
    expect(turnOutcome({ stopReason: "error", errorMessage: null })).toStrictEqual({ outcome: "failed", error: "" });
  });

  it("reads a turn without a reply as stopped", () => {
    expect(turnOutcome(null)).toStrictEqual({ outcome: "stopped", error: null });
  });
});

describe("turnChanges", () => {
  it("adds up each file's edits in the order files were first changed", () => {
    expect(turnChanges([edit("b.ts", 1, 2), edit("a.ts", 3, 0), edit("b.ts", 4, 5)])).toStrictEqual([
      { path: "b.ts", added: 5, removed: 7 },
      { path: "a.ts", added: 3, removed: 0 },
    ]);
  });

  it("lists a written file without counts, and keeps them unknown once a file was written", () => {
    expect(turnChanges([edit("a.ts", 1, 1), write("a.ts"), edit("a.ts", 2, 0), write("b.ts")])).toStrictEqual([
      { path: "a.ts", added: null, removed: null },
      { path: "b.ts", added: null, removed: null },
    ]);
  });

  it("leaves out tools that did not succeed, other tools and other steps", () => {
    expect(
      turnChanges([
        edit("a.ts", 1, 1, "failed"),
        edit("b.ts", 1, 1, "running"),
        write("c.ts", "unfinished"),
        tool({ status: "done", details: { tool: "bash", command: "rm x" } }),
        tool({ status: "done", details: null }),
        { kind: "text", id: "9", text: "edited d.ts" },
      ]),
    ).toStrictEqual([]);
  });
});

describe("addUsage", () => {
  it("starts from nothing and adds up input and output", () => {
    expect(addUsage(null, { input: 3, output: 4 })).toStrictEqual({ input: 3, output: 4 });
    expect(addUsage({ input: 3, output: 4 }, { input: 10, output: 1 })).toStrictEqual({ input: 13, output: 5 });
  });
});
