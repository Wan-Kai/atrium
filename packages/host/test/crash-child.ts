import { startHost } from "../src/main";
import { newTaskRecord } from "../src/tasks/new-task";
import type { GraphEdge, GraphNode } from "../src/tasks/types";

/*
 * A host in a process of its own, for the test that kills it (`t910.crash.host.test.ts`). It is bundled by the test and
 * run with Node; what it is to do comes in the environment, what it does comes out as JSON lines on stdout.
 */

/** The name the faux model's scripts expect in a contract (`TASK_NAME` of task-harness.ts, which pulls in vitest and cannot be bundled here). */
const TASK_NAME = "test task";

/** What the test hands the child. */
interface ChildConfig {
  readonly home: string;
  readonly repo: string;
  readonly extension: string;
  readonly env: Record<string, string>;
  readonly taskId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/**
 * Starts a host, makes a task of the graph given, starts it, and reports each event the task records.
 *
 * @remarks
 * Then it waits to be killed; it never closes the host itself.
 *
 * @sideEffects Starts a host and pi processes; writes the task's files; prints to stdout.
 */
async function main(): Promise<void> {
  const config = JSON.parse(process.env["CRASH_CHILD"] ?? "{}") as ChildConfig;
  const host = await startHost({
    home: config.home,
    token: "child-token-0123456789abcdefghijklmnopqrstuvwxyz",
    logLevel: "warn",
    toolEnv: config.env,
    homebrewPlaces: [],
    piLatestUrl: null,
    fastExtension: config.extension,
  });
  await host.tools;
  const projectId =
    host.projects.projects().find((project) => project.path === config.repo)?.id ??
    (await host.projects.add(config.repo));
  host.tasks.onEvent((_task, event) => {
    process.stdout.write(`${JSON.stringify({ type: "event", event: event.type })}\n`);
  });
  await host.tasks.create(
    newTaskRecord({
      id: config.taskId,
      name: TASK_NAME,
      projectId,
      sourceDir: config.repo,
      originSessionId: "ses_origin",
      taskSessionId: "ses_task",
      model: { providerId: "faux", modelId: "faux-1", thinking: "off" },
      goal: "make out.txt",
      nodes: config.nodes,
      edges: config.edges,
      now: Date.now(),
    }),
  );
  await host.tasks.submit(config.taskId, { type: "started" });
  process.stdout.write(`${JSON.stringify({ type: "started" })}\n`);
  setInterval(() => undefined, 1000);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
