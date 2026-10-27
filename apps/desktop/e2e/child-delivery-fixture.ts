import {
  createGitScene,
  type ReadmeFauxScript,
  README_FAUX_EXTENSION,
  README_FAUX_GATES_ENV,
  README_FAUX_LOG_ENV,
  README_FAUX_SCRIPT_ENV,
} from "@atrium/testkit";
import { expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp, type LaunchedApp } from "./launch";
import { observeChildDelivery, type ChildIdentity } from "./child-delivery-observation";
import { addProject } from "./projects";
import { send } from "./messages";

/** The synthetic parent's title, also used by the real child-to-parent navigation. */
export const DELIVERY_PARENT_TITLE = "查一下登录";

/** Known synthetic task inputs; UI checks compare them with the actual task IDs, never with a model's summary. */
export const DELIVERY_TASK_TEXT = {
  audit: "查一遍登录 [delivery-audit]",
  tests: "补登录测试 [delivery-tests]",
} as const;

/** Synthetic child replies are checked as display output, never as delivery barriers. */
export const DELIVERY_REPLY_TEXT = { audit: "审查结束", tests: "测试结束" } as const;

/** Existing README faux gates used by this fixture, not production configuration. */
export type DeliveryGate = "parent-boundary" | "parent-finish" | "audit-done" | "tests-done";

/** Actual identities and resources shared by the three child-delivery journeys. */
export interface ChildDeliveryContext {
  app: LaunchedApp;
  agentDir: string;
  repo: string;
  scene: Awaited<ReturnType<typeof createGitScene>>;
  probe: Awaited<ReturnType<typeof observeChildDelivery>>;
  parentId: string;
  parentTitle: string;
  audit: ChildIdentity;
  tests: ChildIdentity;
}

/** Only controlled C1/C2 add provider gates to the actual journey context. */
export interface ChildDeliveryFixture extends ChildDeliveryContext {
  initialTurnId: string;
  released: Set<DeliveryGate>;
  release(gate: DeliveryGate): Promise<void>;
  wait(gate: DeliveryGate): Promise<void>;
}

/** Supplies separate child gates and a real read boundary. @remarks Only the existing public README faux scripting surface is used. @sideEffects none */
function deliveryScript(path: string): ReadmeFauxScript {
  return {
    providers: [{ id: "faux", models: [{ id: "faux-1", name: "Faux delivery model" }] }],
    title: DELIVERY_PARENT_TITLE,
    branch: "delivery",
    replies: [
      {
        blocks: [
          {
            type: "toolCall",
            id: "spawn-audit",
            name: "agent_spawn",
            arguments: { name: "audit", task: DELIVERY_TASK_TEXT.audit },
          },
          {
            type: "toolCall",
            id: "spawn-tests",
            name: "agent_spawn",
            arguments: { name: "tests", task: DELIVERY_TASK_TEXT.tests, role: "work" },
          },
        ],
      },
      {
        waitFor: "parent-boundary",
        blocks: [{ type: "toolCall", id: "boundary-read", name: "read", arguments: { path } }],
      },
      { waitFor: "parent-finish", blocks: [{ type: "text", text: "这一轮结束" }] },
      { blocks: [{ type: "text", text: "收到后续通知" }] },
    ],
    children: [
      {
        match: "delivery-audit",
        replies: [{ waitFor: "audit-done", blocks: [{ type: "text", text: DELIVERY_REPLY_TEXT.audit }] }],
      },
      {
        match: "delivery-tests",
        replies: [{ waitFor: "tests-done", blocks: [{ type: "text", text: DELIVERY_REPLY_TEXT.tests }] }],
      },
    ],
  };
}

/** Reads arrival at the existing abortable gate. @remarks Arrival does not prove delivery or completion. @sideEffects Reads the private faux log. */
async function waiting(path: string, gate: DeliveryGate): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).split("\n").some((line) => line.endsWith(` waiting ${gate}`));
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return false;
    throw error;
  }
}

/** Requires the actual spawn identity. @remarks Missing/duplicate handles are fixture failures, not source-line red evidence. @sideEffects none @throws When the identity is not unique. */
export function childIdentity(probe: ChildDeliveryContext["probe"], parent: string, name: string): ChildIdentity {
  const matches = [...probe.turns.values()]
    .filter((turn) => turn.sessionId === parent)
    .flatMap((turn) => turn.steps)
    .flatMap((step) => (step.spawned?.name === name ? [step.spawned] : []));
  if (matches.length !== 1 || matches[0] === undefined) throw new Error("expected one actual child spawn");
  return matches[0];
}

