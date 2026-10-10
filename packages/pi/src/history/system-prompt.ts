import type { LogEntry, SystemParts } from "./log-entry";

/** The context's system prompt and tool definitions, in estimated tokens. */
export interface ContextShares {
  readonly system: number;
  readonly tools: number;
}

/**
 * Estimates how much of the context the system prompt and the tools take, along a branch.
 *
 * @remarks
 * SPEC-0001 ("状态栏（M1.8）"): replayed as pi-ai's `getCurrentSystemMessage` does, from the
 * latest compaction that stored the whole prompt, or from the start: instruction texts are joined
 * with a blank line, sections are replaced by name and removed when `null`, tools are taken away
 * and then added by name. Estimated as pi's `estimateTokens` does, a token for four characters
 * rounded up, the prompt's text and sections apart from the tools' declarations, which count as
 * their JSON array. Written here rather than imported: the host does not depend on pi's packages
 * at run time (overview.md).
 *
 * @sideEffects none
 * @param branch - The branch's entries, root first.
 * @returns The shares, or `null` when pi stated no system prompt on the branch.
 */
export function contextShares(branch: readonly LogEntry[]): ContextShares | null {
  const stored = branch.findLastIndex((entry) => entry.kind === "compaction" && entry.system !== null);
  const parts = branch.slice(Math.max(stored, 0)).flatMap((entry): SystemParts[] => {
    if (entry.kind === "system") return [entry.system];
    return entry.kind === "compaction" && entry.system !== null ? [entry.system] : [];
  });
  if (parts.length === 0) return null;
  const texts: number[] = [];
  const sections = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const part of parts) {
    if (part.textChars > 0) texts.push(part.textChars);
    for (const [name, chars] of Object.entries(part.sections)) {
      // Stryker disable next-line ConditionalExpression: a section kept as `null` adds nothing to the sum either.
      if (chars === null) sections.delete(name);
      else sections.set(name, chars);
    }
    for (const name of part.toolsRemoved) tools.delete(name);
    for (const [name, chars] of Object.entries(part.toolsAdded)) tools.set(name, chars);
  }
  const text = sum(texts) + 2 * Math.max(texts.length - 1, 0);
  // `[` and `]`, and a comma between declarations.
  const declarations = tools.size === 0 ? 0 : sum([...tools.values()]) + tools.size + 1;
  return { system: Math.ceil((text + sum([...sections.values()])) / 4), tools: Math.ceil(declarations / 4) };
}

/**
 * Adds numbers up.
 *
 * @remarks
 * See `contextShares`.
 *
 * @sideEffects none
 * @param values - The numbers.
 * @returns Their sum.
 */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
