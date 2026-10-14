import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FAUX_API,
  FAUX_BASE_URL_ENV,
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
 * pi's extensions leave it, goes into `payloads.jsonl` beside the gates, and the models can stand in
 * for a real provider (`script.provider`), at a base address of the test's (`FAUX_PI_BASE_URL`), as
 * Fast's test needs (ADR-0008). Two commands cover the
 * `handled` prompt and the extension dialog round trip (testing.md, "pi 夹具"); a third navigates the
 * session tree, the only way to make a branch inside one session file.
 *
 * @sideEffects Reads the script file named by `FAUX_PI_SCRIPT`; writes `pi.pid` and adds to `payloads.jsonl`
 * unless printing, and adds to `prints.jsonl` when printing; registers a
 * provider and three commands with pi.
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
  if (gates !== "" && !printing) writeFileSync(join(dirname(gates), FAUX_PID_FILE), String(process.pid));
  const payloads = gates === "" || printing ? null : join(dirname(gates), FAUX_PAYLOADS_FILE);
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
      : script.replies.map((reply) => {
          const message = toAssistantMessage(reply);
          const gate = reply.waitFor;
          return async (_context, options, _state, model) => {
            if (payloads !== null) await recordPayload(payloads, model, options?.onPayload);
            if (gate !== undefined) await waitForGate(join(gates, gate), options?.signal);
            return message;
          };
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
