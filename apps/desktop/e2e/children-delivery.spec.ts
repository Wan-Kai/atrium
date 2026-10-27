import { expect, test } from "@playwright/test";
import {
  withChildDelivery,
  DELIVERY_TASK_TEXT,
  DELIVERY_REPLY_TEXT,
  type ChildDeliveryFixture,
} from "./child-delivery-fixture";
import { readChildDeliveries, type ChildIdentity } from "./child-delivery-observation";
import {
  completedReports,
  finished,
  ordered,
  parentIdle,
  reportLocation,
  rolesAndWorktree,
  openReportChild,
  spawnTurnId,
  taskDone,
  writeChildReceipt,
} from "./child-delivery-assertions";

// Keep the project's default trace/screenshot settings and 60-second budget.

/** Requires the exact queued report before opening its boundary. @remarks Captures the independently observed delivery-to-task binding. @sideEffects Reads temporary state. @throws When missing. */
async function queued(fixture: ChildDeliveryFixture, child: ChildIdentity, state: string): Promise<string> {
  const disk = await readChildDeliveries(fixture.app.home, fixture.agentDir);
  const delivery = disk.sessions
    .find((session) => session.sessionId === fixture.parentId)
    ?.deliveries.find(
      (item) =>
        item.from === child.sessionId &&
        item.taskId === child.taskId &&
        item.event === "finished" &&
        item.state === state,
    );
  if (delivery?.id === null || delivery?.id === undefined) throw new Error("exact child delivery missing");
  return delivery.id;
}

/** Exercises an old-turn merge followed by an idle-turn source. @remarks The original source-only oracle was red only after both tasks had completed; this follows SPEC-0002 locations instead. @sideEffects Releases gates, verifies durable identities and navigates both real routes. */
async function mixedDelivery(fixture: ChildDeliveryFixture): Promise<void> {
  await fixture.release("audit-done");
  await taskDone(fixture, fixture.audit);
  await expect
    .poll(async () =>
      (await readChildDeliveries(fixture.app.home, fixture.agentDir)).sessions
        .find((session) => session.sessionId === fixture.parentId)
        ?.deliveries.some(
          (item) =>
            item.from === fixture.audit.sessionId && item.taskId === fixture.audit.taskId && item.state === "sending",
        ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await fixture.app.readHostLog()).some(
        (record) =>
          record["msg"] === "deliveries handed to pi" &&
          record["sessionId"] === fixture.parentId &&
          record["opening"] === false &&
          record["count"] === 1,
      ),
    )
    .toBe(true);
  const auditDelivery = await queued(fixture, fixture.audit, "sending");
  expect(
    (await readChildDeliveries(fixture.app.home, fixture.agentDir)).stored.filter(
      (item) => item.sessionId === fixture.parentId && item.deliveryIds.includes(auditDelivery),
    ),
  ).toHaveLength(0);
  await fixture.release("parent-boundary");
  await fixture.wait("parent-finish");
  await expect
    .poll(() =>
      fixture.probe.turns
        .get(`${fixture.parentId}:${spawnTurnId(fixture)}`)
        ?.steps.some((step) => step.tool === "read" && step.status === "done"),
    )
    .toBe(true);
  await expect
    .poll(() =>
      fixture.probe.turns.get(`${fixture.parentId}:${spawnTurnId(fixture)}`)?.steps.flatMap((step) => step.reports),
    )
    .toStrictEqual([finished(fixture.audit)]);
  await fixture.release("parent-finish");
  await expect
    .poll(() =>
      fixture.probe.runs
        .filter((run) => run.sessionId === fixture.parentId && run.type === "run_settled")
        .map((run) => run.outcome),
    )
    .toStrictEqual(["completed"]);
  await parentIdle(fixture);
  await fixture.release("tests-done");
  const records = await completedReports(fixture);
  const auditRecord = records.filter((record) => record.deliveryIds.includes(auditDelivery));
  expect(auditRecord.map((record) => ({ ids: record.deliveryIds, events: record.events }))).toStrictEqual([
    { ids: [auditDelivery], events: [finished(fixture.audit)] },
  ]);
  expect(
    records.filter((record) => !record.deliveryIds.includes(auditDelivery)).map((record) => record.events),
  ).toStrictEqual([[finished(fixture.tests)]]);
  await expect
    .poll(() =>
      fixture.probe.runs
        .filter((run) => run.sessionId === fixture.parentId && run.type === "run_settled")
        .map((run) => run.outcome),
    )
    .toStrictEqual(["completed", "completed"]);
  await parentIdle(fixture);
  expect([...fixture.released].toSorted()).toStrictEqual([
    "audit-done",
    "parent-boundary",
    "parent-finish",
    "tests-done",
  ]);
  await rolesAndWorktree(fixture);
  const initial = spawnTurnId(fixture);
  const auditLocation = reportLocation(fixture, fixture.audit);
  const testsLocation = reportLocation(fixture, fixture.tests);
  expect(auditLocation.kind).toBe("agent");
  expect(auditLocation.turnId).toBe(initial);
  expect(testsLocation.kind).toBe("source");
  expect(testsLocation.turnId).not.toBe(initial);
  const gates = { initialTurnId: fixture.initialTurnId, released: [...fixture.released] };
  await writeChildReceipt(fixture, "complete", [], gates);
  const navigation = [
    await openReportChild(fixture, fixture.audit, DELIVERY_TASK_TEXT.audit, DELIVERY_REPLY_TEXT.audit),
  ];
  navigation.push(await openReportChild(fixture, fixture.tests, DELIVERY_TASK_TEXT.tests, DELIVERY_REPLY_TEXT.tests));
  await completedReports(fixture);
  await parentIdle(fixture);
  await writeChildReceipt(fixture, "navigated", navigation, gates);
}

