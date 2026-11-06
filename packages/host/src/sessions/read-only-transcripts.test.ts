import { readEntries } from "@atrium/pi";
import { createTempDir, present } from "@atrium/testkit";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ResourceTracker } from "../platform/resources";
import { READ_ONLY_EPOCH, createReadOnlyTranscripts } from "./read-only-transcripts";

const timestamp = "2026-11-06T10:00:00.000Z";

/**
 * A session file of one turn: the user's message and the reply.
 *
 * @remarks
 * As pi writes it (pi-internals §1); entries read by the pi package's `readEntries`.
 *
 * @sideEffects Writes the file in a temporary directory, removed when the test ends.
 * @returns The file's path.
 */
async function sessionFile(): Promise<string> {
  const dir = await createTempDir("read-only");
  onTestFinished(dir.cleanup);
  const path = join(dir.path, "s1.jsonl");
  const lines = [
    { type: "session", version: 3, id: "s1", timestamp, cwd: "/gone" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "我想学 Go" }], timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "先问两件事" }],
        provider: "faux",
        model: "faux-1",
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        timestamp: 2,
      },
    },
  ];
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

/**
 * Read-only transcripts over the real file reader, noting how often a file was read.
 *
 * @remarks
 * Ids and streams are counted so the snapshot is exact.
 *
 * @sideEffects none until a call.
 * @param more - How many sessions to keep, and a gate each read waits at.
 * @returns The transcripts, the reads and the resource counts.
 */
function transcripts(more: { readonly limit?: number; readonly gate?: Promise<void> } = {}) {
  const reads: string[] = [];
  let ids = 0;
  const resources = new ResourceTracker();
  const made = createReadOnlyTranscripts({
    readEntries: async (file) => {
      reads.push(file);
      await more.gate;
      return readEntries(file);
    },
    newId: () => `t${String(++ids)}`,
    newStream: () => "stream-1",
    now: () => 5,
    resources,
    ...(more.limit === undefined ? {} : { limit: more.limit }),
  });
  return { made, reads, resources };
}

