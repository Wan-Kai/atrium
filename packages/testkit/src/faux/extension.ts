import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { FAUX_API, FAUX_MODEL, FAUX_PROVIDER, FAUX_SCRIPT_ENV, type FauxReply, type FauxScript } from "./script";

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
 * @sideEffects Reads the script file named by `FAUX_PI_SCRIPT`; registers a provider with pi.
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
  faux.setResponses(script.replies.map(toAssistantMessage));
  pi.registerProvider(FAUX_PROVIDER, {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: "faux-key",
    models: faux.models,
    streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
  });
}
