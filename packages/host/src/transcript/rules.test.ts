import { STEP_TEXT_LIMIT, type Step, type TranscriptItem } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  type ToolStep,
  addUsage,
  finishedSteps,
  forTransport,
  itemForTransport,
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
    partial: false,
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

  it("keeps the arguments of any other tool as they are, content included, even without details", () => {
    expect(partStep({ type: "toolCall", callId: "c1", tool: "notes", args: { content: "x" } }, 0)).toStrictEqual(
      tool({ id: "0", callId: "c1", tool: "notes", args: { content: "x" } }),
    );
    expect(
      partStep({ type: "toolCall", callId: "c2", tool: "bash", args: { command: "ls", content: "y" } }, 1),
    ).toMatchObject({
      args: { command: "ls", content: "y" },
    });
  });

  it("keeps a write's content in its details only", () => {
    expect(
      partStep({ type: "toolCall", callId: "c1", tool: "write", args: { path: "a.ts", content: "x", mode: 1 } }, 0),
    ).toStrictEqual(
      tool({
        id: "0",
        callId: "c1",
        tool: "write",
        args: { path: "a.ts", mode: 1 },
        details: { tool: "write", path: "a.ts", content: "x" },
      }),
    );
  });
});

describe("withOutput and withResult", () => {
  it("shows a running tool's whole output so far", () => {
    const long = "x".repeat(STEP_TEXT_LIMIT * 2);

    expect(withOutput(tool({}), long)).toStrictEqual(tool({ output: long }));
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
      output: "ok",
      details: { tool: "edit", path: "a.ts", diff: "+1 x\n-1 y\n+2 z", added: 2, removed: 1 },
    });
    expect(withResult(step, { text: "no match", isError: true, details: undefined })).toStrictEqual({
      ...step,
      status: "failed",
      output: "no match",
    });
  });

  it("finishes a tool without details", () => {
    expect(withResult(tool({ tool: "notes" }), { text: "ok", isError: false, details: undefined })).toStrictEqual(
      tool({ tool: "notes", status: "done", output: "ok" }),
    );
  });

  it("keeps a write's content, which its result does not have", () => {
    const step = tool({
      tool: "write",
      args: { path: "a.ts" },
      details: { tool: "write", path: "a.ts", content: "x" },
    });

    expect(withResult(step, { text: "Successfully wrote", isError: false, details: undefined })).toStrictEqual({
      ...step,
      status: "done",
      output: "Successfully wrote",
    });
  });
});

describe("forTransport", () => {
  const long = `${"a".repeat(10)}${"m".repeat(STEP_TEXT_LIMIT)}${"z".repeat(10)}`;

  it("sends a step without long text as it is", () => {
    const step = tool({ output: "x".repeat(STEP_TEXT_LIMIT), args: { command: "ls" } });
    const text: Step = { kind: "text", id: "1", text: long };

    expect(forTransport(step)).toBe(step);
    expect(forTransport(text)).toBe(text);
  });

  it("sends the end of a command's long output and the start of any other tool's, marked partial", () => {
    expect(forTransport(tool({ output: long }))).toStrictEqual(tool({ output: long.slice(20), partial: true }));
    expect(forTransport(tool({ tool: "read", output: long }))).toStrictEqual(
      tool({ tool: "read", output: long.slice(0, STEP_TEXT_LIMIT), partial: true }),
    );
  });

  it("previews a long write content, edit diff and long strings anywhere in the arguments", () => {
    const head = long.slice(0, STEP_TEXT_LIMIT);

    expect(
      forTransport(tool({ tool: "write", details: { tool: "write", path: "a.ts", content: long } })),
    ).toStrictEqual(tool({ tool: "write", details: { tool: "write", path: "a.ts", content: head }, partial: true }));
    expect(
      forTransport(tool({ tool: "edit", details: { tool: "edit", path: "a.ts", diff: long, added: 1, removed: 0 } })),
    ).toStrictEqual(
      tool({ tool: "edit", details: { tool: "edit", path: "a.ts", diff: head, added: 1, removed: 0 }, partial: true }),
    );
    expect(
      forTransport(
        tool({ tool: "edit", args: { path: "a.ts", edits: [{ oldText: long, newText: "b" }], n: 3, x: null } }),
      ),
    ).toStrictEqual(
      tool({
        tool: "edit",
        args: { path: "a.ts", edits: [{ oldText: head, newText: "b" }], n: 3, x: null },
        partial: true,
      }),
    );
  });

  it("counts bytes and never cuts a character in half", () => {
    // "文" is three bytes; the limit falls inside the character either way.
    const text = `${"a".repeat(STEP_TEXT_LIMIT - 1)}文${"b".repeat(STEP_TEXT_LIMIT - 1)}`;

    expect(forTransport(tool({ tool: "read", output: text }))).toMatchObject({
      output: "a".repeat(STEP_TEXT_LIMIT - 1),
    });
    expect(forTransport(tool({ output: text }))).toMatchObject({ output: "b".repeat(STEP_TEXT_LIMIT - 1) });
    expect(forTransport(tool({ tool: "read", output: "文".repeat(STEP_TEXT_LIMIT) }))).toMatchObject({
      output: "文".repeat(Math.floor(STEP_TEXT_LIMIT / 3)),
    });
    expect(forTransport(tool({ output: "文".repeat(STEP_TEXT_LIMIT / 3) }))).toMatchObject({ partial: false });
  });

  it("sends an item as it is unless one of its steps is shortened", () => {
    const short = { kind: "turn", id: "t", steps: [tool({ output: "x" })] } as unknown as TranscriptItem;
    const notice: TranscriptItem = {
      kind: "notice",
      id: "n",
      notice: "compacted",
      tokensBefore: 0,
      tokensAfter: null,
      summary: long,
      timestamp: 0,
    };
    const kept = tool({ id: "0", output: "x" });
    const big = { kind: "turn", id: "t", steps: [kept, tool({ id: "1", output: long })] } as unknown as Extract<
      TranscriptItem,
      { kind: "turn" }
    >;

    expect(itemForTransport(short)).toBe(short);
    expect(itemForTransport(notice)).toBe(notice);
    const sent = itemForTransport(big) as typeof big;
    expect(sent.steps[0]).toBe(kept);
    expect(sent.steps[1]).toMatchObject({ partial: true });
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
