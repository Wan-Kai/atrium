import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOGIN_WORKER, fakePiTools } from "../../test/fake-pi-tools";
import { recordingTracing } from "../../test/recording-tracing";
import { createPiDeps } from "../platform/pi-deps";
import { systemClock } from "../platform/clock";
import { type Logins, createLogins } from "./logins";
import type { HostTools } from "./toolbox";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Tools with a fake pi in a scenario, removed after the test.
 *
 * @remarks
 * See {@link fakePiTools}.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @param scenario - What the fake pi does.
 * @param source - The package entry's source, when not the usual fake.
 * @returns The tools and the temporary directory.
 */
async function fakeTools(scenario: string, source?: string): Promise<{ tools: HostTools; dir: string }> {
  const { tools, dir, cleanup } = await fakePiTools(scenario, source);
  cleanups.push(cleanup);
  return { tools, dir };
}

/**
 * The logins with an in-memory log, closed after the test.
 *
 * @remarks
 * Resources are counted so a test can see the login program is gone.
 *
 * @sideEffects none
 * @param withWorker - Whether the login program was built.
 * @returns The logins, the log records and the resources.
 */
function logins(withWorker = true): {
  logins: Logins;
  records: Record<string, unknown>[];
  open: () => number;
} {
  const recording = recordingTracing();
  cleanups.push(recording.shutdown);
  const value = createLogins({
    worker: withWorker ? LOGIN_WORKER : undefined,
    deps: (env) => createPiDeps({ clock: systemClock, resources: recording.resources, logger: recording.logger, env }),
    logger: recording.logger,
  });
  cleanups.push(() => value.close());
  return {
    logins: value,
    records: recording.records,
    open: () => recording.resources.snapshot()["pi-login"] ?? 0,
  };
}

describe("Logins.status", () => {
  it("lists the providers that can sign in, with pi's names, the OAuth label and how each is signed in", async () => {
    const { tools } = await fakeTools("status");
    const { logins: value, open } = logins();

    expect(await value.status(tools)).toStrictEqual({
      state: "ready",
      providers: [
        {
          providerId: "acme",
          name: "Acme",
          oauth: { label: "Sign in with Acme", subscription: true },
          apiKey: true,
          signedIn: { method: "oauth", stored: true },
        },
        {
          providerId: "beta",
          name: "Beta",
          oauth: { label: "Beta OAuth", subscription: false },
          apiKey: false,
          signedIn: null,
        },
      ],
    });
    expect(open()).toBe(0);
  });

  it("is unavailable without the login program, the tools, a usable pi or Node 22.19", async () => {
    const { tools, dir } = await fakeTools("status");
    const { logins: value } = logins();

    expect(await logins(false).logins.status(tools)).toStrictEqual({ state: "unavailable" });
    expect(await value.status(null)).toStrictEqual({ state: "unavailable" });
    expect(
      await value.status({
        ...tools,
        pi: { status: "outdated", piPath: join(dir, "pi"), version: [0, 9, 0], minimum: [1, 0, 1] },
      }),
    ).toStrictEqual({ state: "unavailable" });
    expect(
      await value.status({ ...tools, node: { status: "outdated", nodePath: process.execPath, version: [20, 0, 0] } }),
    ).toStrictEqual({ state: "unavailable" });
  });

  it("is unavailable when pi is not a package the program can load", async () => {
    const { tools, dir } = await fakeTools("status");
    await writeFile(join(dir, "binary-pi"), "");
    const { logins: value } = logins();

    expect(
      await value.status({ ...tools, pi: { status: "ready", piPath: join(dir, "binary-pi"), version: [1, 0, 2] } }),
    ).toStrictEqual({ state: "unavailable" });
  });

  it("is unavailable when the check fails, and logs only the reason", async () => {
    const { tools } = await fakeTools("create-fails");
    const { logins: value, records } = logins();

    expect(await value.status(tools)).toStrictEqual({ state: "unavailable" });
    expect(records).toContainEqual(
      expect.objectContaining({ level: "warn", msg: "logins unavailable", reason: "failed" }),
    );
    expect(JSON.stringify(records)).not.toContain("auth.json is corrupt");
  });

  it("stops a check under way when closed, and waits for the program to go", async () => {
    const { tools } = await fakeTools("status-hangs");
    const { logins: value, open } = logins();
    const checking = value.status(tools);
    while (open() === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    await value.close();

    expect(open()).toBe(0);
    expect(await checking).toStrictEqual({ state: "unavailable" });
  });
});
