import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FAUX_API,
  FAUX_BASE_URL_ENV,
  FAUX_CONTEXTS_FILE,
  FAUX_GATES_ENV,
  FAUX_PAYLOADS_FILE,
  FAUX_PID_FILE,
  FAUX_PRINTS_FILE,
  FAUX_MODEL,
  FAUX_PROVIDER,
  FAUX_SCRIPT_ENV,
  type FauxReply,
  type FauxScript,
} from "./script";

/** The part of pi's extension API this extension uses. */
interface ExtensionApi {
  on(
    event: "input",
    handler: (event: { readonly text: string; readonly source: string }) => { readonly action: "continue" | "handled" },
  ): void;
  registerProvider(
    name: string,
    config: {
      readonly api: string;
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly models: readonly ReturnType<typeof fauxProvider>["models"][number][];
      readonly streamSimple: ReturnType<typeof fauxProvider>["provider"]["streamSimple"];
    },
  ): void;
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, ctx: CommandContext) => Promise<void>;
    },
  ): void;
}

/** The part of a command's context these commands use. */
interface CommandContext {
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  /** Moves the session's current position, as pi's tree navigation does. */
  navigateTree(targetId: string): Promise<{ readonly cancelled: boolean }>;
}

/**
 * Resolves once the gate file exists or the request is aborted.
 *
 * @remarks
 * Polls, because pi gives the provider no other way to hear from the test. An abort must end the
 * wait, or a test that aborts a held reply would hang.
 *
 * @sideEffects Checks the file system every 20 ms.
 * @param path - The gate file.
 * @param signal - The request's abort signal.
 */
