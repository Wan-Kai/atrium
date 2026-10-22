import type { AgentEventKind, AgentNoticeEvent, AskedQuestion, QuestionOutcome, Step, Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  type ToolStep,
  compactedText,
  compactionDetail,
  countProcess,
  describeExplore,
  describeStep,
  exploredFiles,
  formatDuration,
  formatTokens,
  hostNoticeText,
  laneLayout,
  layoutTurn,
  processSteps,
  opening,
  parseDisplayDiff,
  processParts,
  questionRecord,
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

/** Two questions `ask_user` asked: one choice, then several. */
const QUESTIONS: AskedQuestion[] = [
  {
    header: "范围",
    question: "改到哪？",
    multiSelect: false,
    options: [
      { label: "收件箱", description: "", preview: null, recommended: true },
      { label: "侧栏", description: "", preview: null, recommended: false },
    ],
  },
  {
    header: "测试",
    question: "补哪些？",
    multiSelect: true,
    options: [
      { label: "单元", description: "", preview: null, recommended: false },
      { label: "组件", description: "", preview: null, recommended: false },
      { label: "端到端", description: "", preview: null, recommended: false },
    ],
  },
];

/**
 * An `ask_user` step (SPEC-0003).
 *
 * @param id - Its id.
 * @param status - How the call stands.
 * @param outcome - How its questions ended.
 * @param questions - What it asked.
 * @returns The step.
 */
function asking(
  id: string,
  status: ToolStep["status"],
  outcome: QuestionOutcome | null,
  questions: AskedQuestion[] = QUESTIONS,
): ToolStep {
  return tool(id, "ask_user", status, { tool: "ask_user", questions, outcome });
}

/** Answers to `QUESTIONS`. */
const ANSWERED: QuestionOutcome = {
  kind: "answered",
  answers: [
    { selected: [1], other: null },
    { selected: [0, 2], other: "加一个基准\n夜间跑" },
  ],
};

/** A text step. */
function text(id: string, value: string): Step {
  return { kind: "text", id, text: value };
}

/**
 * A compaction step from 152K tokens, to `tokensAfter`.
 *
 * @remarks
 * The numbers the design shows (design-language, "压缩步骤").
 *
 * @sideEffects none
 * @param id - The step's id.
 * @param tokensAfter - The context after it, if known.
 * @param reason - What set it off.
 * @returns The step.
 */
function compaction(
  id: string,
  tokensAfter: number | null = 41_000,
  reason: "overflow" | "threshold" | null = "threshold",
): Extract<Step, { kind: "compaction" }> {
  return { kind: "compaction", id, tokensBefore: 152_000, tokensAfter, summary: "So far.", reason };
}

/** A finished turn with these steps. */
function turn(steps: Step[], fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id: "t1",
    source: null,
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

/**
 * An event of a child's task, as a notice or a wait brings it.
 *
 * @sideEffects none
 * @param taskId - The task; the child is named after it.
 * @param event - What happened.
 * @param fields - Its other fields.
 * @returns The event.
 */
function event(taskId: string, kind: AgentEventKind, fields: Partial<AgentNoticeEvent> = {}): AgentNoticeEvent {
  return {
    sessionId: `s-${taskId}`,
    name: taskId,
    title: taskId,
    taskId,
    event: kind,
    reason: null,
    elapsedMs: null,
    question: null,
    branch: null,
    changes: null,
    ...fields,
  };
}

/**
 * An `agent_spawn` call that started a child on a task.
 *
 * @sideEffects none
 * @param id - The step's id.
 * @param taskId - The task; the child is named after it.
 * @returns The step.
 */
function spawn(id: string, taskId: string): ToolStep {
  return {
    ...tool(id, "agent_spawn", "done", {
      tool: "agent",
      spawned: { sessionId: `s-${taskId}`, name: taskId, taskId, role: "explore", branch: null },
      events: [],
    }),
    args: { name: taskId },
  };
}

/**
 * An `agent_wait` call that brought these events back.
 *
 * @sideEffects none
 * @param id - The step's id.
 * @param events - The events.
 * @returns The step.
 */
function waited(id: string, events: AgentNoticeEvent[]): ToolStep {
  return tool(id, "agent_wait", "done", { tool: "agent", spawned: null, events });
}

/**
 * Notices that came in during the run.
 *
 * @sideEffects none
 * @param id - The step's id.
 * @param events - The events.
 * @returns The step.
 */
function noticed(id: string, events: [AgentNoticeEvent, ...AgentNoticeEvent[]]): Step {
  return { kind: "agent", id, source: { kind: "report", events } };
}

describe("layoutTurn", () => {
  it("omits blank thinking and text without interrupting tools or replacing a nonblank reply", () => {
    const read = tool("read", "read");
    const search = tool("search", "grep");
    const answer = text("answer", "done");
    const steps: Step[] = [
      { kind: "thinking", id: "hidden", text: "", durationMs: 2000 },
      text("empty", " \n\t"),
      read,
      { kind: "thinking", id: "blank", text: " \n", durationMs: null },
      search,
      answer,
      text("trailing", ""),
    ];

    expect(layoutTurn(turn(steps))).toStrictEqual({
      process: [{ kind: "explore", id: "read", steps: [read, search] }],
      reply: answer,
    });
  });

  it("keeps a reply visible across trailing blanks and compactions after integration", () => {
    const answer = text("answer", "done");
    const compacted = compaction("compaction");
    const value = turn([
      answer,
      { kind: "thinking", id: "blank-thinking", text: " \n", durationMs: null },
      compacted,
      text("blank-text", ""),
    ]);

    expect(layoutTurn(value)).toStrictEqual({
      process: [{ kind: "step", step: compacted }],
      reply: answer,
    });
    expect(transcriptMarkdown([value])).toContain("\n\ndone\n");
  });

  it("has no display content or exported thinking for blank-only responses", () => {
    const value = turn([{ kind: "thinking", id: "0", text: " \n", durationMs: 6000 }, text("1", "")]);

    expect(layoutTurn(value)).toStrictEqual({ process: [], reply: null });
    expect(transcriptMarkdown([value])).toBe("> do it\n");
  });

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

  it.each([1, 2])("keeps the reply outside the process after %i trailing compactions", (count) => {
    const earlier = text("0", "looking");
    const call = tool("1", "bash");
    const reply = text("2", "## Result\n\nThe complete answer.");
    const compactions = Array.from({ length: count }, (_, index) => compaction(`compact-${String(index)}`));

    expect(layoutTurn(turn([earlier, call, reply, ...compactions]))).toStrictEqual({
      process: [earlier, call, ...compactions].map((step) => ({ kind: "step", step })),
      reply,
    });
  });

  it("has no reply for only compactions or a tool followed by compaction", () => {
    const compact = compaction("2");
    const steps = [text("0", "still working"), tool("1", "bash", "unfinished"), compact];

    expect(layoutTurn(turn(steps))).toStrictEqual({
      process: steps.map((step) => ({ kind: "step", step })),
      reply: null,
    });
    expect(layoutTurn(turn([compact]))).toStrictEqual({ process: [{ kind: "step", step: compact }], reply: null });
  });

  it("exports the complete reply after trailing compaction without turning it into a process summary", () => {
    expect(transcriptMarkdown([turn([text("0", "## Result\n\nFull answer."), compaction("1")])])).toBe(
      "> do it\n\n> 压缩了上下文 · 152K → 41K\n\n## Result\n\nFull answer.\n",
    );
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

describe("layoutTurn with children", () => {
  it("makes a row of each event a wait or a notice brought, after the wait and in place of the notice", () => {
    const wait = waited("1", [event("a", "finished"), event("b", "question")]);
    const steps = [spawn("0", "a"), wait, noticed("2", [event("c", "failed")]), text("3", "done")];

    expect(layoutTurn(turn(steps)).process).toStrictEqual([
      { kind: "step", step: steps[0] },
      { kind: "step", step: wait },
      { kind: "event", id: "1:0", event: event("a", "finished") },
      { kind: "event", id: "1:1", event: event("b", "question") },
      { kind: "event", id: "2:0", event: event("c", "failed") },
    ]);
  });

  it("keeps a task that came in as a step", () => {
    const task: Step = { kind: "agent", id: "0", source: { kind: "task", fromTitle: "修复", taskId: "t", text: "go" } };

    expect(layoutTurn(turn([task])).process).toStrictEqual([{ kind: "step", step: task }]);
  });

  it("words a task's words that came into its run as the main agent speaking in, with the words", () => {
    const words: Step = {
      kind: "agent",
      id: "0",
      source: { kind: "task", fromTitle: "修复", taskId: "t", text: "also check login\nand logout" },
    };

    expect(describeStep(words, false)).toStrictEqual({ verb: "主 agent 插话", object: "also check login…", end: null });
  });
});

describe("laneLayout", () => {
  it("opens a lane for each child, runs it past the rows, touches it where the child asks, and merges it where its task ends", () => {
    const steps = [
      spawn("0", "a"),
      spawn("1", "b"),
      tool("2", "bash"),
      waited("3", [event("b", "question"), event("a", "finished", { elapsedMs: 4000 })]),
      noticed("4", [event("b", "stopped")]),
    ];

    expect(laneLayout(layoutTurn(turn(steps)).process)).toStrictEqual({
      width: 2,
      rows: [
        { through: [], opens: 0, closes: null, touches: null, goesOn: [], took: 4000 },
        { through: [0], opens: 1, closes: null, touches: null, goesOn: [], took: null },
        { through: [0, 1], opens: null, closes: null, touches: null, goesOn: [], took: null },
        { through: [0, 1], opens: null, closes: null, touches: null, goesOn: [], took: null },
        { through: [0, 1], opens: null, closes: null, touches: 1, goesOn: [], took: null },
        { through: [0, 1], opens: null, closes: 0, touches: null, goesOn: [], took: null },
        { through: [1], opens: null, closes: 1, touches: null, goesOn: [], took: null },
      ],
    });
  });

  it("gives a freed lane to the next child, leaves a task going on past the turn not ended, and no lane to another turn's", () => {
    const steps = [
      spawn("0", "a"),
      noticed("1", [event("a", "ended"), event("old", "finished")]),
      spawn("2", "b"),
      noticed("3", [event("b", "needs_you")]),
    ];

    expect(laneLayout(layoutTurn(turn(steps)).process)).toStrictEqual({
      width: 1,
      rows: [
        { through: [], opens: 0, closes: null, touches: null, goesOn: [], took: null },
        { through: [0], opens: null, closes: 0, touches: null, goesOn: [], took: null },
        { through: [], opens: null, closes: null, touches: null, goesOn: [], took: null },
        { through: [], opens: 0, closes: null, touches: null, goesOn: [0], took: null },
        { through: [0], opens: null, closes: null, touches: 0, goesOn: [0], took: null },
      ],
    });
    expect(laneLayout([])).toStrictEqual({ width: 0, rows: [] });
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
      compaction("9"),
      compaction("10", null, null),
      asking("11", "done", ANSWERED),
      asking("12", "failed", null, QUESTIONS.slice(0, 1)),
      tool("13", "ask_user"),
    ]);

    expect(counts).toStrictEqual({
      reads: 2,
      searches: 3,
      commands: 3,
      failedCommands: 1,
      compactions: 2,
      questions: 3,
    });
    expect(processParts(counts, 3)).toStrictEqual([
      "读了 2 个文件",
      "搜索了 3 次",
      "跑了 3 条命令",
      "改了 3 个文件",
      "问了你 3 个问题",
      "1 条命令没走通",
      "压缩了 2 次上下文",
    ]);
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
  it("keeps the whole first line, marking that more follows", () => {
    expect(opening("先看现有实现。然后再改。")).toBe("先看现有实现。然后再改。");
    expect(opening("我会让 Grok 4.7 审查这次改动。")).toBe("我会让 Grok 4.7 审查这次改动。");
    expect(opening("  Look first. Then edit.")).toBe("Look first. Then edit.");
    expect(opening("one line\nanother")).toBe("one line…");
    expect(opening("one line \r\nanother")).toBe("one line…");
    expect(opening("\n\n  first  real\tline \n")).toBe("first real line");
    expect(opening("just this")).toBe("just this");
    expect(opening("")).toBe("");
  });

  it("keeps more than a row shows, leaving the row to cut it", () => {
    const long = "字".repeat(120);
    expect(opening(long)).toBe(long);
    expect(opening("字".repeat(200))).toBe(`${"字".repeat(160)}…`);
  });

  it("cuts a long line, and keeps one exactly as long as allowed", () => {
    expect(opening("x".repeat(60), 10)).toBe(`${"x".repeat(10)}…`);
    expect(opening("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("describeStep", () => {
  it("says how long thinking took only when it was timed, and that it is going on while live", () => {
    const step: Step = { kind: "thinking", id: "0", text: "Plan. More.\nLater.", durationMs: 6_400 };

    expect(describeStep(step, false)).toStrictEqual({ verb: "思考了 6 秒", object: "Plan. More.…", end: null });
    expect(describeStep({ ...step, durationMs: 200 }, false).verb).toBe("思考了 1 秒");
    expect(describeStep({ ...step, durationMs: null }, false).verb).toBe("思考过程");
    expect(describeStep(step, true).verb).toBe("思考中");
  });

  it("describes text, steers and retries", () => {
    expect(describeStep(text("0", "I'll look first."), false)).toStrictEqual({
      verb: "说明",
      object: "I'll look first.",
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

  it("describes a compaction by the context before and after, an overflow by what pi does about it", () => {
    expect(describeStep(compaction("0"), false)).toStrictEqual({
      verb: "压缩了上下文",
      object: "152K → 41K",
      end: null,
    });
    expect(describeStep(compaction("0", null, null), true)).toStrictEqual({
      verb: "压缩了上下文",
      object: "压缩前 152K",
      end: null,
    });
    expect(describeStep(compaction("0", 41_000, "overflow"), false)).toStrictEqual({
      verb: "上下文超出窗口，已压缩",
      object: "",
      end: null,
    });
    expect([compactionDetail(compaction("0")), compactionDetail(compaction("0", null))]).toStrictEqual([
      "压缩前 152K tokens · 压缩后 41K · 保留了最近的原文",
      "压缩前 152K tokens · 保留了最近的原文",
    ]);
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

describe("processSteps and children", () => {
  it("gives the steps of a turn's rows, explored ones one by one, and no events", () => {
    const reads = [tool("1", "read"), tool("2", "grep")];
    const rows = layoutTurn(turn([spawn("0", "a"), ...reads, waited("3", [event("a", "finished")])])).process;

    expect(processSteps(rows).map((step) => step.id)).toStrictEqual(["0", "1", "2", "3"]);
  });

  it("merges a lane where its task failed", () => {
    const rows = layoutTurn(turn([spawn("0", "a"), noticed("1", [event("a", "failed")])])).process;

    expect(laneLayout(rows).rows.map((row) => row.closes)).toStrictEqual([null, 0]);
  });

  it("names a tool it does not know by its name, though its details are an agent tool's", () => {
    const odd = tool("0", "custom_agent", "done", { tool: "agent", spawned: null, events: [] });

    expect(describeStep(odd, false).verb).toBe("custom_agent");
  });
});

describe("describeStep for children", () => {
  it("names what the agent's tools worked on, running and done", () => {
    const running = { ...spawn("0", "tests"), status: "running" as const };
    const send = { ...tool("1", "agent_send"), args: { to: "tests", message: "再补一个" } };
    const wait = { ...tool("2", "agent_wait"), args: { tasks: ["t1", "t2"] } };
    const ask = { ...tool("3", "ask_parent", "failed"), args: { question: "vitest?\nor jest" } };

    expect(
      [running, spawn("0", "tests"), send, wait, tool("4", "agent_wait"), ask].map((step) => describeStep(step, false)),
    ).toStrictEqual([
      { verb: "正在开子对话", object: "tests", end: null },
      { verb: "开子对话", object: "tests", end: null },
      { verb: "交代了子对话", object: "tests", end: null },
      { verb: "等了子对话", object: "2 件事", end: null },
      { verb: "等了子对话", object: "所有子对话", end: null },
      { verb: "问了主 agent", object: "vitest?", end: "失败" },
    ]);
  });

  it("says where a step that came in came from", () => {
    const step = noticed("0", [event("审查", "finished", { elapsedMs: 192_000 })]);

    expect(describeStep(step, false)).toStrictEqual({
      verb: "来自子对话「审查」· 完成 · 用时 3 分 12 秒",
      object: "",
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
      "> do it\n\n- 思考了 2 秒 · Plan.\n- 读了 · a.ts\n- grep · {}\n\ndone\n",
    );
  });

  it("writes each turn's question, process and reply, and notices, separated by rules", () => {
    const steps = [tool("0", "bash", "done", { tool: "bash", command: "ls" }), text("1", "**Done.**")];

    expect(
      transcriptMarkdown([
        turn(steps, {
          user: { text: "list\nfiles", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
        }),
        {
          kind: "notice",
          id: "n",
          notice: "compacted",
          tokensBefore: 152_000,
          tokensAfter: null,
          summary: "",
          timestamp: 0,
        },
        turn([], { outcome: "failed", error: "429" }),
      ]),
    ).toBe(
      "> list\n> files\n\n- 运行了 · ls（通过）\n\n**Done.**\n\n---\n\n> 上下文已压缩 · 压缩前 152K tokens\n\n---\n\n> do it\n\n> 出错：429\n",
    );
  });

  it("writes where a turn notices or a task opened came from, and each event a child came to where it came in", () => {
    const report = turn([waited("0", [event("审查", "question", { question: "哪个？\n两种" })]), text("1", "ok")], {
      source: { kind: "report", events: [event("测试", "finished", { elapsedMs: 5_000 })] },
    });
    const task = turn([], { source: { kind: "task", fromTitle: "修复", taskId: "t", text: "补测试\n再跑一遍" } });
    const steered = turn([
      { kind: "agent", id: "0", source: { kind: "task", fromTitle: "修复", taskId: "t2", text: "再补一个" } },
    ]);

    expect(transcriptMarkdown([steered])).toBe("> do it\n\n- 主 agent 插话 · 再补一个\n");
    expect(transcriptMarkdown([report, task])).toBe(
      "> 来自子对话「测试」· 完成 · 用时 5 秒\n\n- 等了子对话 · 所有子对话\n- 来自子对话「审查」· 在问 · 哪个？\n\nok\n\n---\n\n> 来自主对话的 agent · 交代的事\n> 补测试\n> 再跑一遍\n",
    );
  });

  it("writes a compaction in the process as a quoted line, and one between turns with the context after it", () => {
    const steps = [tool("0", "bash", "done", { tool: "bash", command: "ls" }), compaction("1"), text("2", "Done.")];
    const between = { kind: "notice", id: "n", notice: "compacted", summary: "", timestamp: 0 } as const;

    expect(
      transcriptMarkdown([
        turn(steps),
        { ...between, tokensBefore: 152_000, tokensAfter: 41_000 },
        turn([compaction("0", null, "overflow")]),
      ]),
    ).toBe(
      "> do it\n\n- 运行了 · ls（通过）\n> 压缩了上下文 · 152K → 41K\n\nDone.\n\n---\n\n> 上下文已压缩 · 152K → 41K\n\n---\n\n> do it\n\n> 上下文超出窗口，已压缩\n",
    );
    expect(compactedText({ ...between, tokensBefore: 9_000, tokensAfter: null })).toBe(
      "上下文已压缩 · 压缩前 9K tokens",
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

describe("the agent's questions on the rail (SPEC-0003)", () => {
  it("says it asks you while it waits, and how the questions ended", () => {
    expect(
      [
        asking("0", "running", null),
        asking("1", "done", ANSWERED),
        asking("2", "done", { kind: "skipped" }),
        asking("3", "done", { kind: "skipped" }, QUESTIONS.slice(0, 1)),
        asking("4", "done", { kind: "reply" }),
        asking("5", "failed", null),
        asking("6", "unfinished", null),
        asking("7", "failed", { kind: "skipped" }),
      ].map((step) => describeStep(step, step.status === "running")),
    ).toStrictEqual([
      { verb: "正在问你", object: "2 个问题", end: null },
      { verb: "问了你", object: "2 个问题", end: null },
      { verb: "你跳过了", object: "这 2 个问题", end: null },
      { verb: "你跳过了", object: "这个问题", end: null },
      { verb: "你没选，直接回复了", object: "", end: null },
      { verb: "问题已取消", object: "", end: null },
      { verb: "问题已取消", object: "", end: null },
      { verb: "问题已取消", object: "", end: null },
    ]);
  });

  it("keeps a line for each answer: the options' labels joined, the other answer quoted after them", () => {
    expect(questionRecord(asking("0", "done", ANSWERED))).toStrictEqual([
      { header: "范围", answer: "侧栏" },
      { header: "测试", answer: "单元、端到端、其他：“加一个基准\n夜间跑”" },
    ]);
    expect(
      questionRecord(
        asking("1", "done", { kind: "answered", answers: [{ selected: [], other: "都不要" }] }, QUESTIONS.slice(0, 1)),
      ),
    ).toStrictEqual([{ header: "范围", answer: "其他：“都不要”" }]);
  });

  it("keeps no lines for questions skipped, replied to, still waiting, or for another tool", () => {
    expect(
      [
        asking("0", "done", { kind: "skipped" }),
        asking("1", "done", { kind: "reply" }),
        asking("2", "running", null),
        tool("3", "bash", "done", { tool: "bash", command: "ls" }),
        tool("4", "grep"),
      ].map(questionRecord),
    ).toStrictEqual([null, null, null, null, null]);
  });

  it("writes the questions and answers into the Markdown as a quote", () => {
    expect(transcriptMarkdown([turn([asking("0", "done", ANSWERED), text("1", "好")])])).toBe(
      "> do it\n\n> 问了你 · 2 个问题\n> 范围 · 改到哪？ —— 侧栏\n> 测试 · 补哪些？ —— 单元、端到端、其他：“加一个基准 夜间跑”\n\n好\n",
    );
    expect(transcriptMarkdown([turn([asking("0", "done", { kind: "skipped" })])])).toBe(
      "> do it\n\n> 你跳过了 · 这 2 个问题\n> 范围 · 改到哪？\n> 测试 · 补哪些？\n",
    );
    const twoLines = [{ ...QUESTIONS[0], question: "改到\n哪？" }] as AskedQuestion[];
    expect(transcriptMarkdown([turn([asking("0", "done", { kind: "skipped" }, twoLines)])])).toBe(
      "> do it\n\n> 你跳过了 · 这个问题\n> 范围 · 改到 哪？\n",
    );
  });
});
