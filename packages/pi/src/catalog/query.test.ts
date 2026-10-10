import { type ScriptedPiBehavior, createTempDir, writeScriptedPi } from "@atrium/testkit";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { PiDeps } from "../deps";
import { PiRequestError } from "../process/pi-process";
import { queryModels } from "./query";

/** One log call. */
interface LogRecord {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A model as pi lists it. */
const opus = {
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh" },
  input: ["text", "image"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

/**
 * Lists models from a fake pi that behaves as told.
 *
 * @remarks
 * Records logs and open resources, so a test can see pi's arguments (written to stderr) and that
 * the process was stopped.
 *
 * @sideEffects Creates a temporary directory, removed after the test; runs the fake pi.
 * @param behavior - What the fake pi does.
 * @param signal - Aborts the query.
 * @param onLog - Sees each log record as it is written.
 * @returns The query's outcome, the logs, the open resources and the directory.
 */
async function query(
  behavior: ScriptedPiBehavior,
  signal = new AbortController().signal,
  onLog: (fields: Readonly<Record<string, unknown>>) => void = () => undefined,
) {
  const dir = await createTempDir("query-models");
  cleanups.push(dir.cleanup);
  const fake = await writeScriptedPi(dir.path, behavior);
  const logs: LogRecord[] = [];
  const record = (fields: object, message: string): void => {
    logs.push({ fields: fields as Record<string, unknown>, message });
    onLog(fields as Record<string, unknown>);
  };
  const open = new Map<string, number>();
  const deps: PiDeps = {
    clock: {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    track(kind) {
      open.set(kind, (open.get(kind) ?? 0) + 1);
      return () => open.set(kind, (open.get(kind) ?? 0) - 1);
    },
    log: { debug: record, info: record, warn: record, error: record },
    nextRequestId: (() => {
      let next = 0;
      return () => `q${++next}`;
    })(),
    env: { PATH: process.env["PATH"] ?? "" },
  };
  const outcome = await queryModels({ piPath: fake.piPath, args: [], cwd: dir.path, env: fake.env }, deps, signal).then(
    (list) => ({ list }),
    (error: unknown) => ({ error }),
  );
  return { outcome, logs, open, dir: await realpath(dir.path) };
}

/**
 * Aborts once pi's stderr says it received a command.
 *
 * @remarks
 * For a fake pi that prints what it receives; the abort then lands while that command waits.
 *
 * @sideEffects Aborts the controller.
 * @param controller - What to abort.
 * @param type - The command.
 * @returns A log watcher for `query`.
 */
function abortOnReceipt(controller: AbortController, type: string) {
  return (fields: Readonly<Record<string, unknown>>): void => {
    if (String(fields["line"]).includes(`"type":"${type}"`)) controller.abort();
  };
}

describe("queryModels", () => {
  it("lists pi's models with pi's own default, from a pi without a session in the directory, and stops it", async () => {
    const { outcome, logs, open, dir } = await query({
      argvToStderr: true,
      rules: {
        get_available_models: { data: { models: [opus, { ...opus, id: "haiku", name: "Haiku", reasoning: false }] } },
        get_state: { data: { model: opus, thinkingLevel: "high", sessionId: "probe" } },
      },
    });

    expect(outcome).toStrictEqual({
      list: {
        models: [
          {
            providerId: "anthropic",
            modelId: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            contextWindow: 1_000_000,
            maxOutput: 128_000,
            supportsImage: true,
            thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
          },
          {
            providerId: "anthropic",
            modelId: "haiku",
            name: "Haiku",
            contextWindow: 1_000_000,
            maxOutput: 128_000,
            supportsImage: true,
            thinkingLevels: ["off"],
          },
        ],
        defaultModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    });
    const line = logs.find((log) => log.message === "pi stderr")?.fields["line"];
    expect(JSON.parse(String(line))).toStrictEqual({ argv: ["--mode", "rpc", "--no-session"], cwd: dir });
    expect(logs.filter((log) => log.message === "pi exited")).toMatchObject([{ fields: { requested: true } }]);
    expect(open.get("pi-process")).toBe(0);
  });

  it("has no default when pi's model is not one it lists, as its placeholder without credentials", async () => {
    const { outcome } = await query({
      rules: {
        get_available_models: { data: { models: [opus] } },
        get_state: { data: { model: { ...opus, id: "gone" }, thinkingLevel: "off", sessionId: "probe" } },
      },
    });

    expect(outcome).toMatchObject({ list: { defaultModel: null } });
  });

  it("has no default when pi's model is not listed by both its provider and id", async () => {
    const { outcome } = await query({
      rules: {
        get_available_models: {
          data: {
            models: [
              { ...opus, provider: "other" },
              { ...opus, id: "other" },
            ],
          },
        },
        get_state: { data: { model: opus, thinkingLevel: "off", sessionId: "probe" } },
      },
    });

    expect(outcome).toMatchObject({ list: { defaultModel: null } });
  });

  it("leaves out a model whose id is too long to send, and has no default when it was pi's", async () => {
    const long = { ...opus, id: "x".repeat(513) };
    const { outcome } = await query({
      rules: {
        get_available_models: { data: { models: [long] } },
        get_state: { data: { model: long, thinkingLevel: "off", sessionId: "probe" } },
      },
    });

    expect(outcome).toStrictEqual({ list: { models: [], defaultModel: null } });
  });

  it("has no default when pi reports no model though it lists some", async () => {
    const { outcome } = await query({
      rules: {
        get_available_models: { data: { models: [opus] } },
        get_state: { data: { thinkingLevel: "off", sessionId: "probe" } },
      },
    });

    expect(outcome).toMatchObject({ list: { defaultModel: null } });
  });

  it("stops pi when aborted while it reads pi's state", async () => {
    const controller = new AbortController();

    const { outcome, open } = await query(
      {
        receivedToStderr: true,
        rules: { get_available_models: { data: { models: [] } }, get_state: { silent: true } },
      },
      controller.signal,
      // Aborted once pi has the request, however long it took to start.
      abortOnReceipt(controller, "get_state"),
    );

    expect(outcome).toMatchObject({ error: { name: "PiRequestError", command: "get_state", reason: "aborted" } });
    expect(open.get("pi-process")).toBe(0);
  });

  it("has no default when pi reports no model", async () => {
    const { outcome } = await query({
      rules: {
        get_available_models: { data: { models: [] } },
        get_state: { data: { thinkingLevel: "medium", sessionId: "probe" } },
      },
    });

    expect(outcome).toStrictEqual({ list: { models: [], defaultModel: null } });
  });

  it("fails with pi's stderr when pi exits, as without any credentials", async () => {
    const { outcome, open } = await query({ stderr: "No models available.\n", exitCode: 1 });

    expect(outcome).toMatchObject({
      error: {
        name: "PiRequestError",
        command: "get_available_models",
        reason: "exited",
        detail: "No models available.\n",
      },
    });
    expect(open.get("pi-process")).toBe(0);
  });

  it("stops pi when aborted while it has not answered", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const { outcome, open } = await query({ rules: { get_available_models: { silent: true } } }, controller.signal);

    expect(outcome).toMatchObject({
      error: { name: "PiRequestError", command: "get_available_models", reason: "aborted" },
    });
    expect(open.get("pi-process")).toBe(0);
  });

  it("does not start pi when aborted before", async () => {
    const controller = new AbortController();
    controller.abort();

    const { outcome, open } = await query({}, controller.signal);

    expect(outcome).toStrictEqual({ error: new PiRequestError("get_available_models", "aborted") });
    expect(open.get("pi-process")).toBeUndefined();
  });
});