async function waitForGate(path: string, signal: AbortSignal | undefined): Promise<void> {
  for (;;) {
    if (existsSync(path) || signal?.aborted === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Adds the body of a request to the payloads file, as pi's extensions leave it.
 *
 * @remarks
 * A real provider builds its request body and hands it to `onPayload`, which runs pi's
 * `before_provider_request` hooks (pi-internals.md §5); faux builds none, so it stands one in, with
 * only the model's id, and keeps what the hooks return, or its own when they change nothing.
 *
 * @sideEffects Calls pi's hooks; appends a line to the file.
 * @param file - The payloads file.
 * @param model - The model asked.
 * @param onPayload - pi's hook runner, when pi gave one.
 */
async function recordPayload<M extends { readonly id: string }>(
  file: string,
  model: M,
  onPayload: ((payload: unknown, model: M) => unknown) | undefined,
): Promise<void> {
  const payload = { model: model.id };
  const changed: unknown = await onPayload?.(payload, model);
  appendFileSync(file, `${JSON.stringify(changed ?? payload)}\n`);
}

/**
 * Adds what a request carried to the contexts file: the tools' names and the messages.
 *
 * @remarks
 * SPEC-0002's contract tests check what the model can see: which tools a limited pi declares, and
 * how custom messages and unanswered tool calls reach it.
 *
 * @sideEffects Appends a line to the file.
 * @param file - The contexts file.
 * @param context - The request's context, as pi gave it to the provider.
 */
function recordContext(
  file: string,
  context: { readonly messages: readonly unknown[]; readonly tools?: readonly { readonly name: string }[] },
): void {
  const tools = declaredTools(context);
  appendFileSync(file, `${JSON.stringify({ tools, messages: context.messages })}\n`);
}

/**
 * The names of the tools a request declares to the model.
 *
 * @remarks
 * pi 1.1 declares tools in its system messages, `toolsAdded` and `toolsRemoved` replayed in order,
 * and leaves `tools` empty; older pi listed them in `tools`.
 *
 * @sideEffects none
 * @param context - The request's context.
 * @returns The names, in the order they were added.
 */
function declaredTools(context: {
  readonly messages: readonly unknown[];
  readonly tools?: readonly { readonly name: string }[];
}): string[] {
  const names: string[] = (context.tools ?? []).map((tool) => tool.name);
  for (const message of context.messages) {
    if (typeof message !== "object" || message === null || Reflect.get(message, "role") !== "system") continue;
    for (const [key, adding] of [
      ["toolsRemoved", false],
      ["toolsAdded", true],
    ] as const) {
      const listed: unknown = Reflect.get(message, key);
      for (const tool of Array.isArray(listed) ? listed : []) {
        const name: unknown = typeof tool === "object" && tool !== null ? Reflect.get(tool, "name") : undefined;
        if (typeof name !== "string") continue;
        const at = names.indexOf(name);
        if (at !== -1) names.splice(at, 1);
        if (adding) names.push(name);
      }
    }
  }
  return names;
}

/**
 * Turns a scripted reply into the assistant message faux streams.
 *
 * @remarks
 * Tool calls get `stopReason: "toolUse"` so pi runs them and asks for the next reply, as it does
 * with a real model.
 *
 * @sideEffects none
 * @param reply - The scripted reply.
 * @returns The assistant message.
 */
function toAssistantMessage(reply: FauxReply): AssistantMessage {
  const blocks = reply.blocks.map((block) => {
    if (block.type === "thinking") return fauxThinking(block.text);
    if (block.type === "text") return fauxText(block.text);
    return fauxToolCall(block.name, { ...block.arguments }, { id: block.id });
  });
  if (reply.error !== undefined)
    return fauxAssistantMessage(blocks, { stopReason: "error", errorMessage: reply.error });
  return fauxAssistantMessage(blocks, {
    stopReason: blocks.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  });
}

/**
 * What the model was told, all of it: the instructions and whatever pi added after them.
 *
 * @remarks
 * pi 1.0 sends its system prompt as a `system` message whose `sections` are its parts (the
 * instructions, the directory, the context files), not as `systemPrompt`; older pi sent the
 * text whole.
 *
 * @sideEffects none
 * @param context - The request's context.
 * @returns The text, the parts joined by blank lines; empty when there is none.
 */
function instructionsOf(context: { readonly systemPrompt?: string; readonly messages: readonly unknown[] }): string {
  const system: unknown = context.messages.find(
    (message) => typeof message === "object" && message !== null && "role" in message && message.role === "system",
  );
  if (typeof system !== "object" || system === null) return context.systemPrompt ?? "";
  const sections = "sections" in system && typeof system.sections === "object" ? system.sections : null;
  const parts = Object.values(sections ?? {}).filter((part): part is string => typeof part === "string");
  const content = "content" in system && typeof system.content === "string" ? system.content : "";
  return [content, ...parts].filter((part) => part !== "").join("\n\n");
}

/**
 * How deep a child the agent opened pi was started as, if it was one.
 *
 * @remarks
 * The host tells Atrium's extension so with `--atrium-agent=<base64url JSON>` (ADR-0013, point 3);
 * anything that does not read as `child: true` is no child.
 *
 * @sideEffects none
 * @param argv - pi's arguments.
 * @returns Its agent depth, or `null` for no child.
 */
function agentChildDepth(argv: readonly string[]): number | null {
  const flag = argv.find((arg) => arg.startsWith("--atrium-agent="));
  if (flag === undefined) return null;
  try {
    const self: unknown = JSON.parse(Buffer.from(flag.slice("--atrium-agent=".length), "base64url").toString("utf8"));
    if (typeof self !== "object" || self === null || Reflect.get(self, "child") !== true) return null;
    const depth: unknown = Reflect.get(self, "depth");
    return typeof depth === "number" ? depth : 1;
  } catch {
    return null;
  }
}

/**
 * How many replies the model gave in a conversation so far.
 *
 * @remarks
 * A child's pi may be stopped when idle and started again on the same conversation (SPEC-0002,
 * "进程"), so its replies are picked by the conversation, not by how many requests this process
 * has served.
 *
 * @sideEffects none
 * @param context - The request.
 * @returns The count.
 */
function repliesIn(context: { readonly messages?: readonly unknown[] }): number {
  return (context.messages ?? []).filter((message) => Reflect.get(Object(message), "role") === "assistant").length;
}

/**
 * pi extension that registers pi-ai's faux provider and answers from a script file.
 *
 * @remarks
 * pi loads this file itself (`--extension`) and resolves the pi-ai import to its own bundled copy;
 * our code never imports it, which is why it alone may import `@earendil-works/*` outside
 * `packages/pi` (overview.md, "包之间的依赖"). Chunk size, API name and tool call ids are fixed so
 * the same script produces the same output on every run apart from timestamps, which recorded
 * fixtures rely on (testing.md, "faux 模型").
 *
 * Replies scripted with `waitFor` hold until the test releases them; pi's process id goes into
 * `pi.pid` beside the gates, so a test can kill that very process. A pi in print mode (`-p`), as
 * the host's one-shot call for a title, answers the script's `title` instead, or its `branch` when
 * told to name a git branch, in those words (SPEC-0001, "AI 起分支名"), or an error without one; it adds what the model
 * was told to `prints.jsonl` beside the script, and leaves `pi.pid` to the session's pi (SPEC-0001,
 * "自动生成标题"). Each request's body, as
 * pi's extensions leave it, goes into `payloads.jsonl` beside the gates, and its tools and messages
 * into `contexts.jsonl`, and the models can stand in
 * for a real provider (`script.provider`), at a base address of the test's (`FAUX_PI_BASE_URL`), as
 * Fast's test needs (ADR-0008). Two commands cover the
 * `handled` prompt and the extension dialog round trip (testing.md, "pi 夹具"); a third navigates the
 * session tree, the only way to make a branch inside one session file.
 *
 * @sideEffects Reads the script file named by `FAUX_PI_SCRIPT`; writes `pi.pid` and adds to `payloads.jsonl`
 * and `contexts.jsonl`
 * unless printing, and adds to `prints.jsonl` when printing; registers a
 * provider and three commands with pi; optionally consumes one exact RPC input named by
 * `FAUX_PI_REFUSE_INPUT_ONCE_FILE`, renaming that isolated gate to `.handled`.
 * @param pi - pi's extension API.
 * @throws {Error} When the environment variable is missing.
 */
export default function fauxExtension(pi: ExtensionApi): void {
  const scriptPath = process.env[FAUX_SCRIPT_ENV];
  if (scriptPath === undefined) throw new Error(`${FAUX_SCRIPT_ENV} is not set`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fauxPi writes this file from a typed FauxScript.
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as FauxScript;
  const faux = fauxProvider({
    provider: script.provider ?? FAUX_PROVIDER,
    api: FAUX_API,
    models: [
      { id: FAUX_MODEL, reasoning: true },
      ...(script.models ?? []).map(({ id, name, reasoning, input }) => ({
        id,
        ...(name === undefined ? {} : { name }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(input === undefined ? {} : { input: [...input] }),
      })),
    ],
    tokenSize: { min: 2, max: 2 },
    ...(script.tokensPerSecond === undefined ? {} : { tokensPerSecond: script.tokensPerSecond }),
  });
  const gates = process.env[FAUX_GATES_ENV] ?? "";
  // A one-shot pi in print mode asks for a title; it must not pass for the session's pi.
  const printing = process.argv.includes("-p");
  const refuseInput = process.env["FAUX_PI_REFUSE_INPUT_ONCE_FILE"];
  if (!printing && refuseInput !== undefined) {
    // The isolated gate names the exact body to consume before pi appends a user entry.
    pi.on("input", (event) => {
      if (event.source !== "rpc" || !existsSync(refuseInput) || readFileSync(refuseInput, "utf8") !== event.text)
        return { action: "continue" };
      renameSync(refuseInput, `${refuseInput}.handled`);
      return { action: "handled" };
    });
  }
  if (gates !== "" && !printing) writeFileSync(join(dirname(gates), FAUX_PID_FILE), String(process.pid));
  const payloads = gates === "" || printing ? null : join(dirname(gates), FAUX_PAYLOADS_FILE);
  const contexts = gates === "" || printing ? null : join(dirname(gates), FAUX_CONTEXTS_FILE);
  const depth = agentChildDepth(process.argv);
  const childList =
    depth !== null && depth >= 2
      ? (script.grandchildReplies ?? script.childReplies ?? script.replies)
      : (script.childReplies ?? script.replies);
  /**
   * The faux model's answer with a scripted reply, recording what it was asked.
   *
   * @remarks
   * A gated reply waits for the test to release it.
   *
   * @sideEffects Writes the context and payload records; may wait for a gate.
   * @param reply - The reply.
   * @returns The answer.
   */
  const answerWith = (reply: FauxReply): FauxResponseFactory => {
    const message = toAssistantMessage(reply);
    const gate = reply.waitFor;
    return async (context, options, _state, model) => {
      if (contexts !== null) recordContext(contexts, context);
      if (payloads !== null) await recordPayload(payloads, model, options?.onPayload);
      if (gate !== undefined) await waitForGate(join(gates, gate), options?.signal);
      return message;
    };
  };
  const childAnswers = childList.map((reply) => answerWith(reply));
  const noMoreReplies = answerWith({ blocks: [], error: "faux script has no more child replies" });
  faux.setResponses(
    printing
      ? [
          (context) => {
            const told = instructionsOf(context);
            appendFileSync(join(dirname(scriptPath), FAUX_PRINTS_FILE), `${JSON.stringify({ systemPrompt: told })}\n`);
            const asked = told.includes("git branch") ? "branch" : "title";
            const answer = script[asked];
            return toAssistantMessage(
              answer === undefined
                ? { blocks: [], error: `faux script has no ${asked}` }
                : { blocks: [{ type: "text", text: answer }] },
            );
          },
        ]
      : depth === null
        ? script.replies.map((reply) => answerWith(reply))
        : // A child picks by the conversation; as many as it may ask for.
          childAnswers.map(() => (context, options, state, model) => {
            const answer = childAnswers[repliesIn(context)] ?? noMoreReplies;
            return answer(context, options, state, model);
          }),
  );
  // The faux provider takes no thinking map, so it is added to the models it made; each model
  // carries its own base address, so a test's goes on each.
  const baseUrl = process.env[FAUX_BASE_URL_ENV] ?? faux.getModel().baseUrl;
  const models = faux.models.map((model) => {
    const map = script.models?.find((extra) => extra.id === model.id)?.thinkingLevelMap;
    return { ...model, baseUrl, ...(map === undefined ? {} : { thinkingLevelMap: { ...map } }) };
  });
  pi.registerProvider(script.provider ?? FAUX_PROVIDER, {
    api: faux.api,
    baseUrl,
    apiKey: "faux-key",
    models,
    streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
  });
  // A command that consumes the input without a run, so `prompt` answers `handled`.
  pi.registerCommand("faux-noop", { description: "Does nothing", handler: () => Promise.resolve() });
  // A command that asks the client a question and reports the answer.
  // A command that moves to another point of the session tree, so the next prompt starts a branch.
  pi.registerCommand("faux-navigate", {
    description: "Navigates the session tree to the given entry",
    handler: async (args, ctx) => {
      await ctx.navigateTree(args.trim());
    },
  });
  pi.registerCommand("faux-confirm", {
    description: "Asks for confirmation",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Proceed?", "The faux extension asks.");
      ctx.ui.notify(confirmed ? "confirmed" : "declined", "info");
    },
  });
}
