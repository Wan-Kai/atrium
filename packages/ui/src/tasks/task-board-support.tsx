import type { TaskSummary } from "@atrium/protocol";
import { CommandError } from "@atrium/client";
import type { ErrorCode } from "@atrium/protocol";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Workbench } from "../app/workbench";
import { PROJECT, type FakeAnswers, fakeClient, session, workspace } from "../test/fake-client";
import { summary, type view } from "./task-fixtures";

const LOCAL = "wks_000000000000000a";
export const FEATURE = "wks_000000000000000b";

/**
 * A list with the project, its local workspace and a feature worktree, and conversations to come back to.
 *
 * @remarks
 * Test support for the task area's tests, not the app.
 *
 * @sideEffects none
 * @returns The index snapshot.
 */
function list() {
  return {
    projects: [PROJECT],
    workspaces: [
      workspace({ id: FEATURE, branch: "首页首屏加载提速", createdAt: 5 }),
      workspace({
        id: LOCAL,
        kind: "local",
        branch: "main",
        dir: "/work/atrium",
        createdAt: null,
        external: false,
        merge: null,
      }),
    ],
    sessions: [
      session({ sessionId: "s1", containerId: LOCAL, prompt: "语音输入方案" }),
      session({ sessionId: "s2", containerId: LOCAL, prompt: "需求对话" }),
    ],
    layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1"], active: "s1" } } },
  };
}

/**
 * Renders the workbench over a fake client with tasks.
 *
 * @remarks
 * Test support for the task area's tests, not the app.
 *
 * @sideEffects Renders; sets the viewport.
 * @param tasks - The task rows.
 * @param answers - How the fake answers.
 * @returns The screen and the fake.
 */
export async function board(tasks: readonly TaskSummary[] = [], answers: FakeAnswers = {}) {
  await page.viewport(1360, 820);
  const fake = fakeClient(list(), answers);
  fake.tasks.setState({ status: "ready", tasks: [...tasks], seq: 1 });
  const screen = await render(
    <Workbench
      client={fake.client}
      status={<span>已连接宿主</span>}
      pickDirectory={undefined}
      setNativeAppearance={() => undefined}
      openUrl={() => undefined}
      reveal={() => undefined}
      pathForFile={undefined}
    />,
  );
  return { screen, ...fake };
}

/**
 * Opens a task's tab from the list, after giving the fake the whole task the host would answer.
 *
 * @remarks
 * Test support for the task area's tests, not the app.
 *
 * @sideEffects Clicks.
 * @param task - The task.
 * @param rows - The list's rows; the task's own by default.
 * @param answers - How the fake answers.
 * @returns The screen and the fake.
 */
export async function openTab(
  task: ReturnType<typeof view>,
  rows: readonly TaskSummary[] = [summary(task.id.slice(4), { name: task.name })],
  answers: FakeAnswers = {},
) {
  const shown = await board(rows, answers);
  shown.taskStateOf(task.id).setState({ status: "ready", task });
  await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
  await shown.screen.getByTestId("task-row").click();
  await shown.screen.getByRole("button", { name: "打开任务" }).click();
  // The mouse rests on the bar, not on a node whose hover card would float over what the test presses next.
  await userEvent.hover(shown.screen.getByTestId("task-name"));
  return shown;
}

/**
 * The fake's answer that fails one command, a code per press, then goes through.
 *
 * @remarks
 * Test support for the task area's tests, not the app. The conditional lives here so tests have none.
 *
 * @sideEffects none
 * @param command - The method that fails, as the fake names it (`answerReview`, `pauseTask`, …).
 * @param codes - The error codes, one for each time it is called.
 * @returns The fake's `taskCommand` answer.
 */
export function rejectOn(command: string, ...codes: readonly ErrorCode[]): (name: string) => Promise<void> {
  let turn = 0;
  return (name) => {
    const code = codes[turn];
    if (name !== command || code === undefined) return Promise.resolve();
    turn += 1;
    return Promise.reject(new CommandError(code));
  };
}
