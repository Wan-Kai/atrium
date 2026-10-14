/**
 * How pi keeps a message that started with `/skill:<name>`: the skill's file in a block, then
 * what followed the name (pi-internals.md §1).
 *
 * @remarks
 * The same pattern pi reads its own blocks back with (`parseSkillBlock` in agent-session.js).
 */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Reads back the skill a user message started with.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令"): the transcript shows the skill as a tag and only what followed
 * its name, not the skill's file. What followed is trimmed, as pi trims it.
 *
 * @sideEffects none
 * @param text - The user message's text as pi keeps it.
 * @returns The skill's name and what followed it, or `null` for a message that is no skill block.
 */
export function readSkillBlock(text: string): { readonly name: string; readonly args: string } | null {
  const match = SKILL_BLOCK.exec(text);
  if (match === null) return null;
  return { name: match[1] ?? "", args: (match[4] ?? "").trim() };
}
