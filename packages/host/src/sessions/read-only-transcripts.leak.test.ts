import { readEntries } from "@atrium/pi";
import { createTempDir } from "@atrium/testkit";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ResourceTracker } from "../platform/resources";
import { createReadOnlyTranscripts } from "./read-only-transcripts";

/**
 * Writes a session file of one message, as pi writes it.
 *
 * @remarks
 * Many sessions can share one file: only the id given to the transcripts tells them apart.
 *
 * @sideEffects Writes the file in a temporary directory, removed when the test ends.
 * @returns The file's path.
 */
async function sessionFile(): Promise<string> {
  const dir = await createTempDir("read-only-leak");
  onTestFinished(dir.cleanup);
  const path = join(dir.path, "s.jsonl");
  const lines = [
    { type: "session", version: 3, id: "s", timestamp: "2026-11-06T10:00:00.000Z", cwd: "/gone" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-11-06T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    },
  ];
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

describe("ReadOnlyTranscripts leaks", () => {
  it("keeps no more than its limit however many archived sessions are browsed, and nothing once let go", async () => {
    const file = await sessionFile();
    const resources = new ResourceTracker();
    let ids = 0;
    const transcripts = createReadOnlyTranscripts({
      readEntries,
      newId: () => `t${String(++ids)}`,
      newStream: () => "stream",
      now: () => 1,
      resources,
    });

    for (let index = 0; index < 200; index += 1) {
      await transcripts.snapshot({ sessionId: `s${String(index)}`, file, model: null }, false);
      expect(resources.snapshot()["session.read_only"]).toBeLessThanOrEqual(32);
    }
    expect(resources.snapshot()["session.read_only"]).toBe(32);

    transcripts.evict(() => false);

    expect(resources.snapshot()["session.read_only"]).toBe(0);
  });
});
