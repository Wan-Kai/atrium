import { describe, expect, it } from "vitest";
import { ContainerId, DirectionId, isChatId, isDirectionId, isWorkspaceId } from "./ids";

describe("container ids", () => {
  it.each([
    ["lrn_node-backend", true],
    ["lrn_Rust_2", true],
    [`lrn_${"a".repeat(64)}`, true],
    [`lrn_${"a".repeat(65)}`, false],
    ["lrn_", false],
    ["lrn_-x", false],
    ["xlrn_go", false],
    ["lrn_go/x", false],
    ["lrn_go ", false],
  ])("%s is a direction id: %s", (id, valid) => {
    expect(DirectionId.safeParse(id).success).toBe(valid);
    expect(isDirectionId(id)).toBe(valid);
  });

  it("tells workspaces, chats and directions apart, each a container", () => {
    const ids = ["wks_0123456789abcdef", "cht_a", "lrn_go"];

    expect(ids.map((id) => [isWorkspaceId(id), isChatId(id), isDirectionId(id)])).toStrictEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    expect(ids.map((id) => ContainerId.safeParse(id).success)).toStrictEqual([true, true, true]);
    expect(isWorkspaceId("wks_x")).toBe(false);
  });
});
