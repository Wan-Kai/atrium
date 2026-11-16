import { describe, expect, it } from "vitest";
import { followTasksFor } from "./follow-tasks";

describe("followTasksFor (ATRIUM_FOLLOW_TASKS, dev only)", () => {
  it("gives the directory in a development run", () => {
    expect(followTasksFor({ ATRIUM_FOLLOW_TASKS: "/tmp/try/tasks" }, false)).toBe("/tmp/try/tasks");
  });

  it("ignores the variable in a packaged app", () => {
    expect(followTasksFor({ ATRIUM_FOLLOW_TASKS: "/tmp/try/tasks" }, true)).toBeUndefined();
  });

  it("gives nothing when the variable is unset or empty", () => {
    expect(followTasksFor({}, false)).toBeUndefined();
    expect(followTasksFor({ ATRIUM_FOLLOW_TASKS: "" }, false)).toBeUndefined();
  });
});
