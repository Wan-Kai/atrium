import { describe, expect, it } from "vitest";
import { parseWorktreeList } from "./worktree-list";

describe("parseWorktreeList", () => {
  it("reads each worktree's directory, commit and branch, main first", () => {
    const output = [
      "worktree /w/app",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /w/app-feature",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feat/sidebar",
      "locked reason here",
      "",
      "worktree /w/app-detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
      "worktree /w/app-gone",
      "HEAD 4444444444444444444444444444444444444444",
      "branch refs/heads/gone",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /w/app-gone2",
      "HEAD 5555555555555555555555555555555555555555",
      "detached",
      "prunable",
      "future-attribute value",
      "",
    ].join("\n");

    expect(parseWorktreeList(output)).toStrictEqual([
      { dir: "/w/app", head: "1".repeat(40), branch: "main", prunable: false, bare: false },
      { dir: "/w/app-feature", head: "2".repeat(40), branch: "feat/sidebar", prunable: false, bare: false },
      { dir: "/w/app-detached", head: "3".repeat(40), branch: null, prunable: false, bare: false },
      { dir: "/w/app-gone", head: "4".repeat(40), branch: "gone", prunable: true, bare: false },
      { dir: "/w/app-gone2", head: "5".repeat(40), branch: null, prunable: true, bare: false },
    ]);
  });

  it("marks a bare repository, which has no commit checked out, and skips blocks without a worktree line", () => {
    expect(parseWorktreeList("worktree /w/app.git\nbare\n\nHEAD 1\n\n")).toStrictEqual([
      { dir: "/w/app.git", head: "", branch: null, prunable: false, bare: true },
    ]);
    expect(parseWorktreeList("")).toStrictEqual([]);
  });

  it("keeps a branch that is not under refs/heads as it is", () => {
    expect(parseWorktreeList("worktree /w/x\nHEAD 1\nbranch refs/remotes/origin/x\n")[0]?.branch).toBe(
      "refs/remotes/origin/x",
    );
  });
});
