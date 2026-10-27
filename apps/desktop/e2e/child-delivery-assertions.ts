import { expect, test } from "@playwright/test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChildDeliveryContext } from "./child-delivery-fixture";
import { readChildDeliveries, type ChildIdentity, type ReportIdentity } from "./child-delivery-observation";

/** A unique location in the current protocol projection, not a persistent-entry-to-DOM ID guess. */
export interface ReportLocation {
  kind: "source" | "agent";
  turnId: string;
  stepId: string | null;
  report: ReportIdentity;
}

/** Observed navigation identity/status only; no task body or DOM serialization. */
export interface ChildNavigation {
  location: ReportLocation;
  childSessionId: string;
  childTaskId: string;
  parentSelectedBefore: string | null;
  targetTurnId: string | null;
  rowVisibleBefore: boolean;
  subscription: string[];
  snapshotTasks: string[];
  selectedTitle: string | null;
  selected: string | null;
  returnedTitle: string | null;
  returnedSelected: string | null;
}

/** Builds an expected event from the actual spawn. @remarks Names alone cannot establish task identity. @sideEffects none */
export function finished(child: ChildIdentity): ReportIdentity {
  return { sessionId: child.sessionId, taskId: child.taskId, name: child.name, event: "finished" };
}

/** Compares membership without imposing arrival order. @remarks Duplicate events still fail exact array equality. @sideEffects none */
export function ordered(events: ReportIdentity[]): ReportIdentity[] {
  return events.toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/** Matches the complete event key. @remarks Never substitutes a display label for a session/task identity. @sideEffects none */
function same(event: ReportIdentity, child: ChildIdentity): boolean {
  return (
    event.sessionId === child.sessionId &&
    event.taskId === child.taskId &&
    event.name === child.name &&
    event.event === "finished"
  );
}

/** Reads all report locations in the current parent projection. @remarks Source/step duplicates cannot be hidden by a locator union. @sideEffects none */
export function projected(context: ChildDeliveryContext): ReportIdentity[] {
  return [...context.probe.turns.values()]
    .filter((turn) => turn.sessionId === context.parentId)
    .flatMap((turn) => [...turn.reports, ...turn.steps.flatMap((step) => step.reports)]);
}

/** Finds the initial turn by its actual spawn results. @remarks A rebuilt snapshot may replace live turn IDs with different IDs. @sideEffects none @throws If the spawn turn is not unique. */
export function spawnTurnId(context: ChildDeliveryContext): string {
  const matches = [...context.probe.turns.values()].filter(
    (turn) =>
      turn.sessionId === context.parentId &&
      [context.audit, context.tests].every((child) =>
        turn.steps.some((step) => step.spawned?.sessionId === child.sessionId && step.spawned.taskId === child.taskId),
      ),
  );
  expect(matches).toHaveLength(1);
  const found = matches[0];
  if (found === undefined) throw new Error("initial spawn turn missing");
  return found.turnId;
}

/** Finds one exact source or agent-step location. @remarks Persistent entry IDs are deliberately not compared with live turn/step IDs. @sideEffects none @throws When absent or duplicated. */
export function reportLocation(context: ChildDeliveryContext, child: ChildIdentity): ReportLocation {
  const locations: ReportLocation[] = [];
  for (const turn of context.probe.turns.values()) {
    if (turn.sessionId !== context.parentId) continue;
    for (const event of turn.reports)
      if (same(event, child)) locations.push({ kind: "source", turnId: turn.turnId, stepId: null, report: event });
    for (const step of turn.steps) {
      if (step.kind !== "agent") continue;
      for (const event of step.reports)
        if (same(event, child)) locations.push({ kind: "agent", turnId: turn.turnId, stepId: step.id, report: event });
    }
  }
  expect(locations).toHaveLength(1);
  const found = locations[0];
  if (found === undefined) throw new Error("exact report location missing");
  return found;
}

/** Waits for the specific task's durable completion. @remarks A canned reply is not a completion barrier. @sideEffects Polls test-owned files. */
export async function taskDone(context: ChildDeliveryContext, child: ChildIdentity): Promise<void> {
  await expect
    .poll(async () =>
      (await readChildDeliveries(context.app.home, context.agentDir)).sessions
        .filter((session) => session.sessionId === child.sessionId)
        .flatMap((session) => session.tasks)
        .filter((task) => task.taskId === child.taskId)
        .map((task) => ({ state: task.state, hasReply: task.replyEntry !== null && task.replyEntry !== "" })),
    )
    .toStrictEqual([{ state: "done", hasReply: true }]);
}

/** Waits for the parent's actual run termination. @remarks Every observed started run must settle, not just a final-looking string. @sideEffects Polls protocol metadata. */
export async function parentIdle(context: ChildDeliveryContext, allowStopped = false): Promise<void> {
  await expect
    .poll(() => {
      const started = context.probe.runs.filter(
        (run) => run.sessionId === context.parentId && run.type === "run_started",
      );
      return (
        started.length > 0 &&
        context.probe.activeRuns.get(context.parentId) === null &&
        started.every((start) =>
          context.probe.runs.some(
            (run) =>
              run.sessionId === context.parentId &&
              run.runId === start.runId &&
              run.type === "run_settled" &&
              (run.outcome === "completed" || (allowStopped && run.outcome === "stopped")),
          ),
        )
      );
    })
    .toBe(true);
}

/** Waits for two durable, uniquely projected reports and verifies each delivery's owning event. @remarks Queue claims use unique fixture child names; event identity always includes the actual session/task. @sideEffects Polls private files and protocol metadata. */
export async function completedReports(context: ChildDeliveryContext) {
  await taskDone(context, context.audit);
  await taskDone(context, context.tests);
  const expected = [finished(context.audit), finished(context.tests)];
  await expect
    .poll(async () =>
      ordered(
        (await readChildDeliveries(context.app.home, context.agentDir)).stored
          .filter((record) => record.sessionId === context.parentId)
          .flatMap((record) => record.events),
      ),
    )
    .toStrictEqual(expected);
  await expect.poll(() => ordered(projected(context))).toStrictEqual(expected);
  await expect.poll(() => context.probe.controls.get(context.parentId)?.deliveries).toStrictEqual([]);
  const records = (await readChildDeliveries(context.app.home, context.agentDir)).stored.filter(
    (record) => record.sessionId === context.parentId,
  );
  const ids = records.flatMap((record) => record.deliveryIds);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const record of records) {
    expect(record.entryId?.length ?? 0).toBeGreaterThan(0);
    expect(record.deliveryIds).toHaveLength(record.events.length);
    const claimed = record.deliveryIds.map((id) => {
      expect(context.probe.seenDeliveries.get(context.parentId)?.has(id)).toBe(true);
      const claim = context.probe.deliveryClaims.get(context.parentId)?.get(id);
      expect(claim?.event).toBe("finished");
      const child = [context.audit, context.tests].find((item) => item.name === claim?.fromTitle);
      if (child === undefined) throw new Error("delivery has no matching fixture child");
      return finished(child);
    });
    expect(ordered(record.events)).toStrictEqual(ordered(claimed));
  }
  reportLocation(context, context.audit);
  reportLocation(context, context.tests);
  return records;
}

