import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp, median } from "./launch";

/** How many tasks and how many nodes each has: the board's upper size (SPEC-0006, "任务图的上限"; testing.md, "性能预算"). */
const TASKS = 50;
const NODES = 20;

/** The budgets, in milliseconds: the list of all the tasks drawn after pressing "任务", and a 20-node task's graph drawn after pressing its row. */
const LIST_BUDGET_MS = 100;
const GRAPH_BUDGET_MS = 100;

/** The first time the list is opened after launch, when the host reads the 50 tasks from disk and the page draws for the first time, in milliseconds. */
const COLD_BUDGET_MS = 1000;

/** The rows the list draws before "显示全部": the 10 that wait, the 20 that run and the 5 latest of the 20 done. */
const FOLDED_ROWS = 35;

/** The time the seeded tasks treat as now, a little before the test runs. */
const NOW = Date.now();

/** A task's graph: one explore node fanning out to three, joining, a chain of writers and checks, and a human node last. */
function graphOf() {
  const roles = ["explore", "work", "check", "advise"] as const;
  const nodes = Array.from({ length: NODES }, (_, index) => {
    const human = index === NODES - 1;
    return {
      id: `N${index + 1}`,
      name: human ? "验收合并" : `第 ${index + 1} 步`,
      kind: human ? ("human" as const) : ("agent" as const),
      job: `做第 ${index + 1} 步`,
      done: [`第 ${index + 1} 步做完了`],
      ...(human
        ? { merge: true as const }
        : {
            role: roles[index % 4] ?? "work",
            place: index % 4 === 0 ? ("readonly" as const) : ("workspace" as const),
          }),
    };
  });
  const edges: { from: string; to: string; kind: "seq" | "back" }[] = [];
  for (const to of [2, 3, 4]) edges.push({ from: "N1", to: `N${to}`, kind: "seq" });
  for (const from of [2, 3, 4]) edges.push({ from: `N${from}`, to: "N5", kind: "seq" });
  for (let from = 5; from < NODES; from++) edges.push({ from: `N${from}`, to: `N${from + 1}`, kind: "seq" });
  edges.push({ from: `N${NODES}`, to: "N5", kind: "back" });
  return { nodes, edges };
}

/** One run of a node that ended, or that is going on or waiting. */
function runOf(index: number, state: "passed" | "running" | "waiting") {
  return {
    node: `N${index + 1}`,
    attempt: 1,
    graph: 1,
    state,
    waitingFor: state === "waiting" ? ("human" as const) : null,
    blocked: null,
    sessionId: null as string | null,
    startedAt: NOW - (NODES - index) * 60_000,
    endedAt: state === "passed" ? NOW - (NODES - index) * 60_000 + 30_000 : null,
    startCommit: null,
    pendingDone: null,
    summary: state === "passed" ? "做完了" : null,
    failure: null,
    commit: null,
    nudged: false,
  };
}

/**
 * Writes the tasks into the home's `tasks` folder as the host keeps them: the first event with the whole record, and the snapshot.
 *
 * @remarks
 * Tasks 0–9 wait at their human node, 10–29 run, 30–49 are done in the last days.
 *
 * @sideEffects Creates the folders and files.
 * @param home - The Atrium home.
 */
async function seedTasks(home: string): Promise<void> {
  const { nodes, edges } = graphOf();
  for (let index = 0; index < TASKS; index++) {
    const id = `tsk_perf_${String(index).padStart(2, "0")}`;
    const waiting = index < 10;
    const done = index >= 30;
    const upTo = waiting || done ? NODES - 1 : 9;
    const runs = Array.from({ length: upTo }, (_, node) => runOf(node, "passed"));
    if (waiting) runs.push(runOf(NODES - 1, "waiting"));
    else if (done) runs.push(runOf(NODES - 1, "passed"));
    else runs.push({ ...runOf(upTo, "running"), sessionId: `s-node-${index}` });
    const task = {
      id,
      name: `性能任务 ${index}`,
      projectId: null,
      workspaceId: null,
      workspaceState: "none",
      sourceDir: home,
      ownsWorkspace: false,
      baseCommit: null,
      model: { providerId: "faux", modelId: "faux-1", thinking: "off" },
      guide: { id: "default", version: 1 },
      summary: { goal: "g", decisions: [], constraints: [], nonGoals: [], openQuestions: [], acceptance: [] },
      origin: { kind: "chat", sessionId: "s-origin" },
      scheduleDraft: null,
      taskSessionId: `s-task-${index}`,
      graphs: [
        {
          version: 1,
          nodes,
          edges,
          author: "agent",
          note: "",
          createdAt: NOW - 3_600_000,
          approvedAt: NOW - 3_500_000,
        },
      ],
      activeGraph: 1,
      pendingGraph: null,
      runs,
      // The host takes up tasks that were going when it stopped (SPEC-0006, T9); a paused one with a session is held, and
      // nothing is started for it, so the seeded "running" tasks stay as they are and the test stays about drawing.
      paused: !waiting && !done,
      cancelled: false,
      createdAt: NOW - 3_600_000,
      startedAt: NOW - 3_500_000,
      endedAt: done ? NOW - (index - 29) * 3_600_000 : null,
    };
    const folder = join(home, "tasks", id);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "events.jsonl"),
      `${JSON.stringify({ seq: 1, at: NOW - 3_600_000, type: "created", task })}\n`,
    );
    await writeFile(join(folder, "task.json"), `${JSON.stringify(task)}\n`);
  }
}

