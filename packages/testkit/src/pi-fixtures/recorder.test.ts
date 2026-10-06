import { describe, expect, it } from "vitest";
import { createNormalizer } from "./normalize";
import { createRecorder } from "./recorder";

describe("createRecorder", () => {
  it("records normalized traffic in arrival order, then the exit and the session file", () => {
    const recorder = createRecorder(
      { scenario: "s", pi: "1.0.2", script: { replies: [] }, args: [] },
      createNormalizer({ "/w": "<cwd>" }),
    );

    recorder.tap.sent({ type: "get_state", id: "r1" });
    recorder.tap.received({ type: "response", id: "r1", data: { sessionFile: "/w/x.jsonl", leafId: "a1b2c3d4" } });
    recorder.exit(0, null, true);
    recorder.session([{ type: "message", id: "a1b2c3d4", timestamp: "2026-10-05T00:00:00.000Z" }]);

    expect(recorder.records()).toStrictEqual([
      { kind: "fixture", scenario: "s", pi: "1.0.2", script: { replies: [] }, args: [] },
      { kind: "send", record: { type: "get_state", id: "r1" } },
      { kind: "stdout", record: { type: "response", id: "r1", data: { sessionFile: "<cwd>/x.jsonl", leafId: "e1" } } },
      { kind: "exit", code: 0, signal: null, requested: true },
      { kind: "session", lines: [{ type: "message", id: "e1", timestamp: "1970-01-01T00:00:00.000Z" }] },
    ]);
  });

  it("hands out copies, so callers cannot change what was recorded", () => {
    const recorder = createRecorder(
      { scenario: "s", pi: "1", script: { replies: [] }, args: [] },
      createNormalizer({}),
    );

    recorder.records().pop();

    expect(recorder.records()).toHaveLength(1);
  });
});
