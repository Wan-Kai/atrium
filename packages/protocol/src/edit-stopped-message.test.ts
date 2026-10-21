import { describe, expect, it } from "vitest";
import { Command, CommandResult, EditStoppedMessageCommand } from "./index";

const command = {
  type: "edit_stopped_message",
  requestId: "edit-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  sessionId: "s1",
  epoch: 0,
  turnId: "s1:e1",
  text: "corrected",
} as const;

describe("edit_stopped_message", () => {
  it("accepts a guarded edit with ordinary prompt text and uploaded images", () => {
    expect(Command.parse(command)).toStrictEqual(command);
    const images = { ...command, text: "", attachmentIds: ["a1"] };
    expect(EditStoppedMessageCommand.parse(images)).toStrictEqual(images);
    const largest = {
      ...command,
      text: "a".repeat(1024 * 1024),
      attachmentIds: Array<string>(20).fill("a".repeat(128)),
    };
    expect(Command.parse(largest)).toStrictEqual(largest);
    expect(Command.parse({ ...command, turnId: "t".repeat(256) })).toStrictEqual({
      ...command,
      turnId: "t".repeat(256),
    });
  });

  it.each([
    { epoch: -1 },
    { epoch: 0.5 },
    { epoch: undefined },
    { turnId: "" },
    { turnId: "t".repeat(257) },
    { turnId: undefined },
    { text: "" },
    { text: "", attachmentIds: [] },
    { text: "a".repeat(1024 * 1024 + 1) },
    { attachmentIds: [""] },
    { attachmentIds: ["a".repeat(129)] },
    { attachmentIds: Array<string>(21).fill("a1") },
    { sessionId: "" },
    { requestId: "" },
    { traceparent: "invalid" },
    { extra: true },
  ])("rejects invalid edit fields %#", (fields) => {
    expect(Command.safeParse({ ...command, ...fields }).success).toBe(false);
  });

  it("only accepts a started result", () => {
    expect(CommandResult.edit_stopped_message.parse({ disposition: "started" })).toStrictEqual({
      disposition: "started",
    });
    expect(CommandResult.edit_stopped_message.safeParse({ disposition: "handled" }).success).toBe(false);
    expect(CommandResult.edit_stopped_message.safeParse({ disposition: "queued", itemId: "q1" }).success).toBe(false);
    expect(CommandResult.edit_stopped_message.safeParse({ disposition: "started", extra: true }).success).toBe(false);
    expect(CommandResult.edit_stopped_message.safeParse({}).success).toBe(false);
  });
});
