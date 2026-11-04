import { describe, expect, it } from "vitest";
import { CreateWorkspaceCommand, NameBranchCommand, CommandResult } from "./commands";

const fields = {
  requestId: "names-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  projectId: "prj_0123456789abcdef",
};

describe("worktree Chinese names", () => {
  it("carries the generated alias with the branch, including an explicit missing alias", () => {
    expect(CommandResult.name_branch.parse({ branch: "atrium/fix-login", alias: "修复登录" })).toStrictEqual({
      branch: "atrium/fix-login",
      alias: "修复登录",
    });
    expect(CommandResult.name_branch.parse({ branch: "atrium/fix-login", alias: null })).toStrictEqual({
      branch: "atrium/fix-login",
      alias: null,
    });
    expect(CommandResult.name_branch.safeParse({ branch: "atrium/fix-login" }).success).toBe(false);
    expect(CommandResult.name_branch.safeParse({ branch: "atrium/fix-login", alias: 42 }).success).toBe(false);
    expect(CommandResult.name_branch.safeParse({ branch: "atrium/fix-login", alias: "" }).success).toBe(false);
  });

  it("can name a fixed branch without changing its Git name", () => {
    const command = { type: "name_branch", ...fields, text: "修复登录", model: null, branch: "feature/my-login" };
    expect(NameBranchCommand.parse(command)).toStrictEqual(command);
    expect(NameBranchCommand.safeParse({ ...command, branch: "" }).success).toBe(false);
  });

  it("registers an optional alias in the create command without requiring it for old callers", () => {
    const command = { type: "create_workspace", ...fields, branch: "atrium/fix-login", base: "HEAD" };
    expect(CreateWorkspaceCommand.parse({ ...command, alias: "修复登录" })).toStrictEqual({
      ...command,
      alias: "修复登录",
    });
    expect(CreateWorkspaceCommand.parse({ ...command, alias: null })).toStrictEqual({ ...command, alias: null });
    expect(CreateWorkspaceCommand.parse(command)).toStrictEqual(command);
    expect(CreateWorkspaceCommand.safeParse({ ...command, alias: "" }).success).toBe(false);
    expect(CreateWorkspaceCommand.safeParse({ ...command, alias: "字".repeat(257) }).success).toBe(false);
  });
});
