import { describe, expect, it } from "vitest";
import { summary, view } from "./task-fixtures";

describe("the task fixtures keep to what the host sends (T8 review fix 1)", () => {
  it("refuses a task that is paused without being stopped, as the host's status never says", () => {
    expect(() => summary("a", { status: "running", paused: true })).toThrow("impossible task: running but paused");
    expect(() => view("a", [], [], { status: "waiting", paused: true })).toThrow("impossible task: waiting but paused");
    expect(summary("a", { status: "stopped", paused: true }).paused).toBe(true);
  });

  it("makes a task being designed one that has not started, and refuses one that says it has", () => {
    expect(summary("a", { status: "designing" }).startedAt).toBeNull();
    expect(view("a", [], [], { status: "designing" }).startedAt).toBeNull();
    expect(() => summary("a", { status: "designing", startedAt: 1 })).toThrow("designing but started");
  });
});
