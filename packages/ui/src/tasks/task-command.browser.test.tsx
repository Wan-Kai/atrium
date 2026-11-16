import { beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { pageDrafts } from "../state/use-draft";
import { board, refuseOn, rejectOn } from "./task-board-support";
import { node, view } from "./task-fixtures";

// A command that did not run stays in the box, and the boxes are the page's: each test starts with it empty.
beforeEach(() => pageDrafts().drop(["s1"]));

describe("/task in the chat's input box (SPEC-0006, /task 与创建)", () => {
  it("makes the task from the conversation and opens its tab, sending nothing to the model", async () => {
    const shown = await board();
    shown
      .taskStateOf("tsk_new")
      .setState({ status: "ready", task: view("new", [node("N1")], [], { name: "语音输入" }) });
    const box = shown.screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(box, "/task{Enter}");

    await expect.poll(() => shown.calls).toContain("createTask s1");
    await expect.element(shown.screen.getByTestId("task-tab")).toBeVisible();
    expect(shown.calls.some((call) => call.startsWith("prompt s1"))).toBe(false);
    expect(shown.screen.container.querySelectorAll('[aria-label="任务区"] [role="tab"]')).toHaveLength(3);
  });

  it("takes the words after it as the scope", async () => {
    const shown = await board();
    shown.taskStateOf("tsk_new").setState({ status: "ready", task: view("new", [node("N1")]) });
    await userEvent.type(shown.screen.getByRole("textbox", { name: "消息" }), "/task 只改收件箱{Enter}");

    await expect.poll(() => shown.calls).toContain("createTask s1 只改收件箱");
  });

  it("says in words why it did not, above the box, and stays in the conversation", async () => {
    const shown = await board([], { taskCommand: rejectOn("createTask", "task_already_converted") });
    await userEvent.type(shown.screen.getByRole("textbox", { name: "消息" }), "/task{Enter}");

    await expect.element(shown.screen.getByRole("alert")).toHaveTextContent("这段对话已经转成任务了");
    expect(shown.screen.container.querySelector('[data-testid="task-tab-bar"]')).toBeNull();
  });

  it("opens the task the conversation already has, from the error's parameter, instead of an error (T8 review fix 15)", async () => {
    const shown = await board([], {
      taskCommand: refuseOn("createTask", "task_already_converted", { taskId: "tsk_old" }),
    });
    shown
      .taskStateOf("tsk_old")
      .setState({ status: "ready", task: view("old", [node("N1")], [], { name: "已有的任务" }) });
    await userEvent.type(shown.screen.getByRole("textbox", { name: "消息" }), "/task{Enter}");

    await expect.element(shown.screen.getByTestId("task-tab")).toBeVisible();
    await expect.poll(() => shown.calls).toContain("openTask tsk_old");
    expect(shown.screen.container.querySelector('[role="alert"]')).toBeNull();
    expect(shown.calls.some((call) => call.startsWith("prompt s1"))).toBe(false);
  });

  it("lists /task among the commands with what it does", async () => {
    const shown = await board();
    await userEvent.type(shown.screen.getByRole("textbox", { name: "消息" }), "/ta");

    await expect.element(shown.screen.getByText("把这段对话转成任务")).toBeVisible();
  });
});
