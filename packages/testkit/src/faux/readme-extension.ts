import {
  type AssistantMessage,
  type SimpleStreamOptions,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  README_FAUX_GATES_ENV,
  README_FAUX_LOG_ENV,
  README_FAUX_SCRIPT_ENV,
  type ReadmeFauxReply,
  type ReadmeFauxScript,
} from "./readme-script";
import type { FauxBlock } from "./script";

/** The faux provider handle pi-ai returns. */
type Faux = ReturnType<typeof fauxProvider>;

/** The part of pi's extension API this extension uses. */
interface ExtensionApi {
  registerProvider(
    name: string,
    config: {
      readonly api: string;
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly models: readonly Faux["models"][number][];
      readonly streamSimple: Faux["provider"]["streamSimple"];
    },
  ): void;
}

/** A request as the faux provider hands it to a reply: the messages and, from older pi, the instructions. */
interface Request {
  readonly systemPrompt?: string;
  readonly messages: readonly unknown[];
}

/** A JSON value, as tool call arguments are. */
type Json = Extract<FauxBlock, { type: "toolCall" }>["arguments"][string];

/**
 * Notes a line in the log file, when the run asked for one.
 *
 * @remarks
 * A screenshot run that hangs on a gate is otherwise silent; the log says which reply each pi was
 * on.
 *
 * @sideEffects Appends to the log file.
 * @param log - The log file, or empty for none.
 * @param line - What to note.
 */
function note(log: string, line: string): void {
  if (log !== "") appendFileSync(log, `${new Date().toISOString()} ${process.pid} ${line}\n`);
}

/**
 * Whether this pi was started as a child the agent opened.
 *
 * @remarks
 * The host tells Atrium's extension so with `--atrium-agent=<base64url JSON>` (ADR-0013, point 3);
 * a child answers from its own script.
 *
 * @sideEffects none
 * @param argv - pi's arguments.
 * @returns `true` for a child.
 */
function isChild(argv: readonly string[]): boolean {
  const flag = argv.find((arg) => arg.startsWith("--atrium-agent="));
  if (flag === undefined) return false;
  try {
    const self: unknown = JSON.parse(Buffer.from(flag.slice("--atrium-agent=".length), "base64url").toString("utf8"));
    return typeof self === "object" && self !== null && Reflect.get(self, "child") === true;
  } catch {
    return false;
  }
}

/**
 * The text of a message, its text blocks joined by newlines.
 *
 * @remarks
 * A child finds its script by a phrase in its task, and the main agent's answer finds the question
 * id in a child's question, both in message text.
 *
 * @sideEffects none
 * @param message - A message of the request.
 * @returns The text; empty when it has none.
 */
function textOf(message: unknown): string {
  const content: unknown =
    typeof message === "object" && message !== null ? Reflect.get(message, "content") : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      const text: unknown = typeof block === "object" && block !== null ? Reflect.get(block, "text") : undefined;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/**
 * The role of a message.
 *
 * @remarks
 * Messages arrive untyped across pi's versions.
 *
 * @sideEffects none
 * @param message - A message of the request.
 * @returns Its role, or `undefined`.
 */
function roleOf(message: unknown): unknown {
  return typeof message === "object" && message !== null ? Reflect.get(message, "role") : undefined;
}

/**
 * What the model was told: the system prompt and the parts of the system messages.
 *
 * @remarks
 * A one-shot pi in print mode is asked either for a title or for a branch name; the instructions
 * say which.
 *
 * @sideEffects none
 * @param request - The request.
 * @returns The text, the parts joined by newlines.
 */
function systemText(request: Request): string {
  const parts: string[] = [];
  if (typeof request.systemPrompt === "string") parts.push(request.systemPrompt);
  for (const message of request.messages) {
    if (typeof message !== "object" || message === null || roleOf(message) !== "system") continue;
    const content: unknown = Reflect.get(message, "content");
    if (typeof content === "string") parts.push(content);
    const sections: unknown = Reflect.get(message, "sections");
    for (const part of Object.values(typeof sections === "object" && sections !== null ? sections : {}))
      if (typeof part === "string") parts.push(part);
  }
  return parts.join("\n");
}

/**
 * Replaces `{{questionId}}` in a tool call's arguments with the id of the last question asked.
 *
 * @remarks
 * A child's question gets its id only when asked, so the scripted answer to it cannot know it in
 * advance; the id is in the message that tells the main agent about the question.
 *
 * @sideEffects none
 * @param value - An argument value.
 * @param request - The request.
 * @returns The value with the id in place.
 */
function fill(value: Json, request: Request): Json {
  if (typeof value === "string") {
    if (!value.includes("{{questionId}}")) return value;
    let id = "";
    for (const message of request.messages) {
      const found = /Question id: (\S+)/u.exec(textOf(message));
      if (found?.[1] !== undefined) id = found[1];
    }
    return value.replaceAll("{{questionId}}", id);
  }
  if (Array.isArray(value)) return value.map((item: Json) => fill(item, request));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, request)]));
  return value;
}

/**
 * Turns a scripted reply into the assistant message faux streams.
 *
 * @remarks
 * Tool calls get `stopReason: "toolUse"` so pi runs them and asks for the next reply.
 *
 * @sideEffects none
 * @param reply - The scripted reply.
 * @param request - The request, for the question id.
 * @returns The assistant message.
 */
