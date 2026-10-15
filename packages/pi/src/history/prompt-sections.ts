/** One piece of a system prompt section Atrium splits: a memory file or a skill, by size. */
export interface SectionPiece {
  readonly name: string;
  readonly chars: number;
}

/** A memory file's block in the `project_context` section, as pi writes it. */
const MEMORY_FILE = /<project_instructions path="([^"]*)">[\s\S]*?<\/project_instructions>/gu;

/** A skill's block in the `skills` section, as pi writes it. */
const SKILL = /<skill>[\s\S]*?<\/skill>/gu;

/** A skill's name inside its block. */
const SKILL_NAME = /<name>([\s\S]*?)<\/name>/u;

/** The XML escapes pi writes in a skill's name, and what they stand for. */
const ESCAPES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&amp;": "&",
};

/**
 * Undoes the XML escapes pi writes in a skill's name.
 *
 * @remarks
 * pi escapes `&` first, so undoing every escape in one pass gives the name back.
 *
 * @sideEffects none
 * @param text - The escaped name.
 * @returns The name.
 */
function unescapeXml(text: string): string {
  return text.replaceAll(/&(?:lt|gt|quot|apos|amp);/gu, (escape) => ESCAPES[escape] ?? escape);
}

/**
 * Splits a system prompt section into the pieces the context card lists, or none.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): `project_context` holds a
 * `<project_instructions path="…">` block for each memory file, and `skills` a `<skill>` block
 * for each skill, its name in `<name>` (pi 1.1.0 `system-prompt.ts`, `skills.ts`;
 * pi-internals.md §2, "系统消息"). Each piece is its whole block; what lies outside the blocks
 * belongs to the section alone. Any other section is not split.
 *
 * @sideEffects none
 * @param section - The section's name.
 * @param text - The section's text.
 * @returns The pieces in order, or `null` for a section not split.
 */
export function sectionPieces(section: string, text: string): SectionPiece[] | null {
  if (section === "project_context") {
    // Stryker disable next-line StringLiteral: the pattern always captures the path.
    return [...text.matchAll(MEMORY_FILE)].map((block) => ({ name: block[1] ?? "", chars: block[0].length }));
  }
  if (section === "skills") {
    return [...text.matchAll(SKILL)].map((block) => ({
      name: unescapeXml(SKILL_NAME.exec(block[0])?.[1] ?? ""),
      chars: block[0].length,
    }));
  }
  return null;
}
