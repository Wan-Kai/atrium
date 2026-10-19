import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

/** The status key prefix the probe asks the host on: `atrium-probe:<request id>` (SPEC-0002, "乙"). */
export const PROBE_CHANNEL = "atrium-probe";
/** The hidden command the host answers with: `/probe-reply <request id> <base64url JSON>`. */
export const PROBE_REPLY = "probe-reply";
/** The hidden command that hands pi a custom message: `/probe-deliver <base64url JSON>`. */
export const PROBE_DELIVER = "probe-deliver";
/** The custom type of the messages the probe delivers. */
export const PROBE_MESSAGE = "atrium-probe";
/** Environment variable naming the directory the probe writes branches into. */
export const PROBE_BRANCH_DIR_ENV = "PROBE_BRANCH_DIR";
/** Environment variable listing, comma-separated, the tools the probe's `tool_call` hook blocks. */
export const PROBE_BLOCK_ENV = "PROBE_BLOCK_TOOLS";
/** What the model is told when the hook blocks a call. */
export const PROBE_BLOCK_REASON = "This sub-agent is read-only.";

/** What `/probe-deliver` carries: the message's text and how pi is to deliver it. */
export interface ProbeDelivery {
  readonly text: string;
  readonly triggerTurn: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
}

/**
 * Encodes a value the way the host passes JSON to a hidden command.
 *
 * @remarks
 * base64url, so the JSON's spaces and quotes survive as one argument (SPEC-0002, "宿主 → 扩展").
 *
 * @sideEffects none
 * @param value - The value.
 * @returns The argument.
 */
export function encodeArgument(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Decodes an argument {@link encodeArgument} made.
 *
 * @remarks
 * The probe trusts its input: only the contract tests send it.
 *
 * @sideEffects none
 * @param argument - The argument.
 * @returns The value.
 */
function decodeArgument(argument: string): unknown {
  return JSON.parse(Buffer.from(argument, "base64url").toString("utf8"));
}

/**
 * A test-only pi extension that tries out what SPEC-0002's Atrium extension will rely on.
 *
 * @remarks
 * SPEC-0002's contract tests run it in real pi before ADR-0012 settles the channel; it is not the
 * extension Atrium ships. `probe_ask` asks the host over the status line and waits for the hidden
 * reply command, as `ask_parent` and the agent tools will; `/probe-deliver` hands pi a custom
 * message, as a delivery will; `probe_branch` cuts the session at the current leaf into another
 * directory, as `agent_spawn` with context will; the `tool_call` hook blocks the tools named in
 * {@link PROBE_BLOCK_ENV}, as a forked read-only child's guard will.
 *
 * @sideEffects Registers two tools, two commands and a `tool_call` hook with pi; `probe_branch`
 * writes a session file.
 * @param pi - pi's extension API.
 */
export default function subagentProbe(pi: ExtensionAPI): void {
  const waiting = new Map<string, (answer: string) => void>();
  let asked = 0;
  pi.registerTool({
    name: "probe_ask",
    label: "Probe ask",
    description: "Asks the host a question and waits for its answer.",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = `q${String(++asked)}`;
      const answer = await new Promise<string>((resolve, reject) => {
        waiting.set(id, resolve);
        signal?.addEventListener(
          "abort",
          () => {
            waiting.delete(id);
            reject(new Error("aborted"));
          },
          { once: true },
        );
        ctx.ui.setStatus(`${PROBE_CHANNEL}:${id}`, JSON.stringify({ question: params.question }));
      });
      return { content: [{ type: "text", text: answer }], details: {} };
    },
  });
  pi.registerCommand(PROBE_REPLY, {
    description: "Answers a probe question (hidden; the host sends it)",
    handler: (args) => {
      const [id = "", argument = ""] = args.trim().split(" ");
      const answer = decodeArgument(argument);
      waiting.get(id)?.(typeof answer === "string" ? answer : JSON.stringify(answer));
      waiting.delete(id);
      return Promise.resolve();
    },
  });
  pi.registerCommand(PROBE_DELIVER, {
    description: "Hands pi a custom message (hidden; the host sends it)",
    handler: (args) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the contract tests send it, from a ProbeDelivery.
      const delivery = decodeArgument(args.trim()) as ProbeDelivery;
      pi.sendMessage(
        { customType: PROBE_MESSAGE, content: delivery.text, display: true },
        {
          triggerTurn: delivery.triggerTurn,
          ...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
        },
      );
      return Promise.resolve();
    },
  });
  pi.registerTool({
    name: "probe_branch",
    label: "Probe branch",
    description: "Cuts this session at its current leaf into a new file.",
    parameters: Type.Object({}),
    execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const file = ctx.sessionManager.getSessionFile();
      const leaf = ctx.sessionManager.getLeafId();
      const dir = process.env[PROBE_BRANCH_DIR_ENV];
      if (file === undefined || leaf === null || dir === undefined) throw new Error("nothing to branch");
      const branch = SessionManager.open(file, dir).createBranchedSession(leaf);
      // Only the path: entry ids never show in pi's events, so a fixture could not normalize one here.
      return Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ branch }) }], details: {} });
    },
  });
  const blocked = (process.env[PROBE_BLOCK_ENV] ?? "").split(",").filter((name) => name !== "");
  pi.on("tool_call", (event) =>
    blocked.includes(event.toolName) ? { block: true, reason: PROBE_BLOCK_REASON } : undefined,
  );
}
