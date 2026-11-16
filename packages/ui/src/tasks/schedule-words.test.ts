import type { ScheduleSummary } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { nextWords, placeWords, resultWords, ruleSubWords, whenWords } from "./schedule-words";

const ROW: ScheduleSummary = {
  id: "rul_a",
  name: "Nightly",
  projectId: "prj_0123456789abcdef",
  place: "new_worktree",
  when: { every: "day", at: "2:00" },
  paused: false,
  nextAt: null,
  last: null,
  skipped: 0,
  templateTaskId: "tsk_t",
  createdAt: 0,
};

describe("whenWords: the time in plain words, never cron (设计稿第 3 屏)", () => {
  it.each([
    [{ every: "day", at: "2:00" }, "每天凌晨 2:00"],
    [{ every: "day", at: "02:00" }, "每天凌晨 2:00"],
    [{ every: "day", at: "5:59" }, "每天凌晨 5:59"],
    [{ every: "day", at: "6:00" }, "每天早上 6:00"],
    [{ every: "day", at: "9:00" }, "每天早上 9:00"],
    [{ every: "day", at: "11:59" }, "每天早上 11:59"],
    [{ every: "day", at: "13:00" }, "每天下午 1:00"],
    [{ every: "day", at: "17:59" }, "每天下午 5:59"],
    [{ every: "day", at: "18:00" }, "每天晚上 6:00"],
    [{ every: "day", at: "0:00" }, "每天凌晨 12:00"],
    [{ every: "day", at: "00:30" }, "每天凌晨 12:30"],
    [{ every: "day", at: "1:00" }, "每天凌晨 1:00"],
    [{ every: "day", at: "12:00" }, "每天中午 12:00"],
    [{ every: "day", at: "12:15" }, "每天中午 12:15"],
    [{ every: "day", at: "23:59" }, "每天晚上 11:59"],
    [{ every: "day", at: "14:30" }, "每天下午 2:30"],
    [{ every: "day", at: "21:05" }, "每天晚上 9:05"],
    [{ every: "week", day: 1, at: "10:00" }, "每周一 10:00"],
    [{ every: "week", day: 0, at: "08:30" }, "每周日 8:30"],
    [{ every: "interval", minutes: 5 }, "每 5 分钟"],
    [{ every: "interval", minutes: 60 }, "每小时"],
    [{ every: "interval", minutes: 120 }, "每 2 小时"],
    [{ every: "interval", minutes: 90 }, "每 90 分钟"],
  ] as const)("%j is %s", (when, words) => {
    expect(whenWords(when)).toBe(words);
  });
});

describe("nextWords", () => {
  const now = new Date(2026, 10, 9, 10, 0).getTime();

  it("says today, tomorrow or the date, with the clock", () => {
    expect(nextWords(new Date(2026, 10, 9, 14, 5).getTime(), now)).toBe("下次 今天 14:05");
    expect(nextWords(new Date(2026, 10, 10, 2, 0).getTime(), now)).toBe("下次 明天 2:00");
    expect(nextWords(new Date(2026, 10, 12, 2, 0).getTime(), now)).toBe("下次 11 月 12 日 2:00");
  });

  it("is a dash for a paused rule", () => {
    expect(nextWords(null, now)).toBe("—");
  });
});

describe("resultWords: the last result column", () => {
  it("is 已暂停 for a paused rule, whatever the last run was", () => {
    expect(
      resultWords({ ...ROW, paused: true, last: { taskId: "tsk_1", status: "done", failed: false } }),
    ).toStrictEqual({
      text: "已暂停",
      tone: "dim",
      icon: "pause",
    });
  });

  it("is a dash before the first run, 上次失败 when a node failed, 这次在跑 while it goes", () => {
    expect(resultWords(ROW).text).toBe("—");
    expect(resultWords({ ...ROW, last: { taskId: "t", status: "stopped", failed: true } })).toStrictEqual({
      text: "上次失败",
      tone: "danger",
      icon: "alert",
    });
    expect(resultWords({ ...ROW, last: { taskId: "t", status: "running", failed: false } })).toStrictEqual({
      text: "这次在跑",
      tone: "run",
      icon: "run",
    });
  });

  it("words the other states of the last task", () => {
    expect([text("waiting"), text("stopped"), text("designing"), text("cancelled"), text("done")]).toStrictEqual([
      "这次在等你",
      "这次停下了",
      "这次停下了",
      "上次取消了",
      "上次完成",
    ]);
  });
});

/**
 * The words for a row whose last task is in a status.
 *
 * @sideEffects none
 * @param status - The status.
 * @returns The result column's text.
 */
function text(status: NonNullable<ScheduleSummary["last"]>["status"]): string {
  return resultWords({ ...ROW, last: { taskId: "t", status, failed: false } }).text;
}

describe("the second line", () => {
  it("names the project and the place, and the skipped triggers", () => {
    expect(placeWords("new_worktree")).toBe("每次新建 worktree");
    expect(placeWords("local_readonly")).toBe("只读，在本地目录跑");
    expect(ruleSubWords(ROW, "atrium")).toBe("atrium · 每次新建 worktree");
    expect(
      ruleSubWords(
        { ...ROW, place: "local_readonly", skipped: 1, last: { taskId: "t", status: "running", failed: false } },
        "atrium",
      ),
    ).toBe("atrium · 只读，在本地目录跑 · 跳过 1 次 · 上次还在跑");
  });

  it("says the last run is still going only while it is, not when it failed or was stopped (or is gone)", () => {
    const last = (status: NonNullable<ScheduleSummary["last"]>["status"], failed = false) =>
      ruleSubWords({ ...ROW, skipped: 2, last: { taskId: "t", status, failed } }, "atrium");
    expect(last("running")).toBe("atrium · 每次新建 worktree · 跳过 2 次 · 上次还在跑");
    expect(last("waiting")).toBe("atrium · 每次新建 worktree · 跳过 2 次 · 上次还在跑");
    expect(last("stopped", true)).toBe("atrium · 每次新建 worktree · 跳过 2 次");
    expect(last("running", true)).toBe("atrium · 每次新建 worktree · 跳过 2 次");
    expect(last("stopped")).toBe("atrium · 每次新建 worktree · 跳过 2 次");
    expect(last("designing")).toBe("atrium · 每次新建 worktree · 跳过 2 次");
    expect(ruleSubWords({ ...ROW, skipped: 2 }, "atrium")).toBe("atrium · 每次新建 worktree · 跳过 2 次");
    expect(
      ruleSubWords({ ...ROW, skipped: 0, last: { taskId: "t", status: "running", failed: false } }, "atrium"),
    ).toBe("atrium · 每次新建 worktree");
  });
});
