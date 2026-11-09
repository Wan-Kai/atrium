import { createTempDir } from "@atrium/testkit";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startTaskHost } from "../../test/task-harness";
import type { Clock } from "../platform/clock";
import { ResourceTracker } from "../platform/resources";
import { recordingTracing } from "../../test/recording-tracing";
import { createScheduleService } from "./schedule-service";
import { agent, newTask } from "./test-support";
import type { Task } from "./types";

vi.setConfig({ testTimeout: 90_000 });

/** A clock whose timers a test can count and fire. */
class CountingClock implements Clock {
  t = Date.UTC(2026, 10, 9, 9, 0);
  timers = new Set<() => void>();

  now(): number {
    return this.t;
  }

  setTimeout(callback: () => void): () => void {
    this.timers.add(callback);
    return () => void this.timers.delete(callback);
  }
}

/**
 * Whether the task conversation has made the task a rule's template and drawn its graph.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Whether it has.
 */
function isTemplateReady(task: Task): boolean {
  return task.scheduleDraft !== null && task.activeGraph === 1;
}

/**
 * How many timers a tracker holds; zero for a kind never seen.
 *
 * @sideEffects none
 * @param resources - The tracker.
 * @returns The count.
 */
function timersOf(resources: ResourceTracker): number {
  return resources.snapshot()["timer"] ?? 0;
}

/**
 * A function that gives the names one after the other.
 *
 * @sideEffects none
 * @param names - The names.
 * @returns The function; past the end it gives the last name again.
 */
function sequence(names: readonly string[]): () => string {
  let next = 0;
  return () => {
    const name = names[Math.min(next, names.length - 1)] ?? "";
    next += 1;
    return name;
  };
}

/**
 * A rule's template.
 *
 * @sideEffects none
 * @param id - The template's id.
 * @returns The task.
 */
function template(id: string): Task {
  return {
    ...newTask([agent("N1")], []),
    id,
    scheduleDraft: { when: { every: "interval", minutes: 5 }, place: "new_worktree" },
  };
}

describe('the schedule clock leaves nothing behind (testing.md, "泄漏测试")', () => {
  it("holds one timer while a rule is active, none after it is paused, deleted, or the service closes, however often it was changed", async () => {
    const dir = await createTempDir("schedules-leak-");
    onTestFinished(dir.cleanup);
    const clock = new CountingClock();
    const resources = new ResourceTracker();
    const ids = sequence(["rul_a", "rul_b"]);
    const service = createScheduleService({
      file: join(dir.path, "schedules.json"),
      clock,
      resources,
      logger: recordingTracing().logger,
      tasks: {
        lookup: async () => undefined,
        createScheduled: async () => "tsk_x",
        discardTemplate: async () => undefined,
      },
      timeZone: "UTC",
      newId: ids,
    });
    const timers = () => timersOf(resources);
    await service.start();
    expect(timers()).toBe(0);

    for (let round = 0; round < 20; round += 1) {
      await service.confirm(template("tsk_1"), "wsp_1");
      await service.pause("rul_a");
      expect([timers(), clock.timers.size]).toStrictEqual([0, 0]);
      await service.resume("rul_a");
      expect([timers(), clock.timers.size]).toStrictEqual([1, 1]);
    }
    await service.confirm(template("tsk_2"), "wsp_1");
    expect(timers()).toBe(1);
    await service.remove("rul_a");
    expect(timers()).toBe(1);
    await service.remove("rul_b");
    expect([timers(), clock.timers.size]).toStrictEqual([0, 0]);

    await service.confirm(template("tsk_3"), "wsp_1");
    expect(timers()).toBe(1);
    await service.close();
    expect([timers(), clock.timers.size]).toStrictEqual([0, 0]);
  });

  it("leaves no timer when a ringing timer finds the service closed", async () => {
    const dir = await createTempDir("schedules-leak-");
    onTestFinished(dir.cleanup);
    const clock = new CountingClock();
    const resources = new ResourceTracker();
    const service = createScheduleService({
      file: join(dir.path, "schedules.json"),
      clock,
      resources,
      logger: recordingTracing().logger,
      tasks: {
        lookup: async () => undefined,
        createScheduled: async () => "tsk_x",
        discardTemplate: async () => undefined,
      },
      timeZone: "UTC",
    });
    await service.start();
    await service.confirm(template("tsk_1"), "wsp_1");
    const [ring] = [...clock.timers];
    await service.close();
    ring?.();
    await service.idle();
    expect([timersOf(resources), clock.timers.size]).toStrictEqual([0, 0]);
  });

  it("in a host: the clock's timer is gone when the host closes, and the rule is on disk for the next", async () => {
    const harness = await startTaskHost(
      {},
      {
        source: [{ blocks: [{ type: "text", text: "Plan." }] }],
        design: [
          {
            blocks: [
              {
                type: "toolCall",
                id: "a",
                name: "task_set_summary",
                arguments: {
                  summary: {
                    goal: "g",
                    decisions: [],
                    constraints: [],
                    nonGoals: [],
                    openQuestions: [],
                    acceptance: [],
                  },
                },
              },
            ],
          },
          {
            blocks: [
              {
                type: "toolCall",
                id: "b",
                name: "task_set_schedule",
                arguments: { when: { every: "interval", minutes: 5 }, place: "local_readonly" },
              },
            ],
          },
          {
            blocks: [
              {
                type: "toolCall",
                id: "c",
                name: "task_propose_graph",
                arguments: { nodes: [agent("N1", "explore")], edges: [], note: "" } as never,
              },
            ],
          },
          { blocks: [{ type: "text", text: "done" }] },
        ],
      },
    );
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.until(taskId, isTemplateReady);
    await harness.client.startTask(taskId);
    const { resources } = harness.host.host;
    expect(timersOf(resources)).toBeGreaterThan(0);

    await harness.host.dispose();
    expect(timersOf(resources)).toBe(0);
  });
});
