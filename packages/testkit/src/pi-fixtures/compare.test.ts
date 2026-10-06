import { describe, expect, it } from "vitest";
import { comparable } from "./compare";
import type { FixtureRecord } from "./format";

describe("comparable", () => {
  it("blanks the text of system messages anywhere, keeping their keys, and keeps everything else", () => {
    const records: FixtureRecord[] = [
      { kind: "fixture", scenario: "s", pi: "1", script: { replies: [] }, args: [] },
      {
        kind: "stdout",
        record: {
          type: "message_end",
          message: { role: "assistant", usage: { input: 0 }, content: [{ type: "text", text: "hi" }] },
        },
      },
      {
        kind: "stdout",
        record: {
          type: "agent_end",
          willRetry: null,
          messages: [
            {
              role: "system",
              content: "",
              sections: { preamble: "You are… /Users/me", tools: ["read /Users/me"] },
              timestamp: 0,
            },
          ],
        },
      },
      { kind: "session", lines: [{ type: "message", message: { role: "user", content: "q /Users/me" } }] },
    ];

    expect(comparable(records)).toStrictEqual([
      { kind: "fixture", scenario: "s", pi: "1", script: { replies: [] }, args: [] },
      {
        kind: "stdout",
        record: {
          type: "message_end",
          message: { role: "assistant", usage: { input: 0 }, content: [{ type: "text", text: "hi" }] },
        },
      },
      {
        kind: "stdout",
        record: {
          type: "agent_end",
          willRetry: null,
          messages: [
            {
              role: "system",
              content: "<system>",
              sections: { preamble: "<system>", tools: ["<system>"] },
              timestamp: 0,
            },
          ],
        },
      },
      { kind: "session", lines: [{ type: "message", message: { role: "user", content: "q /Users/me" } }] },
    ]);
  });
});