/**
 * Starts timing at the next press and resolves once `count` elements match the selector and two frames have passed.
 *
 * @remarks
 * Runs inside the renderer, so it must not use anything from this module.
 *
 * @sideEffects Listens for the press; observes the page; sets `window.drawn`.
 * @param selector - What is drawn.
 * @param count - How many of them.
 */
function timeDrawn([selector, count]: readonly [string, number]): void {
  const page = window as unknown as { drawn: Promise<number> };
  page.drawn = new Promise((resolve) => {
    let start = 0;
    document.addEventListener(
      "pointerdown",
      () => {
        start = performance.now();
      },
      { capture: true, once: true },
    );
    const observer = new MutationObserver(() => {
      if (start === 0 || document.querySelectorAll(selector).length < count) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

test(`@perf shows ${TASKS} tasks of ${NODES} nodes: the first open within ${COLD_BUDGET_MS} ms, then the list within ${LIST_BUDGET_MS} ms and a graph within ${GRAPH_BUDGET_MS} ms (median of 3)`, async () => {
  test.setTimeout(150_000);
  // A first launch makes the home, its preferences and its index; the tasks are put in beside them before the second.
  const pi = await fauxPiEnvironment({ replies: [] });
  const first = await launchApp(pi.env);
  await first.quit();
  await seedTasks(first.home);
  const launched = await launchApp(pi.env, first.home);
  try {
    const { window } = launched;
    const entry = window.getByRole("button", { name: "任务", exact: true });
    const lists: number[] = [];
    const graphs: number[] = [];
    for (let run = 0; run < 3; run++) {
      // ⌘N leaves the task area, so each run draws the list afresh.
      await window.keyboard.press("Meta+n");
      await expect(window.getByTestId("task-tab-bar")).toHaveCount(0);
      await window.evaluate(timeDrawn, ['[data-testid="task-row"]', FOLDED_ROWS] as const);
      await entry.click();
      lists.push(await window.evaluate(() => (window as unknown as { drawn: Promise<number> }).drawn));
      await expect(window.getByTestId("task-row")).toHaveCount(FOLDED_ROWS);
      await window.getByRole("button", { name: `显示全部 ${TASKS - 30} 个` }).click();
      await expect(window.getByTestId("task-row")).toHaveCount(TASKS);
      await window.getByRole("button", { name: "收起" }).click();

      await window.evaluate(timeDrawn, ['[data-testid="graph-node"]', NODES] as const);
      // A row opens under the press and "打开任务" in it opens the tab; the time is from the first press to the graph.
      await window.getByTestId("task-row").first().click();
      await window.getByRole("button", { name: "打开任务" }).click();
      graphs.push(await window.evaluate(() => (window as unknown as { drawn: Promise<number> }).drawn));
      await expect(window.getByTestId("graph-node")).toHaveCount(NODES);
      await window.getByRole("button", { name: /^关闭 / }).click();
    }
    test.info().annotations.push({ type: "list", description: `${lists.map(Math.round).join(", ")} ms` });
    test.info().annotations.push({ type: "graph", description: `${graphs.map(Math.round).join(", ")} ms` });

    expect(lists[0]).toBeLessThanOrEqual(COLD_BUDGET_MS);
    expect(median(lists)).toBeLessThanOrEqual(LIST_BUDGET_MS);
    expect(median(graphs)).toBeLessThanOrEqual(GRAPH_BUDGET_MS);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
