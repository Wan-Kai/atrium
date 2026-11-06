import { describe, expect, it } from "vitest";
import { MINUTE, NOW, node, summary } from "./task-fixtures";
import {
  FAILURE_WORDS,
  MERGE_BLOCK_WORDS,
  agoWords,
  currentWords,
  describeTaskError,
  modelWords,
  roleWords,
  statusWords,
} from "./task-words";

/** The words of a row with these fields set. */
const at = (changes: Parameters<typeof summary>[1]) => statusWords(summary("a", changes));

describe("the task area's words (SPEC-0006, 界面 and 错误码)", () => {
  it("words the errors of SPEC-0006's draft, and any other code as a plain failure", () => {
    expect(describeTaskError("task_not_found")).toBe("这个任务已经不在了");
    expect(describeTaskError("task_state_invalid")).toBe("任务的状态变了，刷新后再试");
    expect(describeTaskError("task_back_limit")).toBe("这条打回边已经用了两次");
    expect(describeTaskError("task_read_only")).toBe("这个任务是别的进程在跑的，Atrium 里只能看");
    expect(describeTaskError("merge_git_failed")).toBe("git 出错了，没有合并，主目录没动");
    expect(describeTaskError("something_new")).toBe("这个操作没能完成");
  });

  it("has a sentence for every reason a node fails and a merge is held back", () => {
    expect(Object.keys(FAILURE_WORDS)).toHaveLength(6);
    expect(Object.keys(MERGE_BLOCK_WORDS)).toHaveLength(6);
    expect(Object.values(MERGE_BLOCK_WORDS).every((words) => words.length > 4)).toBe(true);
  });

  it("says what each row waits for, in the colour that fits", () => {
    const failed = { id: "N4b", name: "审查", state: "failed" } as const;

    expect(at({ status: "designing" })).toStrictEqual({ text: "等你确认初始图", tone: "attn" });
    expect(at({ status: "stopped", attention: "failed", current: failed })).toStrictEqual({
      text: "N4b 失败 · 已停下",
      tone: "danger",
    });
    expect(at({ status: "waiting", attention: "question" }).text).toBe("等你回答");
    expect(at({ status: "waiting", attention: "human" }).text).toBe("等你验收");
    expect(at({ status: "waiting", attention: "merge_blocked" }).text).toBe("合并被挡住");
    expect(at({ status: "waiting", attention: "graph_change" }).text).toBe("等你批准改图");
    expect(at({ status: "stopped", paused: true }).text).toBe("已暂停");
    expect(at({ status: "stopped", current: { id: "N2", name: "x", state: "stopped" } }).text).toBe("N2 已停下");
    expect(at({ status: "running" })).toStrictEqual({ text: "运转中", tone: "run" });
    expect(at({ status: "done" })).toStrictEqual({ text: "已完成", tone: "dim" });
    expect(at({ status: "cancelled" }).text).toBe("已取消");
  });

  it("names the current node, and the places of a task with none", () => {
    expect(currentWords(summary("a", { current: { id: "N2", name: "实现", state: "running" } }))).toBe("N2 实现");
    expect(currentWords(summary("a", { status: "designing" }))).toBe("设计中");
    expect(currentWords(summary("a", { status: "done" }))).toBe("完成");
    expect(currentWords(summary("a"))).toBe("");
  });

  it("words a model as the composer does, leaving out an off level", () => {
    expect(modelWords({ providerId: "p", modelId: "opus-5.5", thinking: "high" })).toBe("opus-5.5 · 高");
    expect(modelWords({ providerId: "p", modelId: "opus-5.5", thinking: "off" })).toBe("opus-5.5");
    expect(modelWords({ providerId: "p", modelId: "grok-4.7" })).toBe("grok-4.7");
  });

  it("says how long ago, by minutes, hours and days", () => {
    expect(agoWords(NOW - 20_000, NOW)).toBe("刚刚");
    expect(agoWords(NOW - 4 * MINUTE, NOW)).toBe("4 分钟前");
    expect(agoWords(NOW - 6 * 60 * MINUTE, NOW)).toBe("6 小时前");
    expect(agoWords(NOW - 30 * 60 * MINUTE, NOW)).toBe("昨天");
    expect(agoWords(NOW - 72 * 60 * MINUTE, NOW)).toBe("3 天前");
    expect(agoWords(NOW + MINUTE, NOW)).toBe("刚刚");
  });

  it("gives a node's second line from its role and place, and a human node's its own", () => {
    expect(roleWords(node("N1", { role: "explore", place: "readonly" }))).toBe("explore · 只读");
    expect(roleWords(node("N2", { role: "work", place: "workspace" }))).toBe("work · 任务 worktree");
    expect(roleWords(node("N5", { kind: "human", role: undefined }))).toBe("由你来做");
  });
});
