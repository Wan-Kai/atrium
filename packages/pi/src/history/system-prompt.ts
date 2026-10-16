import type { ContextParts } from "@atrium/protocol";
import type { LogEntry, SystemParts } from "./log-entry";
import type { SectionPiece } from "./prompt-sections";

/** pi's own sections of the system prompt, which count as the system prompt (pi-internals.md §2). */
const SYSTEM_SECTIONS = new Set(["preamble", "tools", "rules", "docs", "addendum", "cwd"]);

/** pi's own tools, and those of its built-in extensions (pi-internals.md §2). */
const BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "codemode",
  "tool_search",
]);

/** An MCP tool's name, as pi's MCP extension makes it: `mcp__<server>__<tool>`. */
const MCP_TOOL = /^mcp__(.+?)__./u;

/** The section pi's MCP extension adds, describing its servers. */
const MCP_SECTION = "mcp_servers";

/** The section that holds the memory files. */
const MEMORY_SECTION = "project_context";

/** The section that lists the skills. */
const SKILLS_SECTION = "skills";

/**
 * Estimates tokens as pi's `estimateTokens` does: a token for four characters, rounded up.
 *
 * @remarks
 * See `contextParts`.
 *
 * @sideEffects none
 * @param chars - The characters.
 * @returns The tokens.
 */
function tokensOf(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Adds numbers up.
 *
 * @remarks
 * See `contextParts`.
 *
 * @sideEffects none
 * @param values - The numbers.
 * @returns Their sum.
 */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Orders named sizes from most to fewest tokens, then by name.
 *
 * @remarks
 * The order the card lists them in (SPEC-0001, "M1.13 的上下文细分与套餐用量").
 *
 * @sideEffects none
 * @param items - The items.
 * @returns A sorted copy.
 */
function byTokens<T extends { readonly name: string; readonly tokens: number }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

/**
 * Turns pieces into named token counts.
 *
 * @remarks
 * See `contextParts`.
 *
 * @sideEffects none
 * @param pieces - The pieces.
 * @returns Their names and tokens, most first.
 */
function named(pieces: readonly SectionPiece[]): { name: string; tokens: number }[] {
  return byTokens(pieces.map(({ name, chars }) => ({ name, tokens: tokensOf(chars) })));
}

/**
 * Splits the context by what fills it, along a branch.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): replayed as pi-ai's `getCurrentSystemMessage`
 * does, from the latest compaction that stored the whole prompt, or from the start: instruction
 * texts are joined with a blank line, sections are replaced by name and removed when `null`,
 * tools are taken away and then added by name. Sections and tools then go to their groups: pi's own
 * sections and the text to the system prompt, `project_context` to the memory files, `skills` to
 * the skills, pi's own tools to the built-in ones, `mcp__<server>__<tool>` tools and `mcp_servers`
 * to MCP, and everything else to the extensions. Estimated as pi's `estimateTokens` does, a token
 * for four characters rounded up; a tool is its declaration's JSON. Written here rather than
 * imported: the host does not depend on pi's packages at run time (overview.md).
 *
 * @sideEffects none
 * @param branch - The branch's entries, root first.
 * @returns The parts, or `null` when pi stated no system prompt on the branch.
 */
export function contextParts(branch: readonly LogEntry[]): ContextParts | null {
  const stored = branch.findLastIndex((entry) => entry.kind === "compaction" && entry.system !== null);
  const parts = branch.slice(Math.max(stored, 0)).flatMap((entry): SystemParts[] => {
    if (entry.kind === "system") return [entry.system];
    return entry.kind === "compaction" && entry.system !== null ? [entry.system] : [];
  });
  if (parts.length === 0) return null;
  const texts: number[] = [];
  const sections = new Map<string, number>();
  const pieces = new Map<string, readonly SectionPiece[]>();
  const tools = new Map<string, number>();
  for (const part of parts) {
    if (part.textChars > 0) texts.push(part.textChars);
    for (const [name, chars] of Object.entries(part.sections)) {
      pieces.delete(name);
      // Stryker disable next-line ConditionalExpression: a section kept as `null` adds nothing to the sum either.
      if (chars === null) sections.delete(name);
      else sections.set(name, chars);
    }
    for (const [name, split] of Object.entries(part.pieces)) pieces.set(name, split);
    for (const name of part.toolsRemoved) tools.delete(name);
    for (const [name, chars] of Object.entries(part.toolsAdded)) tools.set(name, chars);
  }
  /**
   * A section's characters, none when it is not in the prompt.
   *
   * @remarks
   * See `contextParts`.
   *
   * @sideEffects none
   * @param name - The section.
   * @returns Its characters.
   */
  const section = (name: string): number => sections.get(name) ?? 0;
  const text = sum(texts) + 2 * Math.max(texts.length - 1, 0);
  const builtin: SectionPiece[] = [];
  const mcp = new Map<string, SectionPiece[]>();
  const extensions: SectionPiece[] = [];
  for (const [name, chars] of tools) {
    const server = MCP_TOOL.exec(name)?.[1];
    if (BUILTIN_TOOLS.has(name)) builtin.push({ name, chars });
    else if (server === undefined) extensions.push({ name, chars });
    else mcp.set(server, [...(mcp.get(server) ?? []), { name, chars }]);
  }
  for (const [name, chars] of sections) {
    if (!SYSTEM_SECTIONS.has(name) && name !== MEMORY_SECTION && name !== SKILLS_SECTION && name !== MCP_SECTION) {
      extensions.push({ name, chars });
    }
  }
  const mcpChars = sum([...mcp.values()].flatMap((list) => list.map(({ chars }) => chars)));
  return {
    system: tokensOf(text + sum([...SYSTEM_SECTIONS].map(section))),
    memory: {
      tokens: tokensOf(section(MEMORY_SECTION)),
      files: named(pieces.get(MEMORY_SECTION) ?? []).map(({ name, tokens }) => ({ path: name, tokens })),
    },
    skills: { tokens: tokensOf(section(SKILLS_SECTION)), items: named(pieces.get(SKILLS_SECTION) ?? []) },
    builtin: { tokens: tokensOf(sum(builtin.map(({ chars }) => chars))), items: named(builtin) },
    mcp: {
      tokens: tokensOf(mcpChars + section(MCP_SECTION)),
      servers: byTokens(
        [...mcp].map(([name, list]) => ({
          name,
          tools: list.length,
          tokens: tokensOf(sum(list.map(({ chars }) => chars))),
        })),
      ),
    },
    extensions: { tokens: tokensOf(sum(extensions.map(({ chars }) => chars))), items: named(extensions) },
  };
}