/** Exercises a single durable idle batch and both routes. @remarks IDs captured while paused must belong to the two exact events in the single persisted record. @sideEffects Stops/resumes the parent, releases gates and navigates. */
async function idleBatch(fixture: ChildDeliveryFixture): Promise<void> {
  const page = fixture.app.window;
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => fixture.probe.controls.get(fixture.parentId)?.paused).toBe("stopped");
  await expect
    .poll(() =>
      fixture.probe.runs
        .filter((run) => run.sessionId === fixture.parentId && run.type === "run_settled")
        .map((run) => run.outcome),
    )
    .toStrictEqual(["stopped"]);
  await fixture.release("audit-done");
  await fixture.release("tests-done");
  await taskDone(fixture, fixture.audit);
  await taskDone(fixture, fixture.tests);
  await expect
    .poll(() => fixture.probe.controls.get(fixture.parentId)?.deliveries.map((item) => item.state))
    .toStrictEqual(["waiting", "waiting"]);
  const ids = [
    await queued(fixture, fixture.audit, "waiting"),
    await queued(fixture, fixture.tests, "waiting"),
  ].toSorted();
  await page.getByRole("button", { name: "排队 2 · 已暂停", exact: true }).click();
  await page.getByRole("button", { name: "继续发送", exact: true }).click();
  await fixture.wait("parent-finish");
  await fixture.release("parent-finish");
  const records = await completedReports(fixture);
  expect(
    records.map((record) => ({ ids: record.deliveryIds.toSorted(), events: ordered(record.events) })),
  ).toStrictEqual([{ ids, events: [finished(fixture.audit), finished(fixture.tests)] }]);
  await expect
    .poll(() =>
      fixture.probe.runs
        .filter((run) => run.sessionId === fixture.parentId && run.type === "run_settled")
        .map((run) => run.outcome),
    )
    .toStrictEqual(["stopped", "completed"]);
  await parentIdle(fixture, true);
  const auditLocation = reportLocation(fixture, fixture.audit);
  const testsLocation = reportLocation(fixture, fixture.tests);
  expect([auditLocation.kind, testsLocation.kind]).toStrictEqual(["source", "source"]);
  expect(auditLocation.turnId).toBe(testsLocation.turnId);
  expect(auditLocation.turnId).not.toBe(spawnTurnId(fixture));
  const source = page.locator(`[data-turn-id="${auditLocation.turnId}"]`).getByTestId("source");
  await expect(source).toBeVisible();
  await expect(source.getByTestId("source-line")).toHaveCount(2);
  await rolesAndWorktree(fixture);
  const gates = { initialTurnId: fixture.initialTurnId, released: [...fixture.released] };
  await writeChildReceipt(fixture, "complete", [], gates);
  const navigation = [
    await openReportChild(fixture, fixture.audit, DELIVERY_TASK_TEXT.audit, DELIVERY_REPLY_TEXT.audit),
  ];
  navigation.push(await openReportChild(fixture, fixture.tests, DELIVERY_TASK_TEXT.tests, DELIVERY_REPLY_TEXT.tests));
  await completedReports(fixture);
  await parentIdle(fixture, true);
  await writeChildReceipt(fixture, "navigated", navigation, gates);
}

test("C1: mixed reports retain exact identities and navigate their SPEC locations", async () => {
  await withChildDelivery(mixedDelivery);
});

test("C2: same-batch reports keep both identities and open both real children", async () => {
  await withChildDelivery(idleBatch);
});
