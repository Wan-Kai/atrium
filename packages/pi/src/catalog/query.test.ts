import { type ScriptedPiBehavior, createTempDir, writeScriptedPi } from "@atrium/testkit";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { PiDeps } from "../deps";
import { PiRequestError } from "../process/pi-process";
import { type QueryOptions, queryModels } from "./query";

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
 * @param options - The query's options.
 * @returns The query's outcome, the logs, the open resources and the directory.
 */
async function query(
  behavior: ScriptedPiBehavior,
  signal = new AbortController().signal,
  onLog: (fields: Readonly<Record<string, unknown>>) => void = () => undefined,
  options: QueryOptions = {},
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
  const launch = { piPath: fake.piPath, args: [], cwd: dir.path, env: fake.env };
  const outcome = await queryModels(launch, deps, signal, options).then(
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
            fast: null,
          },
          {
            providerId: "anthropic",
            modelId: "haiku",
            name: "Haiku",
            contextWindow: 1_000_000,
            maxOutput: 128_000,
            supportsImage: true,
            thinkingLevels: ["off"],
            fast: null,
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

/** ChatGPT's GPT-5.5, as pi lists it. */
const gpt = {
  ...opus,
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
};

/** Where the host keeps the Fast extension; the scripted pi only shows it got it. */
const FAST_EXTENSION = "/atrium/fast/extension.ts";

/** Atrium's switch, as pi lists it once the extension is loaded. */
const SWITCH = { name: "atrium-fast", description: "Atrium's Fast switch", source: "extension" };

/** The models and state a pi with ChatGPT's login answers: GPT-5.5, 6 and 6.1-sol, and Opus. */
const CODEX_RULES = {
  get_available_models: {
    data: {
      models: [opus, gpt, { ...gpt, id: "gpt-6", name: "GPT-6" }, { ...gpt, id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
    },
  },
  get_state: { data: { model: gpt, thinkingLevel: "off", sessionId: "probe" } },
  // pi lists the switch among its other commands.
  get_commands: {
    data: { commands: [{ name: "review", description: "Reviews the change", source: "prompt" }, SWITCH] },
  },
};

/**
 * The status the extension sets, as pi prints it.
 *
 * @remarks
 * pi sends it before answering the prompt that ran the command (pi-internals.md §5).
 *
 * @sideEffects none
 * @param text - The status text.
 * @param key - The status key.
 * @returns The record.
 */
function status(text: string, key = "atrium-fast") {
  return { type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: key, statusText: text };
}

/**
 * What Fast does for each model a query listed.
 *
 * @remarks
 * The rest of each model is checked by the tests above.
 *
 * @sideEffects none
 * @param outcome - The query's outcome.
 * @returns Each model's id with its `fast`.
 */
function fastOfEach(outcome: Awaited<ReturnType<typeof query>>["outcome"]): Record<string, unknown> {
  if (!("list" in outcome)) throw new Error("the query failed");
  return Object.fromEntries(outcome.list.models.map((model) => [model.modelId, model.fast]));
}

/**
 * The commands a scripted pi received, from its stderr.
 *
 * @remarks
 * For a scripted pi with `receivedToStderr`.
 *
 * @sideEffects none
 * @param logs - The query's logs.
 * @returns Each command as received.
 */
function received(logs: readonly LogRecord[]): Record<string, unknown>[] {
  return logs.flatMap((log) => {
    const line = log.message === "pi stderr" ? String(log.fields["line"]) : "";
    return line.startsWith('{"received"') ? [(JSON.parse(line) as { received: Record<string, unknown> }).received] : [];
  });
}

/** What the built-in rule gives. */
const FALLBACK = { speed: null, moreUsage: true };

describe("queryModels with the Fast extension", () => {
  it("has pi load it and asks it for Codex's model list, which decides Fast for the models it names", async () => {
    const report = {
      models: [
        { id: "gpt-5.5", fast: null },
        { id: "gpt-6.1-sol", fast: { speed: 2, moreUsage: true } },
      ],
    };
    const { outcome, logs } = await query(
      {
        argvToStderr: true,
        receivedToStderr: true,
        rules: {
          ...CODEX_RULES,
          prompt: {
            events: [status(JSON.stringify(report)), status('{"failure":"other"}', "other")],
            data: { disposition: "handled" },
          },
        },
      },
      undefined,
      undefined,
      { fastExtension: FAST_EXTENSION },
    );

    expect(fastOfEach(outcome)).toStrictEqual({
      "claude-opus-5-5": null,
      "gpt-5.5": null,
      "gpt-6": FALLBACK,
      "gpt-6.1-sol": { speed: 2, moreUsage: true },
    });
    expect(outcome).toMatchObject({ list: { defaultModel: { providerId: "openai-codex", modelId: "gpt-5.5" } } });
    const line = logs.find((log) => log.message === "pi stderr")?.fields["line"];
    expect(JSON.parse(String(line))).toMatchObject({
      argv: ["--mode", "rpc", "--extension", FAST_EXTENSION, "--no-session"],
    });
    expect(received(logs).map(({ type, message }) => [type, message])).toStrictEqual([
      ["get_available_models", undefined],
      ["get_state", undefined],
      ["get_commands", undefined],
      ["prompt", "/atrium-fast tiers"],
    ]);
    expect(logs.filter((log) => log.message === "fast tiers unavailable")).toStrictEqual([]);
  });

  it.each([
    ["a failure", [status('{"failure":"http_401"}')], "http_401"],
    ["a report that does not fit", [status('{"models":[{"id":"gpt-5.5","fast":2.5}]}')], "no_report"],
    ["no report", [], "no_report"],
  ])("goes by the built-in rule after %s, logging only its code", async (_case, events, failure) => {
    const { outcome, logs } = await query(
      { rules: { ...CODEX_RULES, prompt: { events, data: { disposition: "handled" } } } },
      undefined,
      undefined,
      { fastExtension: FAST_EXTENSION },
    );

    expect(fastOfEach(outcome)).toStrictEqual({
      "claude-opus-5-5": null,
      "gpt-5.5": FALLBACK,
      "gpt-6": FALLBACK,
      "gpt-6.1-sol": FALLBACK,
    });
    expect(logs.filter((log) => log.message === "fast tiers unavailable").map((log) => log.fields)).toStrictEqual([
      { failure },
    ]);
  });

  it.each([
    ["does not answer in time", { silent: true } as const, "pi_timeout"],
    ["refuses the prompt", { fail: "no" }, "pi_rejected"],
  ])("goes by the built-in rule when pi %s, and stops pi", async (_case, rule, failure) => {
    const { outcome, logs, open } = await query({ rules: { ...CODEX_RULES, prompt: rule } }, undefined, undefined, {
      fastExtension: FAST_EXTENSION,
      fastTiersWaitMs: 200,
    });

    expect(fastOfEach(outcome)["gpt-5.5"]).toStrictEqual(FALLBACK);
    expect(logs.filter((log) => log.message === "fast tiers unavailable").map((log) => log.fields)).toStrictEqual([
      { failure },
    ]);
    expect(open.get("pi-process")).toBe(0);
  });

  it("stops pi when aborted while it lists its commands", async () => {
    const controller = new AbortController();

    const { outcome, open } = await query(
      { receivedToStderr: true, rules: { ...CODEX_RULES, get_commands: { silent: true } } },
      controller.signal,
      abortOnReceipt(controller, "get_commands"),
      { fastExtension: FAST_EXTENSION },
    );

    expect(outcome).toStrictEqual({ error: new PiRequestError("get_commands", "aborted") });
    expect(open.get("pi-process")).toBe(0);
  });

  it("stops pi when aborted while the extension asks", async () => {
    const controller = new AbortController();

    const { outcome, open } = await query(
      { receivedToStderr: true, rules: { ...CODEX_RULES, prompt: { silent: true } } },
      controller.signal,
      abortOnReceipt(controller, "prompt"),
      { fastExtension: FAST_EXTENSION },
    );

    expect(outcome).toMatchObject({ error: { name: "PiRequestError", command: "prompt", reason: "aborted" } });
    expect(open.get("pi-process")).toBe(0);
  });

  it.each([
    [
      "pi lists no switch of the extension's",
      { ...CODEX_RULES, get_commands: { data: { commands: [{ ...SWITCH, source: "prompt" }] } } },
      ["get_available_models", "get_state", "get_commands"],
    ],
    [
      "pi lists none of ChatGPT's models",
      { ...CODEX_RULES, get_available_models: { data: { models: [opus, { ...gpt, provider: "openai" }] } } },
      ["get_available_models", "get_state"],
    ],
  ])("asks nothing more when %s", async (_case, rules, types) => {
    const { outcome, logs } = await query({ receivedToStderr: true, rules }, undefined, undefined, {
      fastExtension: FAST_EXTENSION,
    });

    expect("list" in outcome).toBe(true);
    expect(received(logs).map(({ type }) => type)).toStrictEqual(types);
    expect(logs.filter((log) => log.message === "fast tiers unavailable")).toStrictEqual([]);
  });

  it("goes by the built-in rule without the extension, asking pi nothing more", async () => {
    const { outcome, logs } = await query({ argvToStderr: true, receivedToStderr: true, rules: CODEX_RULES });

    expect(fastOfEach(outcome)).toStrictEqual({
      "claude-opus-5-5": null,
      "gpt-5.5": FALLBACK,
      "gpt-6": FALLBACK,
      "gpt-6.1-sol": FALLBACK,
    });
    expect(received(logs).map(({ type }) => type)).toStrictEqual(["get_available_models", "get_state"]);
  });
});
