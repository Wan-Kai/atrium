import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAUX_API,
  FAUX_GATES_ENV,
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
      readonly models: ReturnType<typeof fauxProvider>["models"];
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
 * pi extension that registers pi-ai's faux provider and answers from a script file.
 *
 * @remarks
 * pi loads this file itself (`--extension`) and resolves the pi-ai import to its own bundled copy;
 * our code never imports it, which is why it alone may import `@earendil-works/*` outside
 * `packages/pi` (overview.md, "包之间的依赖"). Chunk size, API name and tool call ids are fixed so
 * the same script produces the same output on every run apart from timestamps, which recorded
 * fixtures rely on (testing.md, "faux 模型").
 *
 * Replies scripted with `waitFor` hold until the test releases them, and two commands cover the
 * `handled` prompt and the extension dialog round trip (testing.md, "pi 夹具"); a third navigates the
 * session tree, the only way to make a branch inside one session file.
 *
 * @sideEffects Reads the script file named by `FAUX_PI_SCRIPT`; registers a provider and three
 * commands with pi.
 * @param pi - pi's extension API.
 * @throws {Error} When the environment variable is missing.
 */
export default function fauxExtension(pi: ExtensionApi): void {
  const scriptPath = process.env[FAUX_SCRIPT_ENV];
  if (scriptPath === undefined) throw new Error(`${FAUX_SCRIPT_ENV} is not set`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fauxPi writes this file from a typed FauxScript.
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as FauxScript;
  const faux = fauxProvider({
    provider: FAUX_PROVIDER,
    api: FAUX_API,
    models: [{ id: FAUX_MODEL, reasoning: true }],
    tokenSize: { min: 2, max: 2 },
    ...(script.tokensPerSecond === undefined ? {} : { tokensPerSecond: script.tokensPerSecond }),
  });
  const gates = process.env[FAUX_GATES_ENV] ?? "";
  faux.setResponses(
    script.replies.map((reply) => {
      const message = toAssistantMessage(reply);
      const gate = reply.waitFor;
      if (gate === undefined) return message;
      return async (_context, options) => {
        await waitForGate(join(gates, gate), options?.signal);
        return message;
      };
    }),
  );
  pi.registerProvider(FAUX_PROVIDER, {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: "faux-key",
    models: faux.models,
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
