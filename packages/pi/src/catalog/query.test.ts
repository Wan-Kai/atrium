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
 * @returns The query's outcome, the logs, the open resources and the directory.
 */
async function query(behavior: ScriptedPiBehavior, signal = new AbortController().signal) {
  const dir = await createTempDir("query-models");
  cleanups.push(dir.cleanup);
  const fake = await writeScriptedPi(dir.path, behavior);
  const logs: LogRecord[] = [];
  const record = (fields: object, message: string): void => {
    logs.push({ fields: fields as Record<string, unknown>, message });
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