/** Preserves the original role and worktree checks. @remarks The corrected presentation oracle must not remove existing coverage. @sideEffects Reads Git and opens/closes the real child list. */
export async function rolesAndWorktree(context: ChildDeliveryContext): Promise<void> {
  expect([context.audit.role, context.tests.role]).toStrictEqual(["explore", "work"]);
  expect(context.tests.branch).toBe("agent/tests");
  expect(
    await context.scene.git(join(dirname(context.repo), "repo.worktrees", "tests"), "branch", "--show-current"),
  ).toBe("agent/tests");
  const page = context.app.window;
  await page.getByRole("button", { name: /^子对话 2/ }).click();
  const dialog = page.getByRole("dialog", { name: "子对话" });
  await expect(dialog.getByTestId("child-row").filter({ hasText: /^audit只读/ })).toHaveCount(1);
  await expect(dialog.getByTestId("child-row").filter({ hasText: /^tests可写/ })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

/** A rendered report atom; names are associated with the fixture, not DOM session/task attributes. */
interface VisibleReport {
  name: string | null;
  turnId: string | null;
  slot: "agent" | "source" | "invalid";
  event: string | null;
  buttonCount: number;
  noticeCount: number;
  noticeEvent: string | null;
  completionVisible: boolean;
}

/** Primitive metadata for the current parent's complete small fixture transcript. */
interface ReportInventory {
  transcriptCount: number;
  turnIds: Array<string | null>;
  reports: VisibleReport[];
  counts: { audit: number; tests: number; total: number };
}

/** Reads current parent turn IDs. @remarks Never caches the first live projection across navigation. @sideEffects none */
function parentTurnIds(context: ChildDeliveryContext): string[] {
  return [...context.probe.turns.values()]
    .filter((turn) => turn.sessionId === context.parentId)
    .map((turn) => turn.turnId)
    .toSorted();
}

/** Exposes all currently loaded parent processes through public controls. @remarks A visible header may be auto-open/lingering rather than user-pinned; these completed fixtures contain at most three fully loaded turns. @sideEffects Reads test-owned task identities and normally toggles process headers. */
async function exposeParentReports(context: ChildDeliveryContext): Promise<void> {
  const children = [context.audit, context.tests];
  expect(new Set(children.map((child) => child.name)).size).toBe(2);
  expect(new Set(children.map((child) => child.sessionId)).size).toBe(2);
  expect(new Set(children.map((child) => child.taskId)).size).toBe(2);
  const disk = await readChildDeliveries(context.app.home, context.agentDir);
  for (const child of children) {
    const sessions = disk.sessions.filter((session) => session.sessionId === child.sessionId);
    expect(sessions).toHaveLength(1);
    expect(sessions.flatMap((session) => session.tasks.map((task) => task.taskId))).toStrictEqual([child.taskId]);
  }
  expect(ordered(projected(context))).toStrictEqual(children.map(finished));
  const page = context.app.window;
  await expect(page.locator(`[role="tab"][title="${context.parentTitle}"]`)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => context.probe.subscriptions.at(-1)?.includes(context.parentId)).toBe(true);
  await expect.poll(() => context.probe.activeRuns.get(context.parentId)).toBeNull();
  const transcript = page.locator('[data-testid="transcript"]:visible');
  await expect(transcript).toHaveCount(1);
  await expect
    .poll(async () => {
      const actual = await transcript.getByTestId("turn").evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute("data-turn-id"))
          .toSorted((a, b) => {
            const left = String(a);
            const right = String(b);
            return left < right ? -1 : left > right ? 1 : 0;
          }),
      );
      return JSON.stringify(actual) === JSON.stringify(parentTurnIds(context));
    })
    .toBe(true);
  const ids = parentTurnIds(context);
  expect(ids.length).toBeGreaterThanOrEqual(1);
  expect(ids.length).toBeLessThanOrEqual(3);
  for (const id of ids) {
    const turn = transcript.locator(`[data-turn-id="${id}"]`);
    await expect(turn).toHaveCount(1);
    await expect(turn).toBeVisible();
    const header = turn.getByTestId("process-header");
    // These small fixtures have tool/agent processes, or only their final reply.
    const hasProcess =
      context.probe.turns.get(`${context.parentId}:${id}`)?.steps.some((step) => step.kind !== "text") === true;
    await expect(header).toHaveCount(hasProcess ? 1 : 0);
    if (!hasProcess) continue;
    await header.click();
    if ((await header.getAttribute("aria-expanded")) === "false") {
      await expect(turn.getByTestId("process")).toHaveCount(0);
      await header.click();
    }
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }
}

