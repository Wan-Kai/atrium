import { describe, expect, it } from "vitest";
import { DAY, MINUTE, NOW, summary } from "./task-fixtures";
import { DONE_SHOWN, NO_PROJECT, type TaskGroup, arrangeTasks, groupOf } from "./task-list-model";

const options = { filter: null, now: NOW, showAll: false } as const;
const ids = (tasks: readonly { readonly id: string }[]) => tasks.map((task) => task.id.slice(4));
const tasksOf = (group: TaskGroup | undefined) => group?.tasks ?? [];

describe("groupOf", () => {
  it.each([
    ["designing", "attention"],
    ["waiting", "attention"],
    ["stopped", "attention"],
    ["running", "running"],
    ["done", "done"],
    ["cancelled", "done"],
  ] as const)("lists a %s task under %s", (status, group) => {
    expect(groupOf(summary("a", { status }))).toBe(group);
  });
});

describe("arrangeTasks (SPEC-0006, 界面 · 任务列表)", () => {
  it("orders attention, then running, then done, and leaves out a group with nothing in it", () => {
    const { groups } = arrangeTasks(
      [
        summary("done", { status: "done", endedAt: NOW - MINUTE }),
        summary("run", { status: "running" }),
        summary("wait", { status: "waiting", attention: "human" }),
      ],
      options,
    );
    expect(groups.map((group) => group.key)).toStrictEqual(["attention", "running", "done"]);

    expect(arrangeTasks([summary("run")], options).groups.map((group) => group.key)).toStrictEqual(["running"]);
    expect(arrangeTasks([], options)).toStrictEqual({ groups: [], total: 0 });
  });

  it("puts the most urgent first among those that want you, then the latest activity", () => {
    const { groups } = arrangeTasks(
      [
        summary("design", { status: "designing", activeAt: NOW }),
        summary("stop", { status: "stopped", paused: true, activeAt: NOW }),
        summary("graph", { status: "waiting", attention: "graph_change", activeAt: NOW }),
        summary("ask", { status: "waiting", attention: "question", activeAt: NOW - 2 * MINUTE }),
        summary("ask2", { status: "waiting", attention: "question", activeAt: NOW - MINUTE }),
        summary("human", { status: "waiting", attention: "human", activeAt: NOW }),
        summary("merge", { status: "waiting", attention: "merge_blocked", activeAt: NOW }),
        summary("fail", { status: "stopped", attention: "failed", activeAt: NOW - DAY }),
      ],
      options,
    );

    expect(ids(tasksOf(groups[0]))).toStrictEqual(["fail", "merge", "human", "ask2", "ask", "graph", "stop", "design"]);
  });

  it("orders the running ones by latest activity", () => {
    const { groups } = arrangeTasks(
      [
        summary("old", { activeAt: NOW - 9 * MINUTE }),
        summary("new", { activeAt: NOW - MINUTE }),
        summary("mid", { activeAt: NOW - 3 * MINUTE }),
      ],
      options,
    );

    expect(ids(tasksOf(groups[0]))).toStrictEqual(["new", "mid", "old"]);
  });

  it("shows only what ended in the last seven days, at most five, and counts the rest behind 显示全部", () => {
    const done = [
      ...Array.from({ length: 7 }, (_, index) =>
        summary(`recent${index}`, { status: "done", endedAt: NOW - (index + 1) * 60 * MINUTE }),
      ),
      summary("week", { status: "done", endedAt: NOW - 7 * DAY }),
      summary("old", { status: "cancelled", endedAt: NOW - 8 * DAY }),
    ];

    const folded = arrangeTasks(done, options).groups[0];
    expect(folded?.tasks).toHaveLength(DONE_SHOWN);
    expect(ids(tasksOf(folded))).toStrictEqual(["recent0", "recent1", "recent2", "recent3", "recent4"]);
    expect(folded?.hidden).toBe(4);
    expect(folded?.foldable).toBe(4);

    const all = arrangeTasks(done, { ...options, showAll: true }).groups[0];
    expect(all?.tasks).toHaveLength(9);
    expect(all?.hidden).toBe(0);
    expect(all?.foldable).toBe(4);
    expect(ids(tasksOf(all)).at(-1)).toBe("old");
  });

  it("leaves what ended more than seven days ago behind 显示全部 even when fewer than five are recent", () => {
    const tasks = [
      summary("a", { status: "done", endedAt: NOW - MINUTE }),
      summary("b", { status: "done", endedAt: NOW - 7 * DAY }),
      summary("c", { status: "done", endedAt: NOW - 8 * DAY }),
    ];
    const group = arrangeTasks(tasks, options).groups[0];

    expect(ids(tasksOf(group))).toStrictEqual(["a", "b"]);
    expect(group?.hidden).toBe(1);
  });

  it("filters by project, and by no project, and counts what passes", () => {
    const tasks = [
      summary("a", { projectId: "prj_1" }),
      summary("b", { projectId: "prj_2" }),
      summary("c", { projectId: null }),
    ];

    expect(ids(tasksOf(arrangeTasks(tasks, { ...options, filter: "prj_1" }).groups[0]))).toStrictEqual(["a"]);
    expect(ids(tasksOf(arrangeTasks(tasks, { ...options, filter: NO_PROJECT }).groups[0]))).toStrictEqual(["c"]);
    expect(arrangeTasks(tasks, options).total).toBe(3);
    expect(arrangeTasks(tasks, { ...options, filter: "prj_2" }).total).toBe(1);
  });
});
