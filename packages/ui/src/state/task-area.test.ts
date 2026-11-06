import { describe, expect, it } from "vitest";
import { createTaskArea } from "./task-area";

describe("the task area's state (SPEC-0006, 界面 · 入口)", () => {
  it("starts closed, on the list, with no task open", () => {
    const area = createTaskArea().getState();

    expect([area.open, area.active, area.tabs, area.filter, area.showAll]).toStrictEqual([
      false,
      "list",
      [],
      null,
      false,
    ]);
  });

  it("opens a task as a tab behind the two fixed ones and brings it up, once however often it is opened", () => {
    const area = createTaskArea();
    area.getState().openTask("tsk_a");
    area.getState().openTask("tsk_b");
    area.getState().openTask("tsk_a");

    expect(area.getState()).toMatchObject({ open: true, active: "tsk_a", tabs: ["tsk_a", "tsk_b"] });
  });

  it("shows and hides the area without touching its tabs", () => {
    const area = createTaskArea();
    area.getState().openTask("tsk_a");
    area.getState().hide();
    expect(area.getState()).toMatchObject({ open: false, active: "tsk_a", tabs: ["tsk_a"] });

    area.getState().show();
    expect(area.getState().open).toBe(true);
  });

  it("goes to the tab before the one closed, or to the list; closing a tab behind the top one keeps the top", () => {
    const area = createTaskArea();
    for (const id of ["tsk_a", "tsk_b", "tsk_c"]) area.getState().openTask(id);

    area.getState().closeTask("tsk_a");
    expect(area.getState()).toMatchObject({ active: "tsk_c", tabs: ["tsk_b", "tsk_c"] });
    area.getState().closeTask("tsk_c");
    expect(area.getState()).toMatchObject({ active: "tsk_b", tabs: ["tsk_b"] });
    area.getState().closeTask("tsk_b");
    expect(area.getState()).toMatchObject({ active: "list", tabs: [] });
    area.getState().closeTask("tsk_none");
    expect(area.getState().tabs).toStrictEqual([]);
  });

  it("keeps the filter and the show-all choice it was given", () => {
    const area = createTaskArea();
    area.getState().setFilter("prj_1");
    area.getState().setShowAll(true);
    area.getState().activate("schedules");

    expect(area.getState()).toMatchObject({ filter: "prj_1", showAll: true, active: "schedules" });
  });
});