/** Observes every rendered report atom without filtering by expected status or name. @remarks Nonlaned NoticeLine belongs to its outer event; unknown/invalid atoms remain in the inventory. Only primitive identities/statuses leave the renderer, never text or DOM. @sideEffects Reads rendered structure and visible text transiently. */
async function observeReportInventory(context: ChildDeliveryContext): Promise<ReportInventory> {
  return context.app.window.evaluate(
    (names) => {
      // This callback is serialized into the renderer; bind visibility to that browser realm.
      const view = window;
      /** Reads CSS/rendered visibility. @remarks This is not a viewport-intersection claim. @sideEffects none */
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = view.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          style.display !== "none"
        );
      };
      const transcripts = [...document.querySelectorAll('[data-testid="transcript"]')].filter(visible);
      const reports: VisibleReport[] = [];
      const turnIds: Array<string | null> = [];
      for (const transcript of transcripts) {
        turnIds.push(
          ...[...transcript.querySelectorAll('[data-testid="turn"]')].map((turn) => turn.getAttribute("data-turn-id")),
        );
        const events = [...transcript.querySelectorAll('[data-testid="step"][data-kind="event"]')].filter(visible);
        const notices = [...transcript.querySelectorAll('[data-testid="source-line"]')].filter(
          (node) => visible(node) && node.closest('[data-testid="step"][data-kind="event"]') === null,
        );
        for (const atom of [...events, ...notices]) {
          const isEvent = atom.matches('[data-testid="step"][data-kind="event"]');
          const turn = atom.closest('[data-testid="turn"]');
          const source = atom.closest('[data-testid="source"]');
          const slot: VisibleReport["slot"] = isEvent
            ? source === null
              ? "agent"
              : "invalid"
            : source !== null && source.closest('[data-testid="turn"]') === turn
              ? "source"
              : "invalid";
          const buttons = [...atom.querySelectorAll("button")];
          const name =
            buttons.length === 1
              ? (names.find((candidate) => buttons[0]?.getAttribute("aria-label") === `打开子对话「${candidate}」`) ??
                null)
              : null;
          const nested = isEvent ? [...atom.querySelectorAll('[data-testid="source-line"]')] : [atom];
          const notice = nested.length === 1 ? nested[0] : undefined;
          const textNode = notice ?? atom;
          // innerText is used only for this boolean, never retained in the receipt.
          const words =
            textNode instanceof HTMLElement && visible(textNode) ? textNode.innerText.replace(/\s+/gu, " ").trim() : "";
          const prefix = name === null ? null : notice === undefined ? `${name} 完成` : `来自子对话「${name}」· 完成`;
          const completionVisible =
            prefix !== null &&
            words.startsWith(prefix) &&
            (words.length === prefix.length || words[prefix.length] === " ");
          reports.push({
            name,
            turnId: turn?.getAttribute("data-turn-id") ?? null,
            slot,
            event: atom.getAttribute("data-event"),
            buttonCount: buttons.length,
            noticeCount: nested.length,
            noticeEvent: notice?.getAttribute("data-event") ?? null,
            completionVisible,
          });
        }
      }
      return {
        transcriptCount: transcripts.length,
        turnIds: turnIds.toSorted((a, b) => {
          const left = String(a);
          const right = String(b);
          return left < right ? -1 : left > right ? 1 : 0;
        }),
        reports,
        counts: {
          audit: reports.filter((report) => report.name === names[0]).length,
          tests: reports.filter((report) => report.name === names[1]).length,
          total: reports.length,
        },
      };
    },
    [context.audit.name, context.tests.name],
  );
}

