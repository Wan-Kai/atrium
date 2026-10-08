import { describe, expect, it } from "vitest";
import { isDone, isPending, mergeLabels, placeOf, sessionTitle, sortWorkspaces, timeAgo, workspaceName } from "./names";

/** A merge state with `fields`. */
const merge = (fields: Partial<{ dirty: boolean; ahead: number; verdict: string; reason: string }>) => ({
  merge: { dirty: false, ahead: 0, verdict: "noChange", reason: null, ...fields } as never,
});

describe("workspaceName", () => {
  it("takes the alias, then the branch, then the directory's name", () => {
    expect(workspaceName({ alias: "侧栏", branch: "feat/sidebar", dir: "/w/app-sidebar" })).toBe("侧栏");
    expect(workspaceName({ alias: null, branch: "feat/sidebar", dir: "/w/app-sidebar" })).toBe("feat/sidebar");
    expect(workspaceName({ alias: null, branch: null, dir: "/w/app-sidebar/" })).toBe("app-sidebar");
    expect(workspaceName({ alias: null, branch: null, dir: "/" })).toBe("/");
  });
});

describe("sessionTitle", () => {
  it("takes pi's name, then the prompt, then says what it is", () => {
    const base = { name: null, prompt: null, state: "persisted", containerId: "wks_a" } as const;

    expect(sessionTitle({ ...base, name: "重构", prompt: "fix" })).toBe("重构");
    expect(sessionTitle({ ...base, prompt: "fix" })).toBe("fix");
    expect(sessionTitle({ ...base, state: "draft" })).toBe("新会话");
    expect(sessionTitle({ ...base, state: "draft", containerId: "chats" })).toBe("新对话");
    expect(sessionTitle(base)).toBe("图片");
  });
});

describe("mergeLabels", () => {
  it.each([
    ["no merge state", { merge: null }, []],
    ["no changes", merge({}), []],
    [
      "unknown and dirty",
      merge({ verdict: "unknown", dirty: true, reason: "no_main_branch" }),
      [{ kind: "dirty" }, { kind: "unknown", reason: "no_main_branch" }],
    ],
    ["commits ahead", merge({ verdict: "pending", ahead: 3 }), [{ kind: "ahead", count: 3 }]],
    [
      "ahead and dirty",
      merge({ verdict: "pending", ahead: 3, dirty: true }),
      [{ kind: "ahead", count: 3 }, { kind: "dirty" }],
    ],
    ["pending without commits", merge({ verdict: "pending" }), []],
    ["merged", merge({ verdict: "merged", ahead: 2 }), [{ kind: "merged" }]],
    ["merged but dirty", merge({ verdict: "merged", dirty: true }), [{ kind: "dirty" }]],
    ["removed", merge({ verdict: "removed" }), [{ kind: "removed" }]],
  ])("labels %s", (_case, workspace, labels) => {
    expect(mergeLabels(workspace)).toStrictEqual(labels);
  });

  it("calls merged and removed done, and dirty or ahead pending", () => {
    expect(
      [merge({ verdict: "merged" }), merge({ verdict: "removed" }), merge({}), { merge: null }].map(isDone),
    ).toStrictEqual([true, true, false, false]);
    expect(
      [merge({ dirty: true }), merge({ verdict: "pending", ahead: 1 }), merge({ verdict: "merged" })].map(isPending),
    ).toStrictEqual([true, true, false]);
  });
});

/** A worktree created at `createdAt` with a merge verdict. */
const worktree = (id: string, createdAt: number | null, verdict = "noChange") => ({
  id,
  kind: "worktree" as const,
  createdAt,
  ...merge({ verdict }),
});

describe("sortWorkspaces", () => {
  it("puts the local workspace first, then worktrees newest first, then the done ones", () => {
    const sorted = sortWorkspaces([
      worktree("old", 1),
      worktree("merged", 5, "merged"),
      { id: "local", kind: "local" as const, createdAt: null, merge: null },
      worktree("new", 3),
      worktree("removed", 9, "removed"),
      worktree("unknown-time", null),
    ]);

    expect(sorted.map((workspace) => workspace.id)).toStrictEqual([
      "local",
      "new",
      "old",
      "unknown-time",
      "removed",
      "merged",
    ]);
  });
});

describe("placeOf", () => {
  it("names a session's project and workspace, or the chats", () => {
    const index = {
      projects: [{ id: "prj_a", path: "/w/app", name: "atrium" }],
      workspaces: [
        { id: "wks_a", projectId: "prj_a", alias: null, branch: "main", dir: "/w/app" },
        { id: "wks_b", projectId: "prj_gone", alias: null, branch: "x", dir: "/w/x" },
      ],
    } as never;

    expect(placeOf(index, "wks_a")).toBe("atrium · main");
    expect(placeOf(index, "chats")).toBe("对话");
    expect(placeOf(index, "wks_b")).toBe(" · x");
    expect(placeOf(index, "wks_missing")).toBe("");
  });
});

describe("timeAgo", () => {
  it("says how long ago, then yesterday, then the date", () => {
    const now = new Date(2026, 9, 8, 14, 0).getTime();
    const minute = 60_000;

    expect(timeAgo(now - 30_000, now)).toBe("刚刚");
    expect(timeAgo(now - 12 * minute, now)).toBe("12 分钟前");
    expect(timeAgo(now - 59 * minute, now)).toBe("59 分钟前");
    expect(timeAgo(now - 60 * minute, now)).toBe("1 小时前");
    expect(timeAgo(now - 23 * 60 * minute, now)).toBe("23 小时前");
    expect(timeAgo(new Date(2026, 9, 7, 1, 0).getTime(), now)).toBe("昨天");
    expect(timeAgo(new Date(2026, 9, 6, 23, 0).getTime(), now)).toBe("10月6日");
  });
});
