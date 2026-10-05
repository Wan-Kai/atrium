import { describe, expect, it } from "vitest";
import { comparable } from "./compare";
import type { FixtureRecord } from "./format";

describe("comparable", () => {
  it("blanks usage, cost and system messages anywhere, and keeps everything else", () => {
    const records: FixtureRecord[] = [
      { kind: "fixture", scenario: "s", pi: "1", script: { replies: [] }, args: [] },
      {
        kind: "stdout",
        record: {
          type: "message_end",
          message: { role: "assistant", usage: { input: 6257 }, content: [{ type: "text", text: "hi" }] },
        },
      },
      {
        kind: "stdout",
        record: { type: "agent_end", willRetry: null, messages: [{ role: "system", content: "You are… /Users/me" }] },
      },
      { kind: "session", lines: [{ type: "message", message: { role: "user", content: "q", cost: { total: 1 } } }] },
    ];

    expect(comparable(records)).toStrictEqual([
      { kind: "fixture", scenario: "s", pi: "1", script: { replies: [] }, args: [] },
      {
        kind: "stdout",
        record: {
          type: "message_end",
          message: { role: "assistant", usage: "<usage>", content: [{ type: "text", text: "hi" }] },
        },
      },
      { kind: "stdout", record: { type: "agent_end", willRetry: null, messages: [{ role: "system" }] } },
      { kind: "session", lines: [{ type: "message", message: { role: "user", content: "q", cost: "<cost>" } }] },
    ]);
  });
});
