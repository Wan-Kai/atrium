import type { AgentEventKind, AgentNoticeEvent, AgentRole, AgentSource } from "@atrium/protocol";

/** What each event says, after the child's name (SPEC-0002, "显示 · 由通知开头的轮"). */
export const EVENT_WORDS: Readonly<Record<AgentEventKind, string>> = {
  finished: "完成",
  failed: "出错",
  question: "在问",
  needs_you: "在等你",
  stopped: "已停下",
  ended: "已结束",
};

/** What each event says in the queue panel, where the question is the parent agent's (SPEC-0002, "送达"). */
export const QUEUE_EVENT_WORDS: Readonly<Record<AgentEventKind, string>> = {
  ...EVENT_WORDS,
  question: "在问你的 agent",
};

/** A role's mark beside a child's name: "可写" stands out, the read-only ones are quiet (SPEC-0002, "显示"). */
export const ROLE_WORDS: Readonly<Record<AgentRole, string>> = {
  explore: "只读",
  advise: "顾问",
  work: "可写",
};

/**
 * How long a task took, in words.
 *
 * @remarks
 * "用时 3 分 12 秒", seconds alone under a minute (SPEC-0002, "显示 · 过程轨道").
 *
 * @sideEffects none
 * @param ms - The time.
 * @returns The words.
 */
export function tookWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `用时 ${seconds} 秒` : `用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * One event as a source line says it: who, and what happened.
 *
 * @remarks
 * "来自子对话「安全审查」· 完成 · 用时 3 分 12 秒"; a question gives its first line instead of a
 * time (SPEC-0002, "显示 · 由通知开头的轮").
 *
 * @sideEffects none
 * @param event - The event.
 * @returns The line's words.
 */
export function eventLine(event: AgentNoticeEvent): string {
  const tail =
    event.event === "question" && event.question !== null
      ? (event.question.split("\n")[0] ?? null)
      : event.elapsedMs !== null && event.event !== "needs_you"
        ? tookWords(event.elapsedMs)
        : null;
  return `来自子对话「${event.title}」· ${EVENT_WORDS[event.event]}${tail === null || tail === "" ? "" : ` · ${tail}`}`;
}

/**
 * A source in one line, for a step and for Markdown.
 *
 * @remarks
 * Notices joined; a task as "来自主对话的 agent · 交代的事".
 *
 * @sideEffects none
 * @param source - The source.
 * @returns The line.
 */
export function sourceLine(source: AgentSource): string {
  return source.kind === "task" ? "来自主对话的 agent · 交代的事" : source.events.map(eventLine).join("；");
}

/** The verbs of the agent's tools, running and done (SPEC-0002, "显示 · 过程轨道"). */
export const AGENT_TOOL_VERBS: Readonly<Record<string, readonly [string, string]>> = {
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
};

/**
 * What an agent tool worked on, from its arguments.
 *
 * @remarks
 * The child's name, the question or the progress; nothing for the tools without one.
 *
 * @sideEffects none
 * @param tool - The tool.
 * @param args - Its arguments.
 * @returns The object.
 */
export function agentToolObject(tool: string, args: Readonly<Record<string, unknown>>): string {
  /**
   * An argument's first line, if it is text.
   *
   * @remarks
   * The model may send anything; what is not text names nothing.
   *
   * @sideEffects none
   * @param key - The argument.
   * @returns The line, or "".
   */
  const text = (key: string): string => {
    const value = args[key];
    // Stryker disable next-line StringLiteral: splitting a string always gives a first part.
    return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
  };
  if (tool === "agent_spawn") return text("name");
  if (tool === "agent_send" || tool === "agent_reply" || tool === "agent_read" || tool === "agent_stop")
    return text("to");
  if (tool === "agent_wait") {
    const tasks = args["tasks"];
    return Array.isArray(tasks) && tasks.length > 0 ? `${tasks.length} 件事` : "所有子对话";
  }
  if (tool === "ask_parent") return text("question");
  if (tool === "report_progress") return text("message");
  return "";
}
