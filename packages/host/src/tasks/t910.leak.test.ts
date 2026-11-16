import type { LogEntry } from "@atrium/pi";
import { createTempDir } from "@atrium/testkit";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { ResourceTracker } from "../platform/resources";
import type { TaskSessions } from "../sessions/task-sessions";
import type { TaskWorkspaces } from "./node-ports";
import { createTaskRunner } from "./runner";
import { createScheduleService } from "./schedule-service";
import { createTaskService } from "./task-service";
import { agent, need, newTask } from "./test-support";

vi.setConfig({ testTimeout: 30_000 });

describe("a host that closes while a trigger waits for a pi that never answers leaves nothing behind (testing.md, 泄漏测试)", () => {
  it("closes the schedules and then the tasks, with no timer, no runner and no pending prompt left", async () => {
    const dir = await createTempDir("t910-leak");
    onTestFinished(dir.cleanup);
    const { logger } = recordingTracing();
    const resources = new ResourceTracker();
    let prompts = 0;
    const sessions: TaskSessions = {
      create: () => Promise.resolve("ses_made"),
      find: () => undefined,
      recordOf: () => undefined,
      open: () => Promise.resolve(),
      // pi never acknowledges the contract: only the runner's closing signal ends the wait.
      prompt(_id, _text, signal) {
        prompts += 1;
        return new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("closing")), { once: true });
        });
      },
      command: () => Promise.resolve(),
      source: () => undefined,
      transcript: () => Promise.resolve([] as LogEntry[]),
      deliver: () => Promise.resolve(),
      conversations: () => [],
      retire: () => Promise.resolve(),
      alive: () => false,
      stop: () => Promise.resolve(),
      subscribe: () => () => undefined,
    };
    const workspaces: TaskWorkspaces = {
      ensure: () => Promise.resolve({ workspaceId: "w", baseCommit: "c" }),
      dirOf: () => "/tmp",
      containerOf: () => "c1",
      lock: () => Promise.resolve(),
      unlock: () => Promise.resolve(),
      merge: () => Promise.resolve({ kind: "merged" }),
      clearStaleLocks: () => Promise.resolve(0),
    };
    const runner = createTaskRunner({
      sessions,
      workspaces,
      git: Promise.resolve(null),
      clock: systemClock,
      logger,
      resources,
    });
    const tasks = createTaskService({
      runner,
      root: join(dir.path, "tasks"),
      clock: systemClock,
      logger,
      archiving: {
        facts: () => Promise.resolve(null),
        changes: () => Promise.resolve(null),
        archive: () => Promise.resolve(),
      },
      design: {
        sessions: {
          source: () => undefined,
          create: (session) => sessions.create(session),
          open: () => Promise.resolve(),
          prompt: () => Promise.resolve(),
          command: () => Promise.resolve(),
          conversations: () => [],
          retire: () => Promise.resolve(),
          recordOf: () => undefined,
        },
        placement: () => ({ projectId: null, borrowed: null }),
      },
    });
    const schedules = createScheduleService({
      file: join(dir.path, "schedules.json"),
      clock: systemClock,
      resources,
      logger,
      tasks,
      timeZone: "UTC",
    });
    await schedules.load();
    await tasks.create({
      ...newTask([agent("N1", "explore")], []),
      id: "tsk_tpl",
      taskSessionId: "ses_tpl",
      projectId: "prj_0123456789abcdef",
      sourceDir: "/work",
      scheduleDraft: { when: { every: "interval", minutes: 5 }, place: "new_worktree" },
    });
    const rule = await schedules.confirm(need(await tasks.lookup("tsk_tpl")), "wsp_1");
    await schedules.start();
    const running = schedules.runNow(rule.id).catch((error: unknown) => error);
    await vi.waitFor(() => expect(prompts).toBeGreaterThan(0));

    // As the host closes them: both told to stop before either is waited for.
    const schedulesClosed = schedules.close();
    const tasksClosed = tasks.close();
    await schedulesClosed;
    await tasksClosed;
    expect(await running).toBeInstanceOf(Error);

    expect(resources.snapshot()).toStrictEqual({ "task.runner": 0, timer: 0 });
  });
});
