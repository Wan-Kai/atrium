import { describe, expect, it } from "vitest";
import { compactRejection, isBusyRejection } from "./rejections";

describe("isBusyRejection", () => {
  it.each([
    ["Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.", true],
    ["Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.", true],
    ["No API key found for provider", false],
    ["Error: Agent is already processing", false],
    ["", false],
  ])("reads %j as busy: %s", (detail, busy) => {
    expect(isBusyRejection(detail)).toBe(busy);
  });
});

describe("compactRejection", () => {
  it.each([
    ["Nothing to compact (session too small)", "nothing_to_compact"],
    ["Already compacted", "already_compacted"],
    ["Compaction cancelled", null],
    ["Error: Already compacted", null],
    ["", null],
  ])("reads %j as %s", (detail, code) => {
    expect(compactRejection(detail)).toBe(code);
  });
});
