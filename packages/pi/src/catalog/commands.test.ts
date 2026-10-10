import { describe, expect, it } from "vitest";
import { toSlashCommand } from "./commands";

/** Where a command came from, as pi reports it; Atrium does not show it. */
const sourceInfo = { path: "/x", source: "local", scope: "user", origin: "top-level" } as const;

describe("toSlashCommand", () => {
  it("keeps the name, the description and the kind", () => {
    expect(toSlashCommand({ name: "review", description: "Reviews", source: "prompt", sourceInfo })).toStrictEqual({
      name: "review",
      description: "Reviews",
      source: "prompt",
    });
  });

  it("gives a command without a description none", () => {
    expect(toSlashCommand({ name: "skill:tdd", source: "skill", sourceInfo })).toStrictEqual({
      name: "skill:tdd",
      description: null,
      source: "skill",
    });
    expect(toSlashCommand({ name: "mcp", description: "", source: "extension", sourceInfo })).toStrictEqual({
      name: "mcp",
      description: null,
      source: "extension",
    });
  });

  it("cuts a description too long to send, and leaves out a command whose name is", () => {
    const long = "说".repeat(5000);
    expect(toSlashCommand({ name: "review", description: long, source: "prompt", sourceInfo })).toStrictEqual({
      name: "review",
      description: "说".repeat(4096),
      source: "prompt",
    });
    expect(toSlashCommand({ name: "x".repeat(256), source: "prompt", sourceInfo })?.name).toHaveLength(256);
    expect(toSlashCommand({ name: "x".repeat(257), source: "prompt", sourceInfo })).toBeNull();
  });
});
