import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import atriumFast, { type FastApi } from "./extension";

/** The command and request hook the extension registered, as pi would keep them. */
interface Registered {
  readonly command: { readonly name: string; readonly description: string; run(args: string): Promise<void> };
  /** pi's request hook, as pi calls it before each request. */
  request(payload: unknown, model?: { readonly provider: string; readonly id: string }): unknown;
}

/** The model Fast is for. */
const GPT = { provider: "openai-codex", id: "gpt-5.5" };

/**
 * Loads the extension into a stand-in for pi's extension API.
 *
 * @remarks
 * The real pi loads it in `fast.pi.test.ts`; here each case runs without a process.
 *
 * @sideEffects none
 * @returns What it registered.
 * @throws {Error} When it registered no command or hook.
 */
function load(): Registered {
  let command: Registered["command"] | undefined;
  let hook: Parameters<FastApi["on"]>[1] | undefined;
  atriumFast({
    registerCommand: (name, options) => {
      command = { name, description: options.description, run: options.handler };
    },
    on: (event, handler) => {
      if (event === "before_provider_request") hook = handler;
      return () => undefined;
    },
  });
  if (command === undefined || hook === undefined) throw new Error("the extension registered too little");
  const registered = hook;
  return { command, request: (payload, model) => registered({ payload }, { model }) };
}

describe("atriumFast", () => {
  // oxlint-disable-next-line vitest/expect-expect -- a type check: typecheck fails it, not the run.
  it("fits pi's extension API", () => {
    expectTypeOf<ExtensionAPI>().toExtend<FastApi>();
  });

  it("registers the host's switch as its only command", () => {
    const { command } = load();

    expect([command.name, command.description]).toStrictEqual([
      "atrium-fast",
      "Atrium's Fast switch, sent by Atrium's host",
    ]);
  });

  it("leaves requests as pi built them until switched on", () => {
    const fast = load();

    expect(fast.request({ model: "gpt-5.5" }, GPT)).toBeUndefined();
  });

  it("asks for the priority tier once on, on a copy of pi's request, and stops once off", async () => {
    const fast = load();
    const payload = { model: "gpt-5.5", service_tier: "auto" };

    await fast.command.run(" on ");
    const on = fast.request(payload, GPT);
    await fast.command.run("off");

    expect(on).toStrictEqual({ model: "gpt-5.5", service_tier: "priority" });
    expect(payload).toStrictEqual({ model: "gpt-5.5", service_tier: "auto" });
    expect(fast.request(payload, GPT)).toBeUndefined();
  });

  it("keeps its state on any other word", async () => {
    const fast = load();

    await fast.command.run("on");
    await fast.command.run("status");
    const stillOn = fast.request({}, GPT);
    await fast.command.run("off");
    await fast.command.run("ON");

    expect(stillOn).toStrictEqual({ service_tier: "priority" });
    expect(fast.request({}, GPT)).toBeUndefined();
  });

  it.each([
    ["a model without Fast", {}, { provider: "openai-codex", id: "gpt-5.3-codex" }],
    ["no model", {}, undefined],
    ["a body that is not an object", "text", GPT],
    ["no body", null, GPT],
    ["a list", [1], GPT],
  ])("leaves the request of %s alone while on", async (_case, payload, model) => {
    const fast = load();

    await fast.command.run("on");

    expect(fast.request(payload, model)).toBeUndefined();
  });
});
