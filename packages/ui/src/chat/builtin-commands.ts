import { type CatalogModel, type ModelRef, ThinkingLevel, type TranscriptItem } from "@atrium/protocol";
import type { ChosenCommand } from "./composer-text";
import { layoutTurn } from "./turn-layout";

/** The names of pi's built-in commands Atrium runs itself. */
type BuiltinName = "compact" | "model" | "thinking" | "copy" | "export";

/** A built-in command as the `/` list shows it, and when it can run. */
export interface BuiltinCommand {
  readonly source: "builtin";
  readonly name: BuiltinName;
  /** What its argument is, shown in brackets in the list; `null` when it takes none. */
  readonly hint: string | null;
  readonly description: string;
  /** Whether it can run while a run goes on, a stop waits for pi, or pi compacts. */
  readonly whileRunning: boolean;
  /** Whether it can run before the session's first message, while it has no file. */
  readonly inDraft: boolean;
}

/** The built-in commands, in the order the list shows them (SPEC-0001, "M1.11 的 `/` 命令"). */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { source: "builtin", name: "compact", hint: "要求", description: "压缩上下文", whileRunning: false, inDraft: false },
  { source: "builtin", name: "model", hint: "服务商/模型", description: "切换模型", whileRunning: true, inDraft: true },
  { source: "builtin", name: "thinking", hint: "档位", description: "推理强度", whileRunning: true, inDraft: true },
  { source: "builtin", name: "copy", hint: null, description: "复制最后一条回复", whileRunning: true, inDraft: true },
  { source: "builtin", name: "export", hint: null, description: "导出为 HTML", whileRunning: true, inDraft: false },
];

/** A built-in command to run, and what followed its name. */
export interface BuiltinCall {
  readonly command: BuiltinCommand;
  /** What followed the name, trimmed; empty when nothing did. */
  readonly args: string;
}

/**
 * The built-in command a message starts with, if it does.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令 · 执行"): a built-in's tag, or its `/name` typed out and followed by
 * a space or nothing. Another kind's tag is never a built-in, whatever is typed after it.
 *
 * @sideEffects none
 * @param text - The box's text.
 * @param command - The tag at its start, if any.
 * @returns The command and its argument, or `null`.
 */
export function builtinCall(text: string, command: ChosenCommand | null): BuiltinCall | null {
  if (command !== null && command.source !== "builtin") return null;
  const typed = /^\/(\S+)(\s[\s\S]*)?/.exec(text);
  const name = command === null ? typed?.[1] : command.name;
  const found = BUILTIN_COMMANDS.find((one) => one.name === name);
  if (found === undefined) return null;
  // Stryker disable next-line OptionalChaining: a built-in found by a typed name means the name matched.
  return { command: found, args: (command === null ? (typed?.[2] ?? "") : text).trim() };
}

/**
 * Why a built-in command cannot run now, if it cannot.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令"): the list greys it with this, and Enter says it above the box.
 *
 * @sideEffects none
 * @param command - The command.
 * @param state - Whether a run goes on or a stop waits for pi, and whether the session has no file yet.
 * @returns The reason, or `null` when it can run.
 */
export function builtinBlocked(
  command: Pick<BuiltinCommand, "whileRunning" | "inDraft">,
  state: { readonly busy: boolean; readonly draft: boolean },
): string | null {
  if (state.busy && !command.whileRunning) return "运行中不能用，先停止";
  if (state.draft && !command.inDraft) return "发出第一条消息后才能用";
  return null;
}

/**
 * The input box's placeholder while a tag is at its start.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令 · 标签"): a built-in's argument as optional, or "回车执行" when it
 * takes none; any other command takes words to go with it.
 *
 * @sideEffects none
 * @param command - The tag.
 * @returns The placeholder.
 */
export function tagPlaceholder(command: ChosenCommand): string {
  if (command.source !== "builtin") return "接着写要说的话（可选）";
  const hint = BUILTIN_COMMANDS.find((one) => one.name === command.name)?.hint ?? null;
  return hint === null ? "回车执行" : `${hint}（可选）`;
}

/**
 * The model `/model` names, from the container's list.
 *
 * @remarks
 * Written as `provider/model`, as pi's own `/model` takes it; the model's id may hold `/` itself.
 *
 * @sideEffects none
 * @param args - What followed `/model`.
 * @param models - The container's models.
 * @returns The model, or `null` when none is called that.
 */
export function namedModel(args: string, models: readonly CatalogModel[]): ModelRef | null {
  const found = models.find((model) => `${model.providerId}/${model.modelId}` === args);
  return found === undefined ? null : { providerId: found.providerId, modelId: found.modelId };
}

/**
 * The thinking level `/thinking` names, or why it cannot be set.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令 · 执行"): one of pi's levels that the model supports; when the
 * model's levels are unknown, pi decides.
 *
 * @sideEffects none
 * @param args - What followed `/thinking`.
 * @param levels - The model's levels; empty when unknown.
 * @returns The level, or the problem to show.
 */
export function namedLevel(
  args: string,
  levels: readonly ThinkingLevel[],
): { readonly level: ThinkingLevel } | { readonly problem: string } {
  const parsed = ThinkingLevel.safeParse(args);
  if (!parsed.success) return { problem: "没有这个档位" };
  if (levels.length > 0 && !levels.includes(parsed.data)) return { problem: "当前模型不支持这个档位" };
  return { level: parsed.data };
}

/**
 * The Markdown of the last reply, as its copy button copies it.
 *
 * @remarks
 * A turn still running has no copy button yet, so its reply is not the last one to copy.
 *
 * @sideEffects none
 * @param items - The transcript's items, oldest first.
 * @returns The reply, or `null` when there is none yet.
 */
export function lastReply(items: readonly TranscriptItem[]): string | null {
  for (const item of items.toReversed()) {
    if (item.kind !== "turn" || item.outcome === "running") continue;
    const reply = layoutTurn(item).reply;
    if (reply !== null) return reply.text;
  }
  return null;
}
