import { AGENT_COMMAND, AGENT_MESSAGE, agentNote, decodeArgument, noteText } from "./agent";

/** The part of pi's extension API child conversations use; its test checks pi's `ExtensionAPI` fits it. */
export interface AgentApi {
  registerCommand(
    name: string,
    options: { readonly description: string; readonly handler: (args: string) => Promise<void> },
  ): void;
  sendMessage(
    message: {
      readonly customType: string;
      readonly content: string;
      readonly display: boolean;
      readonly details: unknown;
    },
    options?: { readonly triggerTurn?: boolean },
  ): void;
}

/**
 * Registers `/atrium-agent`, which the host hands child conversations' things to the model with.
 *
 * @remarks
 * Step one has one action, `note <base64url JSON>` (SPEC-0002, "对话记录里的自定义消息"): the
 * extension words the note and writes it into the session as an `atrium-agent` custom message,
 * without starting a run; idle, pi writes it at once. Step two adds `reply`, `deliver` and
 * `cancel` (ADR-0013). Anything it cannot read does nothing.
 *
 * @sideEffects Registers a command with pi; the command writes custom messages into the session.
 * @param pi - pi's extension API.
 */
export default function atriumAgent(pi: AgentApi): void {
  pi.registerCommand(AGENT_COMMAND, {
    description: "Atrium's child conversations, sent by Atrium's host",
    handler: (args) => {
      const [action, argument] = args.trim().split(/\s+/);
      if (action !== "note") return Promise.resolve();
      // A missing argument reads as nothing, as any word that is not base64url JSON does.
      const note = agentNote(decodeArgument(String(argument)));
      if (note === null) return Promise.resolve();
      pi.sendMessage(
        { customType: AGENT_MESSAGE, content: noteText(note), display: true, details: { v: 1, kind: "note", ...note } },
        { triggerTurn: false },
      );
      return Promise.resolve();
    },
  });
}
