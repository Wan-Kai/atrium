import type { Step, Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  type ToolStep,
  countProcess,
  describeExplore,
  describeStep,
  exploredFiles,
  formatDuration,
  formatTokens,
  hostNoticeText,
  layoutTurn,
  opening,
  parseDisplayDiff,
  processParts,
  transcriptMarkdown,
} from "./turn-layout";

/** A tool step of `tool` with `status`. */
function tool(
  id: string,
  name: string,
  status: ToolStep["status"] = "done",
  details: ToolStep["details"] = null,
): ToolStep {
  return { kind: "tool", id, callId: `c${id}`, tool: name, args: {}, status, output: null, details, partial: false };
}

/** A text step. */
function text(id: string, value: string): Step {
  return { kind: "text", id, text: value };
}

/** A finished turn with these steps. */
function turn(steps: Step[], fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id: "t1",
    user: { text: "do it", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    steps,
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1000,
    usage: null,
    changes: [],
    ...fields,
  };
}

describe("layoutTurn", () => {
  it("takes the last step as the reply when it is text, and leaves earlier text in the process", () => {
    const steps = [text("0", "looking"), tool("1", "bash"), text("2", "done")];

    expect(layoutTurn(turn(steps))).toStrictEqual({
      process: [
        { kind: "step", step: steps[0] },
        { kind: "step", step: steps[1] },
      ],
      reply: steps[2],
    });
  });

  it("has no reply when the turn ended on something other than text", () => {
    const steps = [text("0", "first"), tool("1", "bash", "unfinished")];

    expect(layoutTurn(turn(steps)).reply).toBeNull();
    expect(layoutTurn(turn([])).reply).toBeNull();
  });

  it("shows two or more read-only calls in a row as one row, and a single one as itself", () => {
    const reads = [tool("0", "read"), tool("1", "grep"), tool("2", "ls")];
    const alone = tool("4", "find");
    const steps = [...reads, tool("3", "bash"), alone, tool("5", "read"), tool("6", "find")];

    expect(layoutTurn(turn(steps)).process).toStrictEqual([
      { kind: "explore", id: "0", steps: reads },
      { kind: "step", step: steps[3] },
      { kind: "explore", id: "4", steps: [alone, steps[5], steps[6]] },
    ]);
    expect(layoutTurn(turn([alone, text("1", "ok")])).process).toStrictEqual([{ kind: "step", step: alone }]);
  });
});

describe("countProcess and processParts", () => {
  it("counts files read, searches and commands, failed commands apart", () => {
    const counts = countProcess([
      tool("0", "read"),
      tool("1", "read"),
      tool("2", "grep"),
      tool("3", "find"),
      tool("4", "ls"),
      tool("5", "bash"),
      tool("5b", "bash"),
      tool("6", "bash", "failed"),
      tool("7", "edit"),
      text("8", "x"),
    ]);

    expect(counts).toStrictEqual({ reads: 2, searches: 3, commands: 3, failedCommands: 1 });
    expect(processParts(counts, 3)).toStrictEqual(["读了 2 个文件", "搜索了 3 次", "跑了 3 条命令", "改了 3 个文件"]);
  });

  it("names nothing that did not happen", () => {
    expect(processParts(countProcess([]), 0)).toStrictEqual([]);
  });
});