function toMessage(reply: ReadmeFauxReply, request: Request): AssistantMessage {
  const blocks = reply.blocks.map((block) => {
    if (block.type === "thinking") return fauxThinking(block.text);
    if (block.type === "text") return fauxText(block.text);
    const args = Object.fromEntries(Object.entries(block.arguments).map(([key, item]) => [key, fill(item, request)]));
    return fauxToolCall(block.name, args, { id: block.id });
  });
  return fauxAssistantMessage(blocks, {
    stopReason: blocks.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  });
}

/**
 * Resolves once the gate file exists or the request is aborted.
 *
 * @remarks
 * The screenshot run releases replies at the moments the story needs them; an abort must end the
 * wait so the app can close.
 *
 * @sideEffects Checks the file system every 50 ms; notes the wait in the log.
 * @param gates - The gates directory.
 * @param name - The gate.
 * @param log - The log file, or empty.
 * @param signal - The request's abort signal.
 */
async function waitForGate(gates: string, name: string, log: string, signal: AbortSignal | undefined): Promise<void> {
  note(log, `waiting ${name}`);
  for (;;) {
    if (existsSync(join(gates, name)) || signal?.aborted === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * pi extension for the README screenshots: several faux providers named like real ones, answering
 * from one script.
 *
 * @remarks
 * Loaded by pi itself (`--extension`), which resolves the pi-ai import to its own copy, as the
 * test faux extension is (overview.md, "faux extension 的例外"). The screenshots show a real
 * session: a main agent and three children, Claude's and ChatGPT's plans with their usage, and
 * several providers in the model panel, none of which the test faux extension, one provider with
 * one list of child replies, can stand in for. The main pi answers the script's replies in order;
 * a child picks its list by a phrase of its task and its reply by how many it gave; a pi in print
 * mode answers the title, or the branch when told to name a git branch. Providers with `headers`
 * hand them to pi as the reply's headers, which is where the plan usage comes from.
 *
 * @sideEffects Reads the script file named by `README_FAUX_SCRIPT`; registers one provider per
 * script provider with pi; notes each reply in the log file when one is named.
 * @param pi - pi's extension API.
 * @throws {Error} When the environment variable is missing.
 */
export default function readmeFauxExtension(pi: ExtensionApi): void {
  const scriptPath = process.env[README_FAUX_SCRIPT_ENV];
  if (scriptPath === undefined) throw new Error(`${README_FAUX_SCRIPT_ENV} is not set`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the screenshot run writes this file from a typed ReadmeFauxScript.
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as ReadmeFauxScript;
  const gates = process.env[README_FAUX_GATES_ENV] ?? "";
  const log = process.env[README_FAUX_LOG_ENV] ?? "";
  const printing = process.argv.includes("-p");
  const child = isChild(process.argv);
  let mainIndex = 0;
  /**
   * The next answer of this pi, by its kind: print mode, a child, or the main agent.
   *
   * @remarks
   * Every provider shares it, so the main agent keeps its place when the model changes.
   *
   * @sideEffects Advances the main agent's place; notes the reply; may wait for a gate.
   * @param request - The request.
   * @param options - The request's options, for its abort signal.
   * @returns The answer.
   */
  const answer = async (request: Request, options: SimpleStreamOptions | undefined): Promise<AssistantMessage> => {
    if (printing) {
      const branch = systemText(request).includes("git branch");
      note(log, `print ${branch ? "branch" : "title"}`);
      return fauxAssistantMessage([fauxText((branch ? script.branch : script.title) ?? "演示")]);
    }
    let reply: ReadmeFauxReply | undefined;
    if (child) {
      const all = request.messages.map((message) => textOf(message)).join("\n");
      const own = script.children.find((one) => all.includes(one.match));
      const done = request.messages.filter((message) => roleOf(message) === "assistant").length;
      reply = own?.replies[done];
      note(log, `child ${own?.match ?? "?"} reply ${done}`);
    } else {
      reply = script.replies[mainIndex];
      note(log, `main reply ${mainIndex}`);
      mainIndex += 1;
    }
    if (reply === undefined) return fauxAssistantMessage([fauxText("好的。")]);
    if (reply.waitFor !== undefined) await waitForGate(gates, reply.waitFor, log, options?.signal);
    return toMessage(reply, request);
  };
  for (const def of script.providers) {
    const faux = fauxProvider({
      provider: def.id,
      api: `shots-faux-${def.id}`,
      models: def.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning ?? true,
        input: [...(model.input ?? ["text", "image"])],
        contextWindow: model.contextWindow ?? 200_000,
        maxTokens: model.maxTokens ?? 64_000,
      })),
      tokenSize: { min: 3, max: 6 },
      ...(script.tokensPerSecond === undefined ? {} : { tokensPerSecond: script.tokensPerSecond }),
    });
    faux.setResponses(Array.from({ length: 400 }, () => (request, options) => answer(request, options)));
    const baseUrl = def.baseUrl ?? "http://127.0.0.1:9/unused";
    const headers = def.headers;
    pi.registerProvider(def.id, {
      api: faux.api,
      baseUrl,
      apiKey: "faux-key",
      // The faux provider takes no thinking map, so it is added to the models it made.
      models: faux.models.map((model) => {
        const map = def.models.find((one) => one.id === model.id)?.thinkingLevelMap;
        return { ...model, baseUrl, ...(map === undefined ? {} : { thinkingLevelMap: { ...map } }) };
      }),
      streamSimple: (model, context, options) =>
        faux.provider.streamSimple(
          model,
          context,
          headers === undefined
            ? options
            : {
                ...options,
                onResponse: async (_response, requestModel) =>
                  options?.onResponse?.({ status: 200, headers: { ...headers } }, requestModel),
              },
        ),
    });
  }
}
