import { describe, expect, it } from "vitest";
import { createTaskArea, nodeTabId, parseNodeTab } from "./task-area";

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

describe("a node's conversation tab (SPEC-0006, 节点对话)", () => {
  it("opens right after its task's tab and the node tabs it has, opening the task's tab if it was not", () => {
    const area = createTaskArea();
    area.getState().openTask("tsk_a");
    area.getState().openTask("tsk_b");
    area.getState().openNode("tsk_a", "N2");
    area.getState().openNode("tsk_a", "N1");
    area.getState().openNode("tsk_c", "N1");

    expect(area.getState().tabs).toStrictEqual([
      "tsk_a",
      nodeTabId("tsk_a", "N2"),
      nodeTabId("tsk_a", "N1"),
      "tsk_b",
      "tsk_c",
      nodeTabId("tsk_c", "N1"),
    ]);
    expect(area.getState().active).toBe(nodeTabId("tsk_c", "N1"));
  });

  it("is brought up when opened again instead of being added twice", () => {
    const area = createTaskArea();
    area.getState().openNode("tsk_a", "N2");
    area.getState().openTask("tsk_a");
    area.getState().openNode("tsk_a", "N2");

    expect(area.getState().tabs).toStrictEqual(["tsk_a", nodeTabId("tsk_a", "N2")]);
    expect(area.getState().active).toBe(nodeTabId("tsk_a", "N2"));
  });

  it("closes with its task, and closing it alone goes back to its task", () => {
    const area = createTaskArea();
    area.getState().openNode("tsk_a", "N2");
    area.getState().openNode("tsk_a", "N1");
    area.getState().closeTask(nodeTabId("tsk_a", "N1"));
    expect(area.getState()).toMatchObject({ tabs: ["tsk_a", nodeTabId("tsk_a", "N2")], active: "tsk_a" });

    area.getState().activate(nodeTabId("tsk_a", "N2"));
    area.getState().closeTask("tsk_a");
    expect(area.getState()).toMatchObject({ tabs: [], active: "list" });
  });

  it("keeps the tab on top when a tab behind it closes", () => {
    const area = createTaskArea();
    area.getState().openNode("tsk_a", "N2");
    area.getState().openTask("tsk_b");
    area.getState().closeTask("tsk_a");

    expect(area.getState()).toMatchObject({ tabs: ["tsk_b"], active: "tsk_b" });
    expect(nodeTabId("tsk_a", "N2")).toBe("tsk_a#N2");
  });
});

describe("the id of a node tab", () => {
  it("carries the task and the node, and only a node tab parses", () => {
    expect(parseNodeTab(nodeTabId("tsk_a", "N2"))).toStrictEqual({ taskId: "tsk_a", node: "N2" });
    expect(parseNodeTab("tsk_a")).toBeNull();
    expect(parseNodeTab("list")).toBeNull();
  });
});