describe("formatDuration and formatTokens", () => {
  it.each([
    [0, "不到 1 秒"],
    [999, "不到 1 秒"],
    [1000, "1 秒"],
    [59_999, "59 秒"],
    [60_000, "1 分 0 秒"],
    [133_000, "2 分 13 秒"],
    [3_599_999, "59 分 59 秒"],
    [3_600_000, "1 小时 0 分"],
    [3_840_000, "1 小时 4 分"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [18_400, "18.4K"],
    [99_950, "100K"],
    [152_000, "152K"],
    [999_499, "999K"],
    [1_000_000, "1M"],
    [1_340_000, "1.3M"],
  ])("formats %d tokens as %s", (tokens, expected) => {
    expect(formatTokens(tokens)).toBe(expected);
  });
});

describe("parseDisplayDiff", () => {
  it("reads pi's added, removed, context and skipped lines with their numbers", () => {
    expect(parseDisplayDiff(" 9 a\n-10 b\n+10 c\n+11  indented\n    ...\n 99 z")).toStrictEqual([
      { kind: "context", number: 9, text: "a" },
      { kind: "del", number: 10, text: "b" },
      { kind: "add", number: 10, text: "c" },
      { kind: "add", number: 11, text: " indented" },
      { kind: "gap", number: null, text: "…" },
      { kind: "context", number: 99, text: "z" },
    ]);
  });

  it("keeps padded numbers and a line in no known form", () => {
    expect(parseDisplayDiff("+ 7 x\n-  8 \nodd")).toStrictEqual([
      { kind: "add", number: 7, text: "x" },
      { kind: "del", number: 8, text: "" },
      { kind: "context", number: null, text: "dd" },
    ]);
  });

  it("takes only a whole line of dots for skipped lines, and a number only at a line's start", () => {
    expect(parseDisplayDiff(" 12 a...\n ...more\n+x 12 y")).toStrictEqual([
      { kind: "context", number: 12, text: "a..." },
      { kind: "context", number: null, text: "...more" },
      { kind: "add", number: null, text: "x 12 y" },
    ]);
  });
});

describe("opening", () => {
  it("keeps the first sentence, marking that more follows", () => {
    expect(opening("先看现有实现。然后再改。")).toBe("先看现有实现…");
    expect(opening("  Look first. Then edit.")).toBe("Look first…");
    expect(opening("one line\nanother")).toBe("one line…");
    expect(opening("just this")).toBe("just this");
    expect(opening("")).toBe("");
  });

  it("cuts a long sentence, and keeps one exactly as long as allowed", () => {
    expect(opening("x".repeat(60), 10)).toBe(`${"x".repeat(10)}…`);
    expect(opening("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("describeStep", () => {
  it("says how long thinking took only when it was timed, and that it is going on while live", () => {
    const step: Step = { kind: "thinking", id: "0", text: "Plan. More.", durationMs: 6_400 };

    expect(describeStep(step, false)).toStrictEqual({ verb: "思考了 6 秒", object: "Plan…", end: null });
    expect(describeStep({ ...step, durationMs: 200 }, false).verb).toBe("思考了 1 秒");
    expect(describeStep({ ...step, durationMs: null }, false).verb).toBe("思考过程");
    expect(describeStep(step, true).verb).toBe("思考中");
  });

  it("describes text, steers and retries", () => {
    expect(describeStep(text("0", "I'll look first."), false)).toStrictEqual({
      verb: "说明",
      object: "I'll look first",
      end: null,
    });
    expect(describeStep({ kind: "steer", id: "1", text: "also b" }, false)).toStrictEqual({
      verb: "你插话",
      object: "also b",
      end: null,
    });
    expect(describeStep({ kind: "retry", id: "2", attempt: 2, maxAttempts: null, error: "503" }, false)).toStrictEqual({
      verb: "自动重试 · 第 2 次",
      object: "503",
      end: null,
    });
    expect(describeStep({ kind: "retry", id: "2", attempt: 2, maxAttempts: 5, error: "503" }, false)).toStrictEqual({
      verb: "自动重试 · 第 2 / 5 次",
      object: "503",
      end: null,
    });
  });

  it("describes each built-in tool by what it did, or is doing, and how it ended", () => {
    const bash = { tool: "bash", command: "pnpm test" } as const;
    const read = { tool: "read", path: "a.ts", offset: null, limit: null } as const;
    const edit = { tool: "edit", path: "a.ts", diff: "+1 x", added: 1, removed: 0 } as const;
    const write = { tool: "write", path: "b.ts", content: "x" } as const;

    expect(describeStep(tool("0", "bash", "done", bash), false)).toStrictEqual({
      verb: "运行了",
      object: "pnpm test",
      end: "通过",
    });
    expect(describeStep(tool("0", "bash", "failed", bash), false).end).toBe("失败");
    expect(describeStep(tool("0", "bash", "running", bash), true)).toStrictEqual({
      verb: "正在运行",
      object: "pnpm test",
      end: null,
    });
    expect(describeStep(tool("0", "read", "running", read), true).verb).toBe("正在读");
    expect(describeStep(tool("0", "edit", "running", edit), true)).toStrictEqual({
      verb: "正在编辑",
      object: "a.ts",
      end: null,
    });
    expect(describeStep(tool("0", "write", "running", write), true).verb).toBe("正在写入");
    expect(describeStep(tool("0", "read", "done", read), false)).toStrictEqual({
      verb: "读了",
      object: "a.ts",
      end: null,
    });
    expect(describeStep(tool("0", "read", "done", { ...read, offset: 40, limit: 20 }), false).object).toBe(
      "a.ts 第 40 行起",
    );
    expect(describeStep(tool("0", "edit", "done", edit), false)).toStrictEqual({
      verb: "编辑了",
      object: "a.ts",
      end: "+1 −0",
    });
    expect(describeStep(tool("0", "edit", "done", { ...edit, diff: null }), false).end).toBeNull();
    expect(describeStep(tool("0", "edit", "unfinished", edit), false).end).toBe("未完成");
    expect(describeStep(tool("0", "write", "done", write), false)).toStrictEqual({
      verb: "写入了",
      object: "b.ts",
      end: null,
    });
    expect(describeStep(tool("0", "write", "failed", write), false).end).toBe("失败");
    expect(describeStep(tool("0", "read", "failed", read), false).end).toBe("失败");
  });

  it("keeps arguments exactly 80 characters long whole", () => {
    const step = { ...tool("0", "grep"), args: { p: "x".repeat(72) } };

    expect(JSON.stringify(step.args)).toHaveLength(80);
    expect(describeStep(step, false).object).toBe(JSON.stringify(step.args));
  });

  it("shows another tool by its name and arguments, cut to one line", () => {
    const step = { ...tool("0", "grep"), args: { pattern: "x".repeat(100) } };

    expect(describeStep(step, false)).toStrictEqual({
      verb: "grep",
      object: `${JSON.stringify(step.args).slice(0, 80)}…`,
      end: null,
    });
    expect(describeStep({ ...tool("0", "grep", "running"), args: { pattern: "y" } }, true)).toStrictEqual({
      verb: "grep",
      object: '{"pattern":"y"}',
      end: null,
    });
  });
});

describe("describeExplore", () => {
  it("says what looking around came to, and that it is going on while live", () => {
    const read = { tool: "read", path: "a.ts", offset: null, limit: null } as const;
    const steps = [
      tool("0", "read", "done", read),
      tool("1", "grep"),
      tool("2", "read", "done", read),
      tool("3", "ls"),
    ];

    expect(describeExplore(steps, false)).toStrictEqual({
      verb: "探索了代码库",
      object: "读了 2 个文件，搜索了 2 次",
      end: null,
    });
    expect(describeExplore(steps, true).verb).toBe("正在探索代码库");
    expect(describeExplore(steps.slice(0, 1), false).object).toBe("读了 1 个文件");
    expect(describeExplore([tool("0", "grep"), tool("1", "find")], false).object).toBe("搜索了 2 次");
  });
});

describe("exploredFiles", () => {
  it("lists the files read, each once, in the order first read", () => {
    /** A read of `path`. */
    const read = (id: string, path: string) =>
      tool(id, "read", "done", { tool: "read", path, offset: null, limit: null });

    expect(exploredFiles([read("0", "b.ts"), tool("1", "grep"), read("2", "a.ts"), read("3", "b.ts")])).toStrictEqual([
      "b.ts",
      "a.ts",
    ]);
  });
});

describe("transcriptMarkdown", () => {
  it("writes every step of the process, read-only calls one by one, thinking as finished", () => {
    const steps: Step[] = [
      { kind: "thinking", id: "0", text: "Plan.", durationMs: 2_000 },
      tool("1", "read", "done", { tool: "read", path: "a.ts", offset: null, limit: null }),
      tool("2", "grep"),
      text("3", "done"),
    ];

    expect(transcriptMarkdown([turn(steps)])).toBe(
      "> do it\n\n- 思考了 2 秒 · Plan\n- 读了 · a.ts\n- grep · {}\n\ndone\n",
    );
  });

  it("writes each turn's question, process and reply, and notices, separated by rules", () => {
    const steps = [tool("0", "bash", "done", { tool: "bash", command: "ls" }), text("1", "**Done.**")];

    expect(
      transcriptMarkdown([
        turn(steps, {
          user: { text: "list\nfiles", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
        }),
        { kind: "notice", id: "n", notice: "compacted", tokensBefore: 152_000, summary: "", timestamp: 0 },
        turn([], { outcome: "failed", error: "429" }),
      ]),
    ).toBe(
      "> list\n> files\n\n- 运行了 · ls（通过）\n\n**Done.**\n\n---\n\n> 上下文已压缩 · 压缩前 152K tokens\n\n---\n\n> do it\n\n> 出错：429\n",
    );
  });

  it("writes a question that started with a skill as it was typed", () => {
    const user = { text: "this\nfile", images: 0, clientMessageId: null, auto: false, timestamp: 0 };

    expect(transcriptMarkdown([turn([], { user: { ...user, command: { kind: "skill", name: "review" } } })])).toBe(
      "> /skill:review this\n> file\n",
    );
  });
});

/** The notice of an extension's question that ended so. */
function ended(
  title: string,
  outcome: "answered" | "cancelled" | "timed_out" | "stale",
  value: string | null,
  confirmed: boolean | null,
) {
  return { kind: "notice", id: "n", notice: "interaction", title, outcome, value, confirmed, timestamp: 0 } as const;
}

describe("hostNoticeText", () => {
  it("says how pi was restarted, and how each question ended, with its answer", () => {
    expect(
      [
        { kind: "notice", id: "n", notice: "restarted", attempt: 2, timestamp: 0 } as const,
        ended("用哪个？", "answered", "vitest", null),
        ended("删掉吗？", "answered", null, true),
        ended("真的吗？", "answered", null, false),
        ended("名字", "cancelled", null, null),
        ended("继续？", "timed_out", null, null),
        ended("还在吗？", "stale", null, null),
      ].map(hostNoticeText),
    ).toStrictEqual([
      "进程已自动重启（第 2 / 3 次）",
      "用哪个？ → vitest",
      "删掉吗？ → 是",
      "真的吗？ → 否",
      "名字 → 已取消",
      "继续？ → 已超时",
      "还在吗？ → 已作废（pi 已退出）",
    ]);
    expect(transcriptMarkdown([ended("用哪个？", "answered", "vitest", null)])).toBe("> 用哪个？ → vitest\n");
  });

  it("says where a child forked into a new worktree works now, and whose the old path is (SPEC-0002)", () => {
    const note = {
      kind: "notice",
      id: "n",
      notice: "note",
      note: "worktree_moved",
      from: "~/work/atrium",
      to: "~/work/atrium.worktrees/tests",
      timestamp: 0,
    } as const;

    expect(hostNoticeText(note)).toBe(
      "在新的 worktree 里继续：~/work/atrium.worktrees/tests（之前的路径属于 ~/work/atrium）",
    );
    expect(transcriptMarkdown([note])).toBe(
      "> 在新的 worktree 里继续：~/work/atrium.worktrees/tests（之前的路径属于 ~/work/atrium）\n",
    );
  });
});
