import { CommandError } from "@atrium/client";
import { afterEach, describe, expect, it } from "vitest";
import { askForChild, describeChildError, keptChild, pageNewChild } from "./new-child";

afterEach(() => pageNewChild().setState(null, true));

describe("askForChild", () => {
  it("asks the page for the dialog, one request at a time", () => {
    expect(pageNewChild().getState()).toBeNull();
    askForChild({ parentSessionId: "s1", turnId: "s1:u1" });
    askForChild({ parentSessionId: "s2", turnId: null });

    expect(pageNewChild().getState()).toStrictEqual({ parentSessionId: "s2", turnId: null });
  });
});

describe("describeChildError", () => {
  it("says in words why a child could not be opened, from the host's codes", () => {
    expect(
      [
        new CommandError("child_place_invalid"),
        new CommandError("session_busy"),
        new CommandError("session_is_draft"),
        new CommandError("session_not_found"),
        new CommandError("session_handed_off"),
        new CommandError("turn_not_found"),
        new CommandError("fork_failed"),
        new CommandError("fork_failed", { sessionId: "c1" }),
        new CommandError("internal_error"),
        new CommandError("session_not_found", { sessionId: "s1" }),
        new Error("gone"),
        Object.assign(new Error("not the host's"), { code: "session_busy" }),
        new CommandError("worktree_create_failed", { reason: "branch_exists", branch: "atrium/a" }),
      ].map(describeChildError),
    ).toStrictEqual([
      "这里只能放在当前位置",
      "运行中不能开带上下文的子对话",
      "主对话还没有消息，发一条再开子对话",
      "主对话已经不在了",
      "主对话已在终端中继续，先接回来",
      "没能开子对话：找不到这一轮",
      "没能开子对话：pi 出错了",
      "没能开子对话：pi 出错了",
      "没能开子对话",
      "主对话已经不在了",
      "没能开子对话",
      "没能开子对话",
      "这个分支名已经有了，换一个",
    ]);
  });
});

describe("keptChild", () => {
  it("names the child a failed fork kept, and nothing for any other failure", () => {
    expect(
      [
        new CommandError("fork_failed", { sessionId: "c1" }),
        new CommandError("fork_failed"),
        new CommandError("fork_failed", { sessionId: 1 }),
        new CommandError("session_busy", { sessionId: "c1" }),
        Object.assign(new Error("not the host's"), { code: "fork_failed", params: { sessionId: "c1" } }),
      ].map(keptChild),
    ).toStrictEqual(["c1", null, null, null, null]);
  });
});