/** Saves the actual last inventory on both pass and failure. @remarks Protocol identities are recorded separately from DOM name associations; no synthetic success flag or text is saved. @sideEffects Writes one 0600 JSON and attaches its path. */
async function saveReportInventory(
  context: ChildDeliveryContext,
  child: ChildIdentity,
  phase: string,
  expected: ReportLocation[],
  observation: ReportInventory | undefined,
): Promise<void> {
  const path = test.info().outputPath(`report-inventory-${child.name}-${phase}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(
    path,
    JSON.stringify({ phase, parentId: context.parentId, expected, observation: observation ?? null }, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  await test.info().attach(`report-inventory-${child.name}-${phase}`, { path, contentType: "application/json" });
}

/** Requires exactly one correctly located, visibly finished report per actual child. @remarks Counts come first so a cross-position duplicate is not disguised as a position/status failure; spawn buttons never enter the inventory. @sideEffects Observes the DOM with the existing polling budget and writes the last primitive observation before propagating any assertion failure. */
async function assertParentReports(context: ChildDeliveryContext, child: ChildIdentity, phase: string): Promise<void> {
  const expected = [reportLocation(context, context.audit), reportLocation(context, context.tests)];
  const observed: { last?: ReportInventory } = {};
  try {
    await expect
      .poll(
        async () => {
          const inventory = await observeReportInventory(context);
          observed.last = inventory;
          return inventory.counts;
        },
        { message: "parent visible report counts: exactly one per child" },
      )
      .toStrictEqual({ audit: 1, tests: 1, total: 2 });
    const last = observed.last;
    if (last === undefined) throw new Error("report inventory not observed");
    expect(last.transcriptCount).toBe(1);
    expect(last.turnIds).toStrictEqual(parentTurnIds(context));
    for (const location of expected) {
      const matches = last.reports.filter((report) => report.name === location.report.name);
      expect(matches).toHaveLength(1);
      const actual = matches[0];
      if (actual === undefined) throw new Error("visible report missing");
      expect(actual.buttonCount).toBe(1);
      expect(actual.slot).toBe(location.kind);
      expect(actual.turnId).toBe(location.turnId);
      expect(actual.event).toBe("finished");
      expect(actual.noticeCount).toBeLessThanOrEqual(1);
      if (actual.noticeCount === 1) expect(actual.noticeEvent).toBe("finished");
      if (location.kind === "source") expect(actual.noticeCount).toBe(1);
      expect(actual.completionVisible).toBe(true);
    }
  } catch (error) {
    try {
      await saveReportInventory(context, child, phase, expected, observed.last);
    } catch (recordError) {
      throw new AggregateError([error, recordError], "report assertion and receipt failed", { cause: recordError });
    }
    throw error;
  }
  await saveReportInventory(context, child, phase, expected, observed.last);
}

/** Opens the child at its unique protocol location and returns through parent navigation. @remarks Agent rows exclude same-labelled SpawnWords buttons; no first/OR/force fallback. @sideEffects Uses normal pointer navigation and reads only identity/status attributes. */
export async function openReportChild(
  context: ChildDeliveryContext,
  child: ChildIdentity,
  taskText: string,
  replyText: string,
): Promise<ChildNavigation> {
  const page = context.app.window;
  const parentTab = page.locator(`[role="tab"][title="${context.parentTitle}"]`);
  await expect(parentTab).toHaveAttribute("aria-selected", "true");
  await exposeParentReports(context);
  const location = reportLocation(context, child);
  const turn = page.locator(`[data-turn-id="${location.turnId}"]`);
  await expect(turn).toBeVisible();
  const name = `打开子对话「${child.name}」`;
  let row;
  if (location.kind === "agent") {
    row = turn
      .locator('[data-testid="step"][data-kind="event"][data-event="finished"]')
      .filter({ has: page.getByRole("button", { name, exact: true }) });
  } else {
    const source = turn.getByTestId("source");
    await expect(source).toBeVisible();
    row = source.getByTestId("source-line").filter({ has: page.getByRole("button", { name, exact: true }) });
  }
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  await assertParentReports(context, child, "before-navigation");
  const before = {
    parentSelectedBefore: await parentTab.getAttribute("aria-selected"),
    targetTurnId: await turn.getAttribute("data-turn-id"),
    rowVisibleBefore: await row.isVisible(),
  };
  await row.getByRole("button", { name, exact: true }).click();
  await expect.poll(() => context.probe.subscriptions.at(-1)?.includes(child.sessionId)).toBe(true);
  await expect.poll(() => context.probe.snapshotTasks.get(child.sessionId)).toStrictEqual([child.taskId]);
  const selected = page.locator(`[role="tab"][title="${child.name}"]`);
  await expect(selected).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await expect(page.getByTestId("task-text")).toHaveText(taskText, { timeout: 30_000 });
  await expect(page.getByTestId("reply")).toHaveText([replyText]);
  const actual = {
    location,
    childSessionId: child.sessionId,
    childTaskId: child.taskId,
    ...before,
    subscription: [...(context.probe.subscriptions.at(-1) ?? [])],
    snapshotTasks: [...(context.probe.snapshotTasks.get(child.sessionId) ?? [])],
    selectedTitle: await selected.getAttribute("title"),
    selected: await selected.getAttribute("aria-selected"),
  };
  await page
    .getByRole("navigation", { name: "子对话的位置" })
    .getByRole("button", { name: context.parentTitle, exact: true })
    .click();
  const parent = page.locator(`[role="tab"][title="${context.parentTitle}"]`);
  await expect(parent).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await completedReports(context);
  await exposeParentReports(context);
  await assertParentReports(context, child, "returned");
  return {
    ...actual,
    returnedTitle: await parent.getAttribute("title"),
    returnedSelected: await parent.getAttribute("aria-selected"),
  };
}

/** Writes an independent, private identity receipt before attaching its path. @remarks Contains actual observed values, no success flag, text, DOM or raw frames. @sideEffects Writes 0600 JSON in the test output directory and registers an attachment. */
export async function writeChildReceipt(
  context: ChildDeliveryContext,
  phase: "complete" | "navigated",
  navigation: ChildNavigation[],
  gates?: { initialTurnId: string; released: string[] },
): Promise<void> {
  const disk = await readChildDeliveries(context.app.home, context.agentDir);
  const record = {
    phase,
    parentId: context.parentId,
    currentSpawnTurnId: spawnTurnId(context),
    gates,
    children: [context.audit, context.tests],
    reportLocations: [reportLocation(context, context.audit), reportLocation(context, context.tests)],
    tasks: disk.sessions
      .filter(
        (session) => session.sessionId === context.audit.sessionId || session.sessionId === context.tests.sessionId,
      )
      .map((session) => ({ sessionId: session.sessionId, tasks: session.tasks })),
    records: disk.stored.filter((item) => item.sessionId === context.parentId),
    projection: [...context.probe.turns.values()].filter((turn) => turn.sessionId === context.parentId),
    deliveryClaims: [...(context.probe.deliveryClaims.get(context.parentId)?.entries() ?? [])],
    activeRun: context.probe.activeRuns.get(context.parentId),
    settled: context.probe.runs.filter((run) => run.sessionId === context.parentId && run.type === "run_settled"),
    control: context.probe.controls.get(context.parentId),
    navigation,
  };
  const path = test.info().outputPath(`child-delivery-${phase}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  await test.info().attach(`child-delivery-${phase}`, { path, contentType: "application/json" });
}