describe("ReadOnlyTranscripts", () => {
  it("rebuilds a session from its file into an idle snapshot, reading the file once", async () => {
    const file = await sessionFile();
    const { made, reads } = transcripts();
    const model = { providerId: "faux", modelId: "faux-1", thinkingLevel: "off" as const };

    const snapshot = present(await made.snapshot({ sessionId: "s1", file, model }, false), "snapshot");
    const again = present(await made.snapshot({ sessionId: "s1", file, model }, true), "snapshot");

    expect(snapshot).toMatchObject({
      type: "session_snapshot",
      sessionId: "s1",
      epoch: READ_ONLY_EPOCH,
      seq: 0,
      traceId: null,
      stream: "stream-1",
      hasOlder: false,
      run: null,
      exited: false,
      model,
      fast: false,
    });
    expect(snapshot.items).toMatchObject([
      { kind: "turn", user: { text: "我想学 Go" }, steps: [{ kind: "text", text: "先问两件事" }], outcome: "done" },
    ]);
    expect(again.fast).toBe(true);
    expect(again.items).toStrictEqual(snapshot.items);
    expect(reads).toStrictEqual([file]);
    expect(made.has("s1")).toBe(true);
  });

  it("answers pages, steps and turns' entries for its epoch, and transcript_changed for another", async () => {
    const file = await sessionFile();
    const { made } = transcripts();
    const snapshot = present(await made.snapshot({ sessionId: "s1", file, model: null }, false), "snapshot");
    const [turn] = snapshot.items.filter((item) => item.kind === "turn");
    expect(turn).toMatchObject({ kind: "turn", steps: [{ kind: "text" }] });
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the line above found it.
    const { id, steps } = turn!;
    const at = { type: "fetch_transcript", requestId: "r", traceparent: "t", sessionId: "s1" } as const;

    expect(made.fetchTranscript({ ...at, epoch: READ_ONLY_EPOCH, before: id, limit: 10 })).toStrictEqual({
      items: [],
      hasOlder: false,
    });
    expect(() => made.fetchTranscript({ ...at, epoch: 2, before: id, limit: 10 })).toThrow(
      expect.objectContaining({ code: "transcript_changed" }),
    );
    const step = { type: "fetch_step", requestId: "r", traceparent: "t", sessionId: "s1", turnId: id } as const;
    const [first] = steps;
    expect(made.fetchStep({ ...step, epoch: READ_ONLY_EPOCH, stepId: String(first?.id) })).toStrictEqual({
      step: first,
    });
    expect(() => made.fetchStep({ ...step, epoch: 2, stepId: "x" })).toThrow(
      expect.objectContaining({ code: "transcript_changed" }),
    );
    expect(made.entryOfTurn("s1", id)).toBe("u1");
  });

  it("knows nothing of a session not read, or one let go", async () => {
    const file = await sessionFile();
    const { made, reads } = transcripts();
    await made.snapshot({ sessionId: "s1", file, model: null }, false);

    made.forget(["s1"]);

    expect(made.has("s1")).toBe(false);
    expect(() => made.entryOfTurn("s1", "t1")).toThrow(
      expect.objectContaining({ code: "session_not_found", params: { sessionId: "s1" } }),
    );
    await made.snapshot({ sessionId: "s1", file, model: null }, false);
    expect(reads).toHaveLength(2);
  });

  it("rebuilds with the turn starts the host recorded, so a message it sent shows as its own", async () => {
    const file = await sessionFile();
    const asked: string[] = [];
    const made = createReadOnlyTranscripts({
      readEntries,
      turnStarts: async (sessionId) => {
        asked.push(sessionId);
        return { opened: new Set(["u1"]), auto: new Set(["u1"]), compactions: new Map(), record: async () => {} };
      },
      newId: () => "t1",
      newStream: () => "stream-1",
      now: () => 5,
      resources: new ResourceTracker(),
    });

    const snapshot = present(await made.snapshot({ sessionId: "s1", file, model: null }, false), "snapshot");

    expect(asked).toStrictEqual(["s1"]);
    expect(snapshot.items).toMatchObject([{ kind: "turn", user: { text: "我想学 Go", auto: true } }]);
  });

  it("is in an epoch no pi's first snapshot has, so a live one always replaces it", async () => {
    expect(READ_ONLY_EPOCH).toBe(0);
  });

  it("reads a session once for snapshots asked at the same time", async () => {
    const file = await sessionFile();
    const gate = Promise.withResolvers<void>();
    const { made, reads } = transcripts({ gate: gate.promise });

    const first = made.snapshot({ sessionId: "s1", file, model: null }, false);
    const second = made.snapshot({ sessionId: "s1", file, model: null }, false);
    gate.resolve();

    expect((await first)?.items).toStrictEqual((await second)?.items);
    expect(reads).toStrictEqual([file]);
  });

  it("drops a read that ends after the session was let go, keeping nothing", async () => {
    const file = await sessionFile();
    const gate = Promise.withResolvers<void>();
    const { made, resources } = transcripts({ gate: gate.promise });

    const reading = made.snapshot({ sessionId: "s1", file, model: null }, false);
    made.forget(["s1"]);
    gate.resolve();

    expect(await reading).toBeNull();
    expect(made.has("s1")).toBe(false);
    expect(resources.snapshot()["session.read_only"]).toBeUndefined();
  });

  it("keeps at most its limit, letting the one used longest ago go, and lets go of those not kept", async () => {
    const file = await sessionFile();
    const { made, resources } = transcripts({ limit: 2 });

    await made.snapshot({ sessionId: "a", file, model: null }, false);
    await made.snapshot({ sessionId: "b", file, model: null }, false);
    await made.snapshot({ sessionId: "a", file, model: null }, false);
    await made.snapshot({ sessionId: "c", file, model: null }, false);

    expect(["a", "b", "c"].filter((id) => made.has(id))).toStrictEqual(["a", "c"]);
    expect(resources.snapshot()["session.read_only"]).toBe(2);

    made.evict((sessionId) => sessionId === "c");

    expect(["a", "b", "c"].filter((id) => made.has(id))).toStrictEqual(["c"]);
    expect(resources.snapshot()["session.read_only"]).toBe(1);
  });
});
