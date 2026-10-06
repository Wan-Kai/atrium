import { describe, expect, it } from "vitest";
import { type FixtureRecord, parseFixture, serializeFixture } from "./format";

const fixture: FixtureRecord[] = [
  { kind: "fixture", scenario: "s", pi: "1.0.2", script: { replies: [] }, args: ["--no-session"] },
  { kind: "send", record: { type: "prompt", message: "hi", id: "r1" } },
  { kind: "stdout", record: { type: "agent_settled" } },
  { kind: "exit", code: 0, signal: null, requested: true },
  { kind: "session", lines: [{ type: "session", id: "<uuid-1>" }] },
];

describe("fixture files", () => {
  it("write one record per line and read back the same records", () => {
    const text = serializeFixture(fixture);

    expect(text.split("\n")).toHaveLength(fixture.length + 1);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseFixture(text)).toStrictEqual(fixture);
  });

  it("must start with the header", () => {
    expect(() => parseFixture(serializeFixture(fixture.slice(1)))).toThrow("a fixture must start with its header");
    expect(() => parseFixture("")).toThrow("a fixture must start with its header");
  });
});
