import type { Notice, ReviewRecord, TranscriptItem } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { arrangeRows, lineWords, reviewWords, summaryWords } from "./task-progress-model";

const at = (minutes: number) => new Date(2026, 10, 6, 10, minutes).getTime();

const record = (
  subject: ReviewRecord["subject"],
  verdict: ReviewRecord["verdict"],
): Extract<Notice, { notice: "review" }> => ({
  kind: "notice",
  id: `rv-${verdict.action}`,
  notice: "review",
  review: { source: { kind: "gate", gate: "task_human" }, subject, evidence: [], verdict },
  timestamp: at(5),
});

const graph = (version: number) => ({ code: "task_graph_change", params: { taskId: "tsk_a", version } });
const human = (node: string) => ({ code: "task_human_node", params: { taskId: "tsk_a", node, merge: true } });
const progress = (id: string, minutes: number, what: string): Extract<Notice, { notice: "task_progress" }> => ({
  kind: "notice",
  id,
  notice: "task_progress",
  what,
  node: "N1",
  timestamp: at(minutes),
});

/** What a row is: the kinds of its lines for a group, the item's kind otherwise. */
function shape(row: ReturnType<typeof arrangeRows>[number]): readonly string[] | string {
  return row.kind === "progress" ? row.notices.map((one) => one.notice) : row.item.kind;
}

/** Whether a group is the latest one; `null` for a row that is no group. */
function isLast(row: ReturnType<typeof arrangeRows>[number]): boolean | null {
  return row.kind === "progress" ? row.last : null;
}

describe("reviewWords", () => {
  it("says what you decided on each gate", () => {
    expect(reviewWords(record(graph(3), { action: "approve" }).review)).toBe("你批准了图 v3");
    expect(reviewWords(record(graph(3), { action: "reject", reason: "先别动" }).review)).toBe(
      "你没有批准图 v3：先别动",
    );
    expect(reviewWords(record(human("N4"), { action: "pass" }).review)).toBe("你通过了 N4");
    expect(reviewWords(record(human("N4"), { action: "retry" }).review)).toBe("你通过了 N4");
    expect(reviewWords(record(human("N4"), { action: "send_back", target: "N2", reason: "漏了测试" }).review)).toBe(
      "你打回到 N2：漏了测试",
    );
    expect(reviewWords(record({ code: "task_archive", params: {} }, { action: "archive" }).review)).toBe("你选了归档");
    expect(reviewWords(record({ code: "task_archive", params: {} }, { action: "keep" }).review)).toBe("你选了先留着");
  });

  it("reads plainly for a review it does not know, and for one an agent asked", () => {
    expect(reviewWords(record({ code: "newer_gate", params: {} }, { action: "x" }).review)).toBe("你处理了一个审核");
    expect(reviewWords(record({ text: "推送前" }, { action: "approve" }).review)).toBe("你处理了一个审核");
  });
});

describe("arrangeRows with reviews", () => {
  it("puts a review's record in the group of the progress lines around it, and a turn ends the group", () => {
    const turn: TranscriptItem = {
      kind: "turn",
      id: "t",
      source: null,
      user: { text: "进度", images: 0, clientMessageId: null, auto: false, command: null, timestamp: at(8) },
      steps: [],
      outcome: "done",
      error: null,
      startedAt: at(8),
      durationMs: 1,
      usage: null,
      changes: [],
    };
    const rows = arrangeRows([
      progress("p1", 0, "node_passed"),
      record(graph(2), { action: "approve" }),
      progress("p2", 6, "node_started"),
      turn,
      record(human("N4"), { action: "pass" }),
    ]);

    expect(rows.map(shape)).toStrictEqual([["task_progress", "review", "task_progress"], "turn", ["review"]]);
    expect(rows.map(isLast)).toStrictEqual([false, null, true]);
  });
});

describe("summaryWords and lineWords with reviews", () => {
  it("names each verdict in the folded line, between the counts and the time", () => {
    expect(
      summaryWords([
        progress("p1", 0, "node_passed"),
        record(graph(2), { action: "approve" }),
        progress("p2", 6, "node_passed"),
      ]),
    ).toBe("任务进度 · 2 个节点通过 · 你批准了图 v2 · 10:00–10:06");
  });

  it("gives a record the plain tone and a failed line the failed one", () => {
    expect(lineWords(record(graph(2), { action: "approve" }), undefined)).toStrictEqual({
      text: "你批准了图 v2",
      tone: "plain",
    });
    expect(lineWords(progress("p", 0, "node_failed"), "核心实现").tone).toBe("fail");
  });
});
