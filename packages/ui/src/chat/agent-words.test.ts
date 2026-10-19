import type { AgentNoticeEvent } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_VERBS,
  EVENT_WORDS,
  QUEUE_EVENT_WORDS,
  ROLE_WORDS,
  agentToolObject,
  eventLine,
  sourceLine,
  tookWords,
} from "./agent-words";

/** A child's event: 审查 finished its task. */
const FINISHED: AgentNoticeEvent = {
  sessionId: "s1",
  name: "audit",
  title: "审查",
  taskId: "t1",
  event: "finished",
  reason: null,
  elapsedMs: 59_400,
  question: null,
  branch: null,
  changes: null,
};

describe("tookWords", () => {
  it("says seconds under a minute, and minutes and seconds past it", () => {
    expect([tookWords(0), tookWords(59_400), tookWords(59_600), tookWords(192_000)]).toStrictEqual([
      "用时 0 秒",
      "用时 59 秒",
      "用时 1 分 0 秒",
      "用时 3 分 12 秒",
    ]);
  });
});

describe("eventLine and sourceLine", () => {
  it("say who and what, with the time a task took or the first line of a question", () => {
    const asked = { ...FINISHED, event: "question" as const, question: "哪个？\nA 还是 B" };

    expect([
      eventLine(FINISHED),
      eventLine(asked),
      eventLine({ ...asked, question: null }),
      eventLine({ ...FINISHED, event: "needs_you" }),
      eventLine({ ...FINISHED, elapsedMs: null }),
    ]).toStrictEqual([
      "来自子对话「审查」· 完成 · 用时 59 秒",
      "来自子对话「审查」· 在问 · 哪个？",
      "来自子对话「审查」· 在问 · 用时 59 秒",
      "来自子对话「审查」· 在等你",
      "来自子对话「审查」· 完成",
    ]);
  });

  it("join a report's events, and say a task came from the parent's agent", () => {
    const failed = { ...FINISHED, title: "测试", event: "failed" as const, elapsedMs: null };

    expect([
      sourceLine({ kind: "report", events: [FINISHED, failed] }),
      sourceLine({ kind: "task", fromTitle: "修复", taskId: "t", text: "go" }),
    ]).toStrictEqual([
      "来自子对话「审查」· 完成 · 用时 59 秒；来自子对话「测试」· 出错",
      "来自主对话的 agent · 交代的事",
    ]);
  });
});

describe("agentToolObject", () => {
  it("names the child, the question or the progress, by their first line, and nothing it cannot read", () => {
    expect([
      agentToolObject("agent_spawn", { name: "tests" }),
      agentToolObject("agent_reply", { to: "id:s1", answer: "A" }),
      agentToolObject("agent_read", { to: "tests" }),
      agentToolObject("agent_stop", { to: "tests" }),
      agentToolObject("report_progress", { message: "读完了\n下一步" }),
      agentToolObject("agent_wait", { tasks: [] }),
      agentToolObject("agent_spawn", { name: 3 }),
      agentToolObject("agent_list", {}),
    ]).toStrictEqual(["tests", "id:s1", "tests", "tests", "读完了", "所有子对话", "", ""]);
  });
});

describe("the words", () => {
  it("say each event, in the transcript and in the queue panel, and each role", () => {
    expect([EVENT_WORDS, QUEUE_EVENT_WORDS, ROLE_WORDS]).toStrictEqual([
      { finished: "完成", failed: "出错", question: "在问", needs_you: "在等你", stopped: "已停下", ended: "已结束" },
      {
        finished: "完成",
        failed: "出错",
        question: "在问你的 agent",
        needs_you: "在等你",
        stopped: "已停下",
        ended: "已结束",
      },
      { explore: "只读", advise: "顾问", work: "可写" },
    ]);
  });

  it("give each agent tool's verb, running and done", () => {
    expect(AGENT_TOOL_VERBS).toStrictEqual({
      agent_spawn: ["正在开子对话", "开子对话"],
      agent_send: ["正在交代子对话", "交代了子对话"],
      agent_wait: ["等子对话", "等了子对话"],
      agent_reply: ["正在回答", "回答了"],
      agent_list: ["正在列出子对话", "列出了子对话"],
      agent_read: ["正在读子对话", "读了子对话"],
      agent_stop: ["正在停下子对话", "停下了子对话"],
      agent_models: ["正在列出模型", "列出了模型"],
      report_progress: ["汇报进度", "汇报了进度"],
      ask_parent: ["在问主 agent", "问了主 agent"],
    });
  });

  it("show a question only for a question, and no empty tail", () => {
    expect([
      eventLine({ ...FINISHED, question: "不该显示" }),
      eventLine({ ...FINISHED, event: "question", question: "" }),
      eventLine({ ...FINISHED, event: "question", question: "\n第二行" }),
    ]).toStrictEqual(["来自子对话「审查」· 完成 · 用时 59 秒", "来自子对话「审查」· 在问", "来自子对话「审查」· 在问"]);
  });

  it("name nothing for a tool without an object, though its arguments hold a message", () => {
    expect(agentToolObject("agent_list", { message: "x", name: "y", to: "z", question: "q" })).toBe("");
  });
});