/** Keeps all failures visible while closing every resource. @remarks No test failure may skip the remaining teardown. @sideEffects Runs cleanup and records failures. */
async function cleanup(action: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

/**
 * Runs one child-delivery test in an isolated real App with two independently gated children.
 * @remarks Keeps faux.env priority and the normal launch/log gate. No trace overrides, diagnostics,
 * production test RPC, extra timeout or speculative general-purpose fixture machinery.
 * @sideEffects Creates a temporary repo/home/pi configuration, opens the App and CDP, then closes/removes them.
 * @param run - The C1 or C2 assertions; all errors propagate after cleanup.
 */
export async function withChildDelivery(run: (fixture: ChildDeliveryFixture) => Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  const directory = await mkdtemp(join(tmpdir(), "atrium-child-delivery-"));
  try {
    const pi = await fauxPiEnvironment({ replies: [] });
    try {
      const scene = await createGitScene("e2e-child-delivery");
      try {
        const repo = await realpath(scene.repo);
        const path = join(repo, "delivery-read.txt");
        const gates = join(directory, "gates");
        const log = join(directory, "faux.log");
        const scriptPath = join(directory, "script.json");
        await mkdir(gates, { mode: 0o700 });
        await writeFile(path, "synthetic boundary file\n");
        await writeFile(scriptPath, JSON.stringify(deliveryScript(path)), { mode: 0o600 });
        const extension = README_FAUX_EXTENSION.replaceAll("'", String.raw`'\''`);
        // Only this environment's owned wrapper changes; installed pi discovery and --version remain unchanged.
        await writeFile(
          join(dirname(pi.agentDir), "bin", "pi"),
          `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "$E2E_REAL_PI" --version; fi\nexec "$E2E_REAL_PI" "$@" --extension '${extension}' --provider faux --model faux-1\n`,
        );
        const app = await launchApp({
          ...pi.env,
          [README_FAUX_SCRIPT_ENV]: scriptPath,
          [README_FAUX_GATES_ENV]: gates,
          [README_FAUX_LOG_ENV]: log,
        });
        try {
          const probe = await observeChildDelivery(app.window);
          try {
            const released = new Set<DeliveryGate>();
            /** Opens one existing gate after its preconditions. @remarks Tests explicitly control ordering. @sideEffects Creates a private gate file. */
            const release = async (gate: DeliveryGate): Promise<void> => {
              await writeFile(join(gates, gate), "", { mode: 0o600 });
              released.add(gate);
            };
            /** Waits for provider arrival, never a faux completion sentence. @remarks Uses the existing assertion budget. @sideEffects Polls a private log. */
            const wait = async (gate: DeliveryGate): Promise<void> => {
              await expect.poll(() => waiting(log, gate)).toBe(true);
            };
            await addProject(app.app, app.window, repo);
            await app.window.getByTestId("workspace-row").click({ timeout: 30_000 });
            await app.window.keyboard.press("Meta+T");
            await expect(app.window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
            await send(app.window, DELIVERY_PARENT_TITLE);
            for (const gate of ["parent-boundary", "audit-done", "tests-done"] as const) await wait(gate);
            await expect.poll(() => probe.runs.some((item) => item.type === "run_started")).toBe(true);
            const parentId = probe.runs[0]?.sessionId;
            if (parentId === undefined) throw new Error("parent run identity missing");
            await expect
              .poll(() =>
                [...probe.turns.values()]
                  .filter((turn) => turn.sessionId === parentId)
                  .flatMap((turn) => turn.steps)
                  .flatMap((step) => (step.spawned === null ? [] : [step.spawned.name]))
                  .toSorted(),
              )
              .toStrictEqual(["audit", "tests"]);
            const initialTurnId = [...probe.turns.values()].find((turn) => turn.sessionId === parentId)?.turnId;
            if (initialTurnId === undefined) throw new Error("parent turn identity missing");
            await run({
              app,
              agentDir: pi.agentDir,
              repo,
              scene,
              probe,
              parentId,
              parentTitle: DELIVERY_PARENT_TITLE,
              initialTurnId,
              audit: childIdentity(probe, parentId, "audit"),
              tests: childIdentity(probe, parentId, "tests"),
              released,
              release,
              wait,
            });
          } finally {
            await cleanup(() => probe.close(), errors);
          }
        } finally {
          await cleanup(() => app.close(), errors);
        }
      } finally {
        await cleanup(() => scene.cleanup(), errors);
      }
    } finally {
      await cleanup(() => pi.cleanup(), errors);
    }
  } catch (error) {
    errors.unshift(error);
  } finally {
    await cleanup(() => rm(directory, { recursive: true, force: true }), errors);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "child delivery assertion and cleanup failed");
}
