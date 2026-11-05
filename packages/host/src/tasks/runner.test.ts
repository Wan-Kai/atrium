import { createTempDir } from "@atrium/testkit";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import type { Clock } from "../platform/clock";
import type { TaskSessionSignal, TaskSessions } from "../sessions/task-sessions";
import type { TaskWorkspaces } from "./node-ports";
import { createTaskRunner } from "./runner";
import { openTaskStore } from "./task-store";
import { agent, newTask } from "./test-support";
import type { Task } from "./types";

/** The node the tests run. */
const SESSION = "ses_n1";

/** What a fake session layer was asked, and the means to speak as it. */
interface Fake {
  readonly sessions: TaskSessions;
  /** The calls made, as `kind:text`. */
  readonly calls: string[];
  /** Says something as the node's session. */
  say(signal: TaskSessionSignal): void;
  /** Makes the next `prompt` wait until its signal aborts. */
  hangPrompts(): void;
  stopped: number;
}

/**
 * A session layer that does what a test says and nothing else.
 *
 * @remarks
 * Only the session layer is faked, which is the boundary under test; the runner, its queue, the scheduler and the
 * store are the real ones (testing.md, "能用真的就用真的").
 *
 * @sideEffects none
 * @returns The fake.
 */
function fake(): Fake {
  const listeners = new Set<(sessionId: string, signal: TaskSessionSignal) => void>();
  const calls: string[] = [];
  let hang = false;
  const state = { stopped: 0 };
  const sessions: TaskSessions = {
    create: () => Promise.resolve(SESSION),
    find: () => undefined,
    recordOf: () => ({ taskId: "tsk_1", role: "node", node: "N1", attempt: 1, nodeRole: "explore", startOn: null }),
    open: () => Promise.resolve(),
    prompt(_id, text, signal) {
      calls.push(`prompt:${text.slice(0, 20)}`);
      if (!hang) return Promise.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    },
    command(_id, text) {
      calls.push(`command:${text.slice(0, 40)}`);
      return Promise.resolve();
    },
    alive: () => true,
    stop() {
      state.stopped += 1;
      return Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    sessions,
    calls,
    say: (signal) => {
      for (const listener of listeners) listener(SESSION, signal);
    },
    hangPrompts: () => {
      hang = true;
    },
    get stopped() {
      return state.stopped;
    },
  };
}

/** Workspaces that need no git. */
let unlocked = 0;
const workspaces: TaskWorkspaces = {
  ensure: () => Promise.resolve({ workspaceId: "w", baseCommit: "c" }),
  dirOf: () => "/tmp",
  containerOf: () => "c1",
  lock: () => Promise.resolve(),
  unlock() {
    unlocked += 1;
    return Promise.resolve();
  },
};

/**
 * A runner over a fake session layer and a task of one explore node, started.
 *
 * @sideEffects Creates a temporary directory; the runner is closed when the test finishes.
 * @param clock - The clock the runner reads.
 * @returns The fake, the runner and a way to read the task.
 */
async function setup(clock: Clock = systemClock) {
  const dir = await createTempDir("runner");
  onTestFinished(dir.cleanup);
  const { logger, resources } = recordingTracing();
  const sessionLayer = fake();
  const runner = createTaskRunner({
    sessions: sessionLayer.sessions,
    workspaces,
    git: Promise.resolve(null),
    clock,
    logger,
    resources,
  });
  onTestFinished(() => runner.close());
  const store = await openTaskStore(join(dir.path, "tsk_1"), clock);
  runner.attach("tsk_1", store);
  const task: Task = newTask([agent("N1", "explore")], [], { workspaceState: "ready" });
  await runner.submit("tsk_1", { type: "created", task });
  await runner.submit("tsk_1", { type: "started" });
  await runner.idle();
  return { fake: sessionLayer, runner, run: () => runner.task("tsk_1")?.runs[0], unlocks: () => unlocked };
}

/** A pi event of the node's session. */
const pi = (type: string): TaskSessionSignal => ({ kind: "pi", epoch: 1, event: { type } as never });

/** A `node_done` call as the extension writes it on its status line. */
const doneCall = (id: string): TaskSessionSignal => ({
  kind: "request",
  epoch: 1,
  text: JSON.stringify({ v: 1, kind: "call", id, op: "node_done", args: { ok: true, summary: "all done" } }),
});

/** A control state of the session with or without an open question. */
const control = (question: boolean, failure = false): TaskSessionSignal => ({
  kind: "session",
  epoch: 1,
  event: {
    type: "control_updated",
    control: { question: question ? { id: "q" } : null, failure: failure ? { reason: "crashed", attempts: 3 } : null },
  } as never,
});

describe("the runner, with a fake session layer", () => {
  it("takes a node_done at once after a question was answered, as the same queue records both", async () => {
    const { fake: layer, runner, run } = await setup();
    layer.say(pi("agent_start"));
    layer.say(control(true));
    await runner.idle();
    layer.say(control(false));
    // No wait in between: the node was resumed in the queue, ahead of the call.
    layer.say(doneCall("c1"));
    layer.say(pi("agent_settled"));
    await runner.idle();

    expect(run()).toMatchObject({ state: "passed", summary: "all done" });
    expect(layer.calls.some((call) => call.includes("task_caller_invalid"))).toBe(false);
  });

  it("lets go of the worktree's lock again when it recovers a task that had already ended", async () => {
    const { fake: layer, runner, unlocks } = await setup();
    layer.say(pi("agent_start"));
    layer.say(doneCall("c1"));
    layer.say(pi("agent_settled"));
    await runner.idle();
    const before = unlocks();

    await runner.recover("tsk_1");

    expect(unlocks()).toBe(before + 1);
  });

  it("closes while a prompt is stuck, by aborting it, instead of waiting for pi", async () => {
    const dir = await createTempDir("runner-close");
    onTestFinished(dir.cleanup);
    const { logger, resources } = recordingTracing();
    const layer = fake();
    layer.hangPrompts();
    const runner = createTaskRunner({
      sessions: layer.sessions,
      workspaces,
      git: Promise.resolve(null),
      clock: systemClock,
      logger,
      resources,
    });
    runner.attach("tsk_1", await openTaskStore(join(dir.path, "tsk_1"), systemClock));
    await runner
      .submit("tsk_1", { type: "created", task: newTask([agent("N1", "explore")], []) })
      .catch(() => undefined);
    void runner.submit("tsk_1", { type: "started" }).catch(() => undefined);
    await new Promise<void>((done) => {
      setTimeout(done, 200);
    });
    expect(layer.calls.some((call) => call.startsWith("prompt"))).toBe(true);

    await runner.close();

    expect(resources.snapshot()).not.toHaveProperty("task.runner", 1);
  });

  it("reports a second crash of the same node after a rerun, not only the first", async () => {
    const { fake: layer, runner, run } = await setup();
    layer.say(pi("agent_start"));
    layer.say(control(false, true));
    await runner.idle();
    expect(run()).toMatchObject({ state: "failed", failure: "crashed" });

    await runner.submit("tsk_1", { type: "rerun_requested", node: "N1" });
    await runner.idle();
    expect(run()?.state).toBe("running");
    layer.say(control(false, true));
    await runner.idle();

    expect(run()).toMatchObject({ state: "failed", failure: "crashed" });
  });

  it("does not hold a node right after it was sent a turn that has not begun, until the turn is seen or a while passes", async () => {
    let now = 1_000;
    const clock: Clock = { now: () => now, setTimeout: (callback, ms) => systemClock.setTimeout(callback, ms) };
    const { fake: layer, runner, run } = await setup(clock);
    // The contract went; pi has not printed agent_start yet.
    await runner.submit("tsk_1", { type: "paused" });
    await runner.idle();
    expect(run()?.state).toBe("running");

    layer.say(pi("agent_start"));
    layer.say(pi("agent_settled"));
    await runner.idle();

    expect(run()?.state).toBe("held");
    now += 1;
  });

  it("holds a node at once when no turn is going and none is about to begin", async () => {
    let now = 1_000;
    const clock: Clock = { now: () => now, setTimeout: (callback, ms) => systemClock.setTimeout(callback, ms) };
    const { runner, run } = await setup(clock);
    now += 60_000;

    await runner.submit("tsk_1", { type: "paused" });
    await runner.idle();

    expect(run()?.state).toBe("held");
  });
});
