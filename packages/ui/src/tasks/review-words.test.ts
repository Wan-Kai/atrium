import { CommandError } from "@atrium/client";
import type { PendingReview, ReviewAction } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { describeTaskCommandError, taskReviewEnv } from "./review-words";

const env = taskReviewEnv({
  nodeName: (node) => ({ N2: "核心实现", N4: "验收合并" })[node],
  openChanges: () => undefined,
  showOnGraph: () => undefined,
});

const base: PendingReview = {
  id: "r",
  openedAt: 0,
  source: { kind: "gate", gate: "task_human" },
  subject: { code: "task_human_node", params: { taskId: "t", node: "N4", merge: true } },
  evidence: [],
  problem: null,
  actions: [],
};
const fact = (code: string, params = {}) => env.fact({ code, params, status: "ok" });
const action = (id: string, targets: ReviewAction["targets"] = []): ReviewAction => ({
  id,
  reason: "none",
  targets,
  recommended: false,
});

describe("the words of a task review", () => {
  it("names the source and what is reviewed for each gate", () => {
    expect(env.source(base)).toBe("任务");
    expect(env.subject(base)).toBe("N4 验收合并");
    expect(env.subject({ ...base, subject: { code: "task_graph_change", params: { version: 3 } } })).toBe(
      "图 v3 等你批准",
    );
    expect(env.subject({ ...base, subject: { code: "task_archive", params: {} } })).toBe("要归档 worktree 吗");
    expect(env.subject({ ...base, subject: { code: "task_human_node", params: { node: "N7" } } })).toBe("N7");
    expect(env.subject({ ...base, subject: { text: "推送前" } })).toBe("推送前");
    expect(env.subject({ ...base, subject: { code: "newer", params: {} } })).toBe("newer");
  });

  it("writes the facts with their parameters, and falls back to the code for one it does not know", () => {
    expect(fact("worktree_clean")).toBe("没有未提交的改动");
    expect(fact("worktree_dirty")).toBe("worktree 里有没提交的改动");
    expect(fact("worktree_merged", { name: "main" })).toBe("main 已合并进主干");
    expect(fact("worktree_not_merged", { name: "main" })).toBe("main 还没合并进主干，提交只在这个分支上");
    expect(fact("worktree_merge_unknown")).toBe("合没合并进主干，查不出来");
    expect(fact("commits_ahead", { count: 3 })).toBe("3 个提交");
    expect(fact("brand_new_fact")).toBe("brand_new_fact");
  });

  it("words each reason a merge is held back, with the files counted for a conflict, red only when it cannot be undone", () => {
    expect(env.problem({ code: "merge_main_not_trunk", params: {} })).toStrictEqual({
      text: "合并被挡住：主目录不在主干分支上：切回主干",
      danger: false,
    });
    expect(env.problem({ code: "merge_conflict", params: {}, files: ["a", "b", "c"] })).toStrictEqual({
      text: "合并被挡住：3 个文件冲突",
      danger: false,
    });
    expect(env.problem({ code: "merge_conflict", params: {} }).text).toBe("合并被挡住：有文件冲突");
    expect(env.problem({ code: "merge_abort_failed", params: {} }).danger).toBe(true);
    expect(env.problem({ code: "something_else", params: {} })).toStrictEqual({
      text: "上次没有执行成功",
      danger: false,
    });
  });

  it("labels the buttons, naming the lone target of a send back, and the confirm of the ones with a form", () => {
    expect(env.action(action("approve"), base)).toBe("批准，接着跑");
    expect(env.action(action("reject"), base)).toBe("不批准…");
    expect(env.action(action("pass"), base)).toBe("通过并合并");
    expect(
      env.action(action("pass"), { ...base, subject: { code: "task_human_node", params: { merge: false } } }),
    ).toBe("通过");
    expect(env.action(action("retry"), base)).toBe("重试合并");
    expect(env.action(action("send_back", [{ id: "N2", remaining: 2 }]), base)).toBe("打回到 N2 核心实现…");
    expect(
      env.action(
        action("send_back", [
          { id: "N2", remaining: 2 },
          { id: "N4", remaining: 1 },
        ]),
        base,
      ),
    ).toBe("打回到…");
    expect(env.action(action("archive"), base)).toBe("归档");
    expect(env.action(action("keep"), base)).toBe("先留着");
    expect(env.action(action("novel"), base)).toBe("novel");
    expect(env.confirm(action("reject"), base)).toBe("确认不批准");
    expect(env.confirm(action("send_back"), base)).toBe("确认打回");
    expect(env.confirm(action("other"), base)).toBe("确定");
  });
});

describe("describeTaskCommandError", () => {
  it("words the codes of the task commands and falls back to the words of a send", () => {
    expect(describeTaskCommandError(new CommandError("task_back_limit"))).toBe("这条打回边已经用了两次");
    expect(describeTaskCommandError(new CommandError("review_invalid"))).toContain("没有通过");
    expect(describeTaskCommandError(new CommandError("workspace_dirty"))).toContain("没提交的改动");
    expect(describeTaskCommandError(new CommandError("session_not_found"))).toBe("这个对话已经不存在了");
    expect(describeTaskCommandError(new Error("x"))).toBe("发送失败");
  });
});
