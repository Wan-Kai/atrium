import type { Notice, SessionSnapshotEvent, TranscriptItem, Turn } from "@atrium/protocol";
import { IDLE_CONTROL, UNKNOWN_METRICS } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { withinBudget } from "./snapshot-budget";

/** A finished turn whose reply is `size` characters long. */
function turn(id: string, size = 10): Turn {
  return {
    kind: "turn",
    id,
    source: null,
    user: { text: "q", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 1 },
    steps: [{ kind: "text", id: "0", text: "x".repeat(size) }],
    outcome: "done",
    error: null,
    startedAt: 1,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

/** A compaction notice. */
function notice(id: string): Notice {
  return { kind: "notice", id, notice: "compacted", tokensBefore: 1, tokensAfter: null, summary: "", timestamp: 0 };
}

/** The encoded size of an item, as the budget counts it. */
function bytesOf(item: TranscriptItem): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

/** A snapshot of the given items. */
function snapshot(items: TranscriptItem[], hasOlder = false): SessionSnapshotEvent {
  return {
    type: "session_snapshot",
    sessionId: "s1",
    epoch: 1,
    seq: 3,
    traceId: null,
    stream: "st-1",
    items,
    hasOlder,
    run: null,
    exited: false,
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
  };
}

describe("withinBudget", () => {
  it("leaves a snapshot without a budget as it is", () => {
    const whole = snapshot([turn("t1"), turn("t2")]);

    expect(withinBudget(whole, undefined)).toBe(whole);
  });

  it("leaves a snapshot that fits as it is", () => {
    const whole = snapshot([turn("t1"), notice("n1"), turn("t2")], true);

    expect(withinBudget(whole, { turns: 2, bytes: 65_536 })).toBe(whole);
  });

  it("keeps the latest turns, with the notices among and after them, stopping at a turn", () => {
    const whole = snapshot([turn("t1"), notice("n1"), turn("t2"), notice("n2"), turn("t3"), notice("n3")]);

    expect(withinBudget(whole, { turns: 2, bytes: 65_536 })).toStrictEqual({
      ...whole,
      items: [turn("t2"), notice("n2"), turn("t3"), notice("n3")],
      hasOlder: true,
    });
  });

  it("stops before the item that would pass the bytes, counting each item as it is encoded", () => {
    const items = [turn("t1", 100), turn("t2", 100), turn("t3", 100)];
    const two = bytesOf(items[1] as TranscriptItem) + bytesOf(items[2] as TranscriptItem);
    const whole = snapshot(items);

    expect(withinBudget(whole, { turns: 20, bytes: two }).items).toStrictEqual([turn("t2", 100), turn("t3", 100)]);
    expect(withinBudget(whole, { turns: 20, bytes: two - 1 }).items).toStrictEqual([turn("t3", 100)]);
  });

  it("keeps the last item even when it alone passes the bytes", () => {
    const whole = snapshot([turn("t1"), turn("t2", 200_000)]);

    expect(withinBudget(whole, { turns: 6, bytes: 65_536 })).toStrictEqual({
      ...whole,
      items: [turn("t2", 200_000)],
      hasOlder: true,
    });
  });

  it("keeps saying there are older items when the whole snapshot already had them", () => {
    const whole = snapshot([turn("t1")], true);

    expect(withinBudget(whole, { turns: 1, bytes: 65_536 }).hasOlder).toBe(true);
  });

  it("changes nothing but the items and whether older ones exist", () => {
    const whole = { ...snapshot([turn("t1"), turn("t2")]), run: { runId: "r", startedAt: 1 }, fast: true };
    const cut = withinBudget(whole, { turns: 1, bytes: 65_536 });

    expect({ ...cut, items: whole.items, hasOlder: whole.hasOlder }).toStrictEqual(whole);
  });
});
